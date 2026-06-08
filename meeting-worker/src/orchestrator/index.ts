// Orchestrator: the long-lived parent process. Lives next to the Telegram bot.
//
// Responsibilities:
//   - poll Postgres for calls that are due to be joined
//   - atomically CLAIM a call, then fork a worker for it
//   - cap concurrency (each worker = one Chromium, memory-bound)
//   - watch heartbeats; fence + recover calls whose worker died
//   - relaunch up to maxAttempts, else mark FAILED
//
// It owns NO meeting logic itself — that's entirely in the forked worker.

import { fork, ChildProcess } from "node:child_process";
import path from "node:path";
import { prisma, disconnect } from "../db/prisma";
import { config } from "../util/config";
import { log } from "../util/log";
import { CallContext, ParentToWorker, WorkerToParent } from "../types";
import { createApiServer } from "../api";

// In dev (ts-node) __filename ends with .ts; in prod it ends with .js.
const IS_DEV = __filename.endsWith(".ts");
const WORKER_ENTRY = IS_DEV
  ? path.resolve(__dirname, "../worker/index.ts")
  : path.resolve(__dirname, "../worker/index.js");

interface Slot {
  callId: string;
  /** Owning tenant, for the per-tenant fairness cap. Null in single-tenant mode. */
  organizationId: string | null;
  child: ChildProcess;
  lastHeartbeat: number;
}

export class Orchestrator {
  private slots = new Map<string, Slot>();
  private pollTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  private stopping = false;

  private processed = 0;
  private failed = 0;
  private statusTimer?: NodeJS.Timeout;
  private apiServer = createApiServer();

  async run(): Promise<void> {
    log.info("orchestrator.start");
    await this.recoverOrphans();
    this.pollTimer = setInterval(() => void this.tick(), config.orchestrator.pollIntervalMs);
    this.healthTimer = setInterval(() => void this.checkHealth(), config.orchestrator.heartbeatTimeoutMs / 2);
    // Emit a status snapshot every minute so silence in the logs means trouble.
    this.statusTimer = setInterval(() => this.logStatus(), 60_000);
    this.apiServer.listen(config.api.port, () => {
      log.info({ port: config.api.port }, "api.started");
    });
    await this.tick();
  }

  private logStatus(): void {
    log.info({
      active: this.slots.size,
      processed: this.processed,
      failed: this.failed,
      slots: [...this.slots.keys()],
    }, "orchestrator.status");
  }

  /** On startup, any row left mid-flight from a previous crash gets reset. */
  private async recoverOrphans(): Promise<void> {
    const res = await prisma.call.updateMany({
      where: { status: { in: ["CLAIMED", "JOINING", "IN_CALL", "ENDING"] } },
      data: { status: "SCHEDULED", workerPid: null, claimedAt: null, heartbeatAt: null },
    });
    if (res.count) log.warn({ count: res.count }, "orchestrator.recovered_orphans");
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    let free = config.orchestrator.maxConcurrentCalls - this.slots.size;
    if (free <= 0) return;

    // Current per-tenant occupancy from live slots, for the fairness cap.
    const perTenant = new Map<string, number>();
    for (const s of this.slots.values()) {
      if (s.organizationId === null) continue; // cap never applies to untagged
      perTenant.set(s.organizationId, (perTenant.get(s.organizationId) ?? 0) + 1);
    }
    const maxPerTenant = config.orchestrator.maxCallsPerTenant;

    // Over-fetch: with a per-tenant cap, one tenant with many due calls would
    // otherwise fill a `take: free` window and starve everyone else. Scan a
    // wider, bounded batch ordered by start time and pick fairly across tenants.
    const scanLimit = Math.max(config.orchestrator.maxConcurrentCalls * 20, 100);
    const dueBefore = new Date(Date.now() + config.orchestrator.joinLeadMs);
    const candidates = await prisma.call.findMany({
      where: { status: "SCHEDULED", startsAt: { lte: dueBefore } },
      orderBy: { startsAt: "asc" },
      take: scanLimit,
    });

    for (const c of candidates) {
      if (free <= 0) break;

      if (c.attempts >= config.orchestrator.maxAttempts) {
        await prisma.call.update({
          where: { id: c.id },
          data: { status: "FAILED", lastError: "max attempts exceeded" },
        });
        continue;
      }

      // Fairness: a tagged tenant already at its cap is skipped this tick so its
      // backlog can't monopolize slots. Untagged (single-tenant) calls bypass
      // the cap — only the global maxConcurrentCalls ceiling applies to them.
      const org = c.organizationId;
      if (org !== null && (perTenant.get(org) ?? 0) >= maxPerTenant) continue;

      const claimed = await this.claimAndFork({
        callId: c.id,
        sourceId: c.sourceId,
        organizationId: org,
        joinUrl: c.joinUrl,
        title: c.title,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
      });

      if (claimed) {
        free--;
        if (org !== null) perTenant.set(org, (perTenant.get(org) ?? 0) + 1);
      }
    }
  }

