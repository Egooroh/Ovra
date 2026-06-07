// Playwright-based Telemost client. Implements MeetingClient (deps.ts).
//
// Platform behaviour:
//   Windows/Mac (dev)  — headless Chromium, fake media stream, no display setup.
//   Linux (prod)       — headed Chromium on the Xvfb virtual display from WorkerEnv,
//                        real PulseAudio sink so ffmpeg can capture the audio.

import { chromium, Browser, BrowserContext, Page, Frame } from "playwright";
type PageHook = (page: Page) => Promise<void>;
import type { MeetingClient } from "../deps";
import type { EndReason, WorkerEnv } from "../../types";
import { SELECTORS, CALL_ENDED_TEXTS } from "./selectors";
import { log } from "../../util/log";

const BOT_NAME = process.env.BOT_NAME ?? "Meeting Assistant";

const LOBBY_TIMEOUT_MS = 30_000;
const JOIN_TIMEOUT_MS = 60_000;
const END_POLL_INTERVAL_MS = 2_000;
// Leave automatically after this many ms alone in the call (no remote participants).
const ALONE_TIMEOUT_MS = Number(process.env.ALONE_TIMEOUT_MS ?? 20_000);
const ALONE_POLL_INTERVAL_MS = 5_000;

export class TelemostClient implements MeetingClient {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private endCallbacks: Array<(reason: EndReason) => void> = [];
  private endPollTimer?: NodeJS.Timeout;
  private alonePollTimer?: NodeJS.Timeout;
  private ended = false;

  constructor(
    private readonly env: WorkerEnv,
    private readonly pageHook?: PageHook,
  ) {}

  async join(joinUrl: string): Promise<void> {
    log.info({ joinUrl, display: this.env.display }, "telemost.launching");

    this.browser = await this.launch();
    this.context = await this.buildContext();
    this.page = await this.context.newPage();

    if (this.pageHook) {
      await this.pageHook(this.page);
    }

    this.page.on("pageerror", (err) =>
      log.warn({ err: String(err) }, "telemost.page_error"),
    );

    log.info({ joinUrl }, "telemost.navigating");
    await this.page.goto(joinUrl, { waitUntil: "networkidle", timeout: LOBBY_TIMEOUT_MS });

    await this.clickContinueInBrowser();
    await this.fillNameIfPrompted();
    await this.muteMicInLobby();
    await this.clickJoin();
    await this.waitUntilInCall();

    log.info({ joinUrl }, "telemost.in_call");
    this.watchForEnd();
  }

  onEnd(cb: (reason: EndReason) => void): void {
    this.endCallbacks.push(cb);
  }

  async leave(): Promise<void> {
    if (!this.page) return;
    const btn = await this.findFirst(SELECTORS.leaveButton);
    if (btn) {
      await btn.click({ timeout: 3_000 }).catch(() => {});
      log.info("telemost.leave_clicked");
    } else {
      log.warn("telemost.leave_button_not_found");
    }
  }

  async dispose(): Promise<void> {
    clearInterval(this.endPollTimer);
    clearInterval(this.alonePollTimer);
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
    log.info("telemost.disposed");
  }

  // ---------------------------------------------------------------------------

  private async launch(): Promise<Browser> {
    const isLinux = process.platform === "linux";

    const args = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--use-fake-ui-for-media-stream",
    ];

    if (isLinux) {
      args.push(
        `--alsa-output-device=pulse`,
        `--disable-audio-output`,
      );
    } else {
      args.push("--use-fake-device-for-media-stream");
    }

