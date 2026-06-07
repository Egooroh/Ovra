// Worker process: handles exactly ONE call, start to finish.
// Forked by the orchestrator. Communicates only via process IPC + Postgres.
//
// Pipeline once started:
//   join (Playwright) -> capture audio (ffmpeg <- PulseAudio sink)
//   -> transcribe (SpeechKit gRPC) -> persist segments -> detect end -> leave
//   -> writeSummary (Claude саммари + задачи → ./output/{date}_{callId}.json)

import { prisma, disconnect } from "../db/prisma";
import { CallMachine } from "./callMachine";
import { WorkerDeps } from "./deps";
import { buildDeps } from "./buildDeps";
import { writeSummary } from "./summaryWriter";
import { config } from "../util/config";
import { log } from "../util/log";
import {
  CallContext,
  EndReason,
  ParentToWorker,
  WorkerToParent,
} from "../types";

function send(msg: WorkerToParent): void {
  process.send?.(msg);
}

class Worker {
  private machine!: CallMachine;
  private deps!: WorkerDeps;
  private ctx!: CallContext;
  private startedAt = 0;
  private timers: NodeJS.Timeout[] = [];
  private ending = false;

  async start(ctx: CallContext): Promise<void> {
    this.ctx = ctx;
    this.machine = new CallMachine(prisma, ctx.callId);
    this.startedAt = Date.now();

    try {
      this.deps = await buildDeps(ctx);
      await this.machine.transition("JOINING", {
        workerPid: process.pid,
        attempts: { increment: 1 },
      });
      send({ type: "status", callId: ctx.callId, status: "JOINING" });

      this.startHeartbeat();
      this.armSafetyTimers();

      // 1) Get into the room.
      await this.deps.meeting.join(ctx.joinUrl);
      await this.machine.transition("IN_CALL", { joinedAt: new Date() });
      send({ type: "joined", callId: ctx.callId });
      send({ type: "status", callId: ctx.callId, status: "IN_CALL" });

      // 2) Wire end-of-call detection (step 7).
      this.deps.meeting.onEnd((reason) => void this.finish(reason));

      // 3) Audio -> transcription -> persistence.
      this.deps.audio.onFrame((pcm, speaker) => this.deps.transcriber.push(pcm, speaker));
      this.deps.audio.onSilence((silent) => this.handleSilence(silent));
      this.deps.transcriber.onSegment((seg) => void this.persistSegment(seg));

      await this.deps.transcriber.start();
      await this.deps.audio.start();

      log.info({ callId: ctx.callId }, "worker.in_call");
    } catch (err) {
      await this.crash(err, /*fatal*/ true);
    }
  }

  private async persistSegment(seg: {
    startMs: number;
    endMs: number;
    text: string;
    isFinal: boolean;
    speaker?: string;
  }): Promise<void> {
    if (!seg.isFinal || !seg.text.trim()) return;
    try {
      await prisma.transcript.upsert({
        where: { callId: this.ctx.callId },
        create: {
          callId: this.ctx.callId,
          // fullText is built entirely by the raw append below so the first
          // segment isn't counted twice.
          fullText: "",
          segments: {
            create: { startMs: seg.startMs, endMs: seg.endMs, text: seg.text, speaker: seg.speaker },
          },
        },
        update: {
          // fullText is appended below via raw SQL; leave it untouched here.
          segments: {
            create: { startMs: seg.startMs, endMs: seg.endMs, text: seg.text, speaker: seg.speaker },
          },
        },
      });
      // Append with a separating space only when there's already text, so the
      // transcript has no leading space and no duplicated first segment.
      await prisma.$executeRaw`UPDATE "Transcript" SET "fullText" = CASE WHEN "fullText" = '' THEN ${seg.text} ELSE "fullText" || ' ' || ${seg.text} END, "updatedAt" = now() WHERE "callId" = ${this.ctx.callId}`;
      send({
        type: "segment",
        callId: this.ctx.callId,
        startMs: seg.startMs,
        endMs: seg.endMs,
        text: seg.text,
      });
    } catch (err) {
      log.warn({ callId: this.ctx.callId, err: String(err) }, "segment.persist_failed");
    }
  }

  private silenceSince: number | null = null;
  private handleSilence(silent: boolean): void {
    if (silent) {
      this.silenceSince ??= Date.now();
      if (Date.now() - this.silenceSince >= config.worker.silenceTimeoutMs) {
        void this.finish("silence_timeout");
      }
    } else {
      this.silenceSince = null;
    }
  }