  /**
   * Atomic claim (CAS on status) prevents two ticks/instances double-forking.
   * Returns true if this orchestrator won the claim and forked a worker.
   */
  private async claimAndFork(ctx: CallContext): Promise<boolean> {
    const claimed = await prisma.call.updateMany({
      where: { id: ctx.callId, status: "SCHEDULED" },
      data: { status: "CLAIMED", claimedAt: new Date() },
    });
    if (claimed.count === 0) return false; // someone else got it

    const child = fork(WORKER_ENTRY, [], {
      execArgv: IS_DEV ? ["--require", "ts-node/register"] : [],
      env: { ...process.env, CALL_ID: ctx.callId, WORKER_SLOT: String(this.slots.size) },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });

    const slot: Slot = {
      callId: ctx.callId,
      organizationId: ctx.organizationId,
      child,
      lastHeartbeat: Date.now(),
    };
    this.slots.set(ctx.callId, slot);

    child.on("message", (m: WorkerToParent) => this.onWorkerMessage(slot, m));
    child.on("exit", (code) => this.onWorkerExit(slot, code));
    child.on("error", (err) => log.error({ callId: ctx.callId, err: String(err) }, "worker.proc_error"));

    const startMsg: ParentToWorker = { type: "start", context: ctx };
    child.send(startMsg);
    log.info({ callId: ctx.callId, org: ctx.organizationId, pid: child.pid }, "orchestrator.forked");
    return true;
  }

  private onWorkerMessage(slot: Slot, m: WorkerToParent): void {
    if (m.type === "heartbeat") slot.lastHeartbeat = m.at;
    if (m.type === "ended") {
      this.processed++;
      log.info({ callId: m.callId, reason: m.reason }, "orchestrator.call_ended");
    }
    if (m.type === "error" && m.fatal) {
      this.failed++;
      log.error({ callId: m.callId, msg: m.message }, "orchestrator.worker_fatal");
    }
  }

  private onWorkerExit(slot: Slot, code: number | null): void {
    this.slots.delete(slot.callId);
    log.info({ callId: slot.callId, code }, "orchestrator.worker_exit");
  }

  /** Kill + reschedule workers that stopped heart-beating (hung Chromium etc). */
  private async checkHealth(): Promise<void> {
    const now = Date.now();
    for (const slot of this.slots.values()) {
      if (now - slot.lastHeartbeat > config.orchestrator.heartbeatTimeoutMs) {
        log.warn({ callId: slot.callId, pid: slot.child.pid }, "orchestrator.heartbeat_timeout");
        slot.child.kill("SIGKILL");
        this.slots.delete(slot.callId);
        await prisma.call.updateMany({
          where: { id: slot.callId, status: { in: ["JOINING", "IN_CALL", "ENDING"] } },
          data: { status: "SCHEDULED", workerPid: null },
        });
      }
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    clearInterval(this.pollTimer);
    clearInterval(this.healthTimer);
    clearInterval(this.statusTimer);
    for (const slot of this.slots.values()) {
      const msg: ParentToWorker = { type: "shutdown" };
      slot.child.send(msg);
    }
    await new Promise((r) => setTimeout(r, 3000));
    for (const slot of this.slots.values()) slot.child.kill("SIGKILL");
    await new Promise<void>((r) => this.apiServer.close(() => r()));
    await disconnect();
    log.info("orchestrator.stopped");
  }
}

if (require.main === module) {
  const orch = new Orchestrator();
  process.on("SIGINT", () => void orch.shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void orch.shutdown().then(() => process.exit(0)));
  orch.run().catch((err) => {
    log.error({ err: String(err) }, "orchestrator.fatal");
    process.exit(1);
  });
}
