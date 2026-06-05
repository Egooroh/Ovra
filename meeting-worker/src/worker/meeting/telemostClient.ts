// Playwright-based Telemost client. Implements MeetingClient (deps.ts).
//
// Platform behaviour:
//   Windows/Mac (dev)  — headless Chromium, fake media stream, no display setup.
//   Linux (prod)       — headed Chromium on the Xvfb virtual display from WorkerEnv,
//                        real PulseAudio sink so ffmpeg can capture the audio.

import { chromium, Browser, BrowserContext, Page, Frame } from "playwright";
import type { MeetingClient } from "../deps";
import type { EndReason, WorkerEnv } from "../../types";
import { SELECTORS, CALL_ENDED_TEXTS } from "./selectors";
import { log } from "../../util/log";

const BOT_NAME = process.env.BOT_NAME ?? "Meeting Assistant";

// How long to wait for the lobby page to load and show the join button.
const LOBBY_TIMEOUT_MS = 30_000;
// How long to wait after clicking Join until we see in-call controls.
const JOIN_TIMEOUT_MS = 60_000;
// How often to scan the DOM for "call ended" text.
const END_POLL_INTERVAL_MS = 2_000;

export class TelemostClient implements MeetingClient {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private endCallbacks: Array<(reason: EndReason) => void> = [];
  private endPollTimer?: NodeJS.Timeout;
  private ended = false;

  constructor(private readonly env: WorkerEnv) {}

  async join(joinUrl: string): Promise<void> {
    log.info({ joinUrl, display: this.env.display }, "telemost.launching");

    this.browser = await this.launch();
    this.context = await this.buildContext();
    this.page = await this.context.newPage();

    this.page.on("pageerror", (err) =>
      log.warn({ err: String(err) }, "telemost.page_error"),
    );

    log.info({ joinUrl }, "telemost.navigating");
    await this.page.goto(joinUrl, { waitUntil: "networkidle", timeout: LOBBY_TIMEOUT_MS });

    // Telemost shows an interstitial "open in app or browser?" page first.
    await this.clickContinueInBrowser();

    await this.fillNameIfPrompted();
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
      // Auto-grant media permission dialogs without user interaction.
      "--use-fake-ui-for-media-stream",
    ];

    if (isLinux) {
      // On Linux prod: use real PulseAudio sink so ffmpeg can capture the audio.
      // Chromium will route its audio output to the sink named in env.
      args.push(
        `--alsa-output-device=pulse`,
        `--disable-audio-output`,          // don't play back — just route to sink
      );
    } else {
      // On Windows/Mac dev: no real audio device needed yet (StubAudio).
      args.push("--use-fake-device-for-media-stream");
    }

    return chromium.launch({
      // On Linux use headed mode on the Xvfb virtual display.
      // On Windows/Mac headless is fine for development.
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
      // Pre-grant camera and microphone so Chromium never shows a permission bar.
      permissions: ["microphone", "camera"],
      // Locale matching Telemost's interface language.
      locale: "ru-RU",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/120.0.0.0 Safari/537.36",
    });
  }

  // Click the interstitial "Продолжить в браузере" and wait for the lobby.
  private async clickContinueInBrowser(): Promise<void> {
    const btn = await this.waitForFirst(SELECTORS.continueInBrowser, LOBBY_TIMEOUT_MS);
    if (!btn) throw new Error("Telemost: 'Продолжить в браузере' button not found");
    await btn.click();
    // SPA: no new page load after click — wait for the join button to appear.
    const joinSel = SELECTORS.joinButton.join(", ");
    await this.page!.waitForSelector(joinSel, { timeout: LOBBY_TIMEOUT_MS });
    log.info("telemost.continue_in_browser_clicked");
  }

  // If the lobby shows a name input (guest flow) — fill it.
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
    // Wait for the lobby join button to disappear — it's present in lobby,
    // gone once we're inside the room.
    // String expression runs in browser context — document available there.
    await this.page!.waitForFunction(
      '!document.querySelector(\'[data-testid="enter-conference-button"]\')',
      { timeout: JOIN_TIMEOUT_MS, polling: 500 },
    );
    // Then confirm the in-call leave button appeared.
    const found = await this.waitForFirst(SELECTORS.inCallIndicator, 10_000);
    if (!found) throw new Error("Telemost: in-call indicator not found after lobby disappeared");
  }

  // ---------------------------------------------------------------------------
  // End-of-call detection: three independent strategies.
  // The first one to fire wins; subsequent fires are ignored (this.ended flag).

  private watchForEnd(): void {
    if (!this.page) return;

    // Strategy 1: Main frame navigates away from the /j/ path.
    // Telemost redirects to telemost.yandex.ru/ (or similar) when the host ends
    // the call or the participant is removed.
    this.page.on("framenavigated", (frame: Frame) => {
      if (frame !== this.page?.mainFrame()) return;
      const url = frame.url();
      if (!url.includes("/j/")) {
        log.info({ url }, "telemost.navigated_away");
        this.triggerEnd("host_ended");
      }
    });

    // Strategy 2: Poll the DOM for "call ended" overlay text.
    // Fires for: host_ended, kicked, all participants left.
    this.endPollTimer = setInterval(async () => {
      if (!this.page || this.ended) {
        clearInterval(this.endPollTimer);
        return;
      }
      try {
        // Runs in the browser — document is available there, not in Node.
        const bodyText: string = await this.page.evaluate("document.body.innerText");
        const matched = CALL_ENDED_TEXTS.find((t) => bodyText.includes(t));
        if (matched) {
          log.info({ matched }, "telemost.end_text_detected");
          clearInterval(this.endPollTimer);
          const reason: EndReason = bodyText.includes("удалили") ? "kicked" : "host_ended";
          this.triggerEnd(reason);
        }
      } catch {
        // Page is closing — stop the poll.
        clearInterval(this.endPollTimer);
      }
    }, END_POLL_INTERVAL_MS);

    // Strategy 3: Chromium tab crashes.
    this.page.on("crash", () => {
      log.warn("telemost.page_crash");
      clearInterval(this.endPollTimer);
      this.triggerEnd("host_ended");
    });
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
  // Selector helpers

  /** Try each selector in the list; return the first that exists in DOM. */
  private async findFirst(selectors: readonly string[]) {
    if (!this.page) return null;
    for (const sel of selectors) {
      try {
        const el = await this.page.$(sel);
        if (el) return el;
      } catch { /* invalid selector for current page state — try next */ }
    }
    return null;
  }

  /** Like findFirst but waits up to `timeoutMs` for any selector to appear. */
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
