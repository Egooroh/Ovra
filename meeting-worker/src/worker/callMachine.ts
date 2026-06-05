// Call state machine. Every transition is validated against CALL_TRANSITIONS
// and persisted, so Postgres is always the authoritative view of a call.

import { PrismaClient } from "@prisma/client";
import { CallStatus, canTransition } from "../types";
import { log } from "../util/log";

export class IllegalTransitionError extends Error {
  constructor(from: CallStatus, to: CallStatus) {
    super(`Illegal call transition ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export class CallMachine {
  constructor(
    private readonly prisma: PrismaClient,
    public readonly callId: string,
  ) {}

  async current(): Promise<CallStatus> {
    const row = await this.prisma.call.findUniqueOrThrow({
      where: { id: this.callId },
      select: { status: true },
    });
    return row.status as CallStatus;
  }

  /**
   * Atomically move to `to` only if the row is still in an expected state.
   * Uses a conditional updateMany to avoid lost-update races between the
   * orchestrator and a worker touching the same row.
   */
  async transition(
    to: CallStatus,
    patch: Record<string, unknown> = {},
  ): Promise<void> {
    const from = await this.current();
    if (from === to) return;
    if (!canTransition(from, to)) {
      throw new IllegalTransitionError(from, to);
    }

    const res = await this.prisma.call.updateMany({
      where: { id: this.callId, status: from },
      data: { status: to, ...patch },
    });

    if (res.count === 0) {
      // Someone changed the row underneath us; re-read and surface it.
      const now = await this.current();
      throw new Error(
        `Transition ${from}->${to} lost a race; row is now ${now}`,
      );
    }
    log.info({ callId: this.callId, from, to }, "call.transition");
  }

  async fail(message: string): Promise<void> {
    const from = await this.current();
    if (from === "DONE" || from === "FAILED" || from === "CANCELLED") return;
    await this.prisma.call.update({
      where: { id: this.callId },
      data: { status: "FAILED", lastError: message.slice(0, 2000) },
    });
    log.error({ callId: this.callId, from, message }, "call.failed");
  }

  async heartbeat(): Promise<void> {
    await this.prisma.call.update({
      where: { id: this.callId },
      data: { heartbeatAt: new Date() },
    });
  }
}