  private startHeartbeat(): void {
    const t = setInterval(async () => {
      try {
        await this.machine.heartbeat();
        send({ type: "heartbeat", callId: this.ctx.callId, at: Date.now() });

        // External kill switch: if the call row was cancelled (meeting removed
        // from the calendar, or a manual stop during testing) leave the call
        // gracefully — click "leave" + close the browser — instead of being
        // force-killed and lingering as a ghost participant tile.
        const row = await prisma.call.findUnique({
          where: { id: this.ctx.callId },
          select: { status: true },
        });
        if (row?.status === "CANCELLED") {
          log.info({ callId: this.ctx.callId }, "worker.cancel_requested");
          void this.finish("manual");
        }
      } catch (err) {
        log.warn({ err: String(err) }, "heartbeat.failed");
      }
    }, config.worker.heartbeatIntervalMs);
    this.timers.push(t);
  }

  private armSafetyTimers(): void {
    const t = setTimeout(
      () => void this.finish("max_duration"),
      config.worker.maxCallDurationMs,
    );
    this.timers.push(t);
  }

  /** Clean end of a call. Idempotent. */
  private async finish(reason: EndReason): Promise<void> {
    if (this.ending) return;
    this.ending = true;
    log.info({ callId: this.ctx.callId, reason }, "worker.ending");

    // Physically leave the call FIRST and unconditionally — click "leave" then
    // close the browser. This must happen regardless of the DB state (e.g. a
    // CANCELLED row can't transition to ENDING) so the bot never lingers as a
    // ghost participant tile.
    await this.deps.audio.stop().catch(() => {});
    await this.deps.transcriber.stop().catch(() => {});
    await this.deps.meeting.leave().catch(() => {});
    await this.deps.meeting.dispose().catch(() => {});

    try {
      // Best-effort: a call already CANCELLED/DONE/FAILED stays as-is.
      const status = await this.machine.current().catch(() => null);
      const terminal = status === "CANCELLED" || status === "DONE" || status === "FAILED";

      if (!terminal) {
        await this.machine.transition("ENDING", { endedAt: new Date() });
        send({ type: "status", callId: this.ctx.callId, status: "ENDING" });
      }

      // Генерируем саммари и пишем ./output/{date}_{callId}.json
      // Go-разработчик забирает этот файл и создаёт задачи в YouGile.
      await writeSummary(
        prisma,
        this.ctx.callId,
        this.ctx.title ?? null,
        this.ctx.startsAt,
        new Date(),
      ).catch((err) =>
        log.warn({ callId: this.ctx.callId, err: String(err) }, "worker.summary_write_failed"),
      );

      if (!terminal) await this.machine.transition("DONE");
      send({ type: "ended", callId: this.ctx.callId, reason });
      send({ type: "status", callId: this.ctx.callId, status: "DONE" });
    } catch (err) {
      // The bot already left the call above; a DB error here is non-fatal.
      log.warn({ callId: this.ctx.callId, err: String(err) }, "worker.finish_db_error");
    } finally {
      this.cleanup();
    }
    await this.shutdown(0);
  }

  private async crash(err: unknown, fatal: boolean): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ callId: this.ctx?.callId, message, fatal }, "worker.crash");
    try {
      await this.deps?.audio.stop().catch(() => {});
      await this.deps?.transcriber.stop().catch(() => {});
      await this.deps?.meeting.dispose().catch(() => {});
      await this.machine?.fail(message);
    } finally {
      send({ type: "error", callId: this.ctx?.callId ?? "?", message, fatal });
      this.cleanup();
      await this.shutdown(1);
    }
  }

  private cleanup(): void {
    for (const t of this.timers) clearInterval(t as NodeJS.Timeout);
    this.timers = [];
  }

  async handleParentMessage(msg: ParentToWorker): Promise<void> {
    switch (msg.type) {
      case "start":
        await this.start(msg.context);
        break;
      case "leave":
        await this.finish("manual");
        break;
      case "shutdown":
        await this.finish("manual");
        break;
    }
  }

  private async shutdown(code: number): Promise<void> {
    await disconnect().catch(() => {});
    process.exit(code);
  }
}

// ---- bootstrap ----
const worker = new Worker();
process.on("message", (msg: ParentToWorker) => void worker.handleParentMessage(msg));
process.on("SIGTERM", () => void worker["finish"]("manual"));
process.on("uncaughtException", (e) => void worker["crash"](e, true));
process.on("unhandledRejection", (e) => void worker["crash"](e, true));
send({ type: "ready", callId: process.env.CALL_ID ?? "?" });
