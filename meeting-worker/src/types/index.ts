// Shared types used across orchestrator, worker, and the sub-modules.

export type CallStatus =
  | "SCHEDULED"
  | "CLAIMED"
  | "JOINING"
  | "IN_CALL"
  | "ENDING"
  | "DONE"
  | "FAILED"
  | "CANCELLED";

/** Allowed transitions. The worker/orchestrator must never jump outside this graph. */
export const CALL_TRANSITIONS: Record<CallStatus, CallStatus[]> = {
  SCHEDULED: ["CLAIMED", "CANCELLED"],
  CLAIMED: ["JOINING", "FAILED", "CANCELLED"],
  JOINING: ["IN_CALL", "FAILED", "ENDING"],
  IN_CALL: ["ENDING", "FAILED"],
  ENDING: ["DONE", "FAILED"],
  DONE: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: CallStatus, to: CallStatus): boolean {
  return CALL_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface CallContext {
  callId: string;
  sourceId: string;
  /** Owning tenant; null in single-tenant mode (worker falls back to env). */
  organizationId: string | null;
  joinUrl: string;
  title: string | null;
  startsAt: Date;
  endsAt: Date | null;
}

// ---- IPC contract: orchestrator (parent) <-> worker (forked child) ----

/** Messages a worker sends up to the orchestrator. */
export type WorkerToParent =
  | { type: "ready"; callId: string }
  | { type: "status"; callId: string; status: CallStatus }
  | { type: "heartbeat"; callId: string; at: number }
  | { type: "joined"; callId: string }
  | { type: "segment"; callId: string; startMs: number; endMs: number; text: string }
  | { type: "ended"; callId: string; reason: EndReason }
  | { type: "error"; callId: string; message: string; fatal: boolean };

/** Messages the orchestrator sends down to a worker. */
export type ParentToWorker =
  | { type: "start"; context: CallContext }
  | { type: "leave"; reason: "manual" | "cancelled" }
  | { type: "shutdown" };

export type EndReason =
  | "all_left" // everyone else dropped off
  | "kicked" // bot was removed
  | "host_ended" // host closed the room
  | "silence_timeout" // long silence threshold hit
  | "max_duration" // safety cap
  | "manual"; // orchestrator asked to leave

export interface WorkerEnv {
  callId: string;
  /** PulseAudio sink the worker's Chromium routes audio into. */
  pulseSinkName: string;
  /** Xvfb display number, e.g. ":99". */
  display: string;
}