    return chromium.launch({
      headless: !isLinux,
      args,
      env: isLinux
        ? { ...process.env as Record<string, string>, DISPLAY: this.env.display }
        : undefined,
      timeout: LOBBY_TIMEOUT_MS,
    });
  }

  private async buildContext(): Promise<BrowserContext> {
    return this.browser!.newContext({
      permissions: ["microphone", "camera"],
      locale: "ru-RU",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/120.0.0.0 Safari/537.36",
    });
  }

  private async clickContinueInBrowser(): Promise<void> {
    const btn = await this.waitForFirst(SELECTORS.continueInBrowser, LOBBY_TIMEOUT_MS);
    if (!btn) throw new Error("Telemost: 'Продолжить в браузере' button not found");
    await btn.click();
    const joinSel = SELECTORS.joinButton.join(", ");
    await this.page!.waitForSelector(joinSel, { timeout: LOBBY_TIMEOUT_MS });
    log.info("telemost.continue_in_browser_clicked");
  }

  private async fillNameIfPrompted(): Promise<void> {
    const input = await this.findFirst(SELECTORS.nameInput);
    if (input) {
      await input.fill(BOT_NAME);
      log.info({ name: BOT_NAME }, "telemost.name_filled");
    }
  }

  private async clickJoin(): Promise<void> {
    const btn = await this.waitForFirst(SELECTORS.joinButton, LOBBY_TIMEOUT_MS);
    if (!btn) throw new Error("Telemost: join button not found within timeout");
    await btn.click();
    log.info("telemost.join_clicked");
  }

  private async waitUntilInCall(): Promise<void> {
    // Function form uses Runtime.callFunctionOn — not eval — safe under Telemost's CSP.
    await this.page!.waitForFunction(
      () => !document.querySelector('[data-testid="enter-conference-button"]'),
      undefined,
      { timeout: JOIN_TIMEOUT_MS, polling: 500 },
    );
    const found = await this.waitForFirst(SELECTORS.inCallIndicator, 10_000);
    if (!found) throw new Error("Telemost: in-call indicator not found after lobby disappeared");
  }

  // Mute the microphone in the lobby before clicking Join.
  // The lobby has a mic toggle left of the "Подключиться" button.
  private async muteMicInLobby(): Promise<void> {
    const btn = await this.findFirst(SELECTORS.lobbyMicToggle);
    if (btn) {
      await btn.click().catch(() => {});
      log.info("telemost.lobby_mic_muted");
    } else {
      log.warn("telemost.lobby_mic_button_not_found");
    }
  }

  // ---------------------------------------------------------------------------
  // End-of-call detection — four independent strategies, first one wins.

  private watchForEnd(): void {
    if (!this.page) return;

    // Strategy 1: main frame navigates away from /j/.
    this.page.on("framenavigated", (frame: Frame) => {
      if (frame !== this.page?.mainFrame()) return;
      const url = frame.url();
      if (!url.includes("/j/")) {
        log.info({ url }, "telemost.navigated_away");
        this.triggerEnd("host_ended");
      }
    });

    // Strategy 2: DOM text poll — "call ended" / "you were removed" overlays.
    this.endPollTimer = setInterval(async () => {
      if (!this.page || this.ended) { clearInterval(this.endPollTimer); return; }
      try {
        const bodyText: string = await this.page.evaluate(() => document.body.innerText);
        const matched = CALL_ENDED_TEXTS.find((t) => bodyText.includes(t));
        if (matched) {
          log.info({ matched }, "telemost.end_text_detected");
          clearInterval(this.endPollTimer);
          this.triggerEnd(bodyText.includes("удалили") ? "kicked" : "host_ended");
        }
      } catch { clearInterval(this.endPollTimer); }
    }, END_POLL_INTERVAL_MS);

    // Strategy 3: tab crash.
    this.page.on("crash", () => {
      log.warn("telemost.page_crash");
      clearInterval(this.endPollTimer);
      clearInterval(this.alonePollTimer);
      this.triggerEnd("host_ended");
    });

    // Strategy 4: bot is alone — participant count button stays at 1 for ALONE_TIMEOUT_MS.
    // Telemost shows "Участники<N>" in [data-testid="participants-button"].
    // Strip non-digits to get the count; <= 1 means only the bot is in the room.
    let aloneStart: number | null = null;
    this.alonePollTimer = setInterval(async () => {
      if (!this.page || this.ended) { clearInterval(this.alonePollTimer); return; }
      try {
        const btnText: string = await this.page.evaluate(
          () => document.querySelector('[data-testid="participants-button"]')?.textContent?.trim() ?? "",
        );
        const count = parseInt(btnText.replace(/\D/g, ""), 10) || 0;
        if (count <= 1) {
          aloneStart ??= Date.now();
          const aloneMs = Date.now() - aloneStart;
          log.debug({ count, aloneMs }, "telemost.alone_check");
          if (aloneMs >= ALONE_TIMEOUT_MS) {
            log.info({ aloneMs }, "telemost.alone_timeout");
            clearInterval(this.alonePollTimer);
            this.triggerEnd("all_left");
          }
        } else {
          if (aloneStart !== null) log.debug({ count }, "telemost.participants_back");
          aloneStart = null;
        }
      } catch { clearInterval(this.alonePollTimer); }
    }, ALONE_POLL_INTERVAL_MS);
  }

  private triggerEnd(reason: EndReason): void {
    if (this.ended) return;
    this.ended = true;
    log.info({ reason }, "telemost.end_triggered");
    for (const cb of this.endCallbacks) {
      try { cb(reason); } catch { /* don't let a bad callback break cleanup */ }
    }
    this.endCallbacks = [];
  }

  // ---------------------------------------------------------------------------

  private async findFirst(selectors: readonly string[]) {
    if (!this.page) return null;
    for (const sel of selectors) {
      try {
        const el = await this.page.$(sel);
        if (el) return el;
      } catch { /* try next */ }
    }
    return null;
  }

  private async waitForFirst(selectors: readonly string[], timeoutMs: number) {
    if (!this.page) return null;
    const combined = selectors.join(", ");
    try {
      return await this.page.waitForSelector(combined, { timeout: timeoutMs });
    } catch {
      return null;
    }
  }
}
