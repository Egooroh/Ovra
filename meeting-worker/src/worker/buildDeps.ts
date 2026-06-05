// Wires concrete implementations for a worker. Today these are placeholder
// stubs so the skeleton runs end-to-end without crashing; each is replaced in
// its own step:
//   - meeting    -> step 4 (Playwright auto-join), step 9 (selector hardening)
//   - audio      -> steps 4/5 (PulseAudio sink + ffmpeg)
//   - transcriber-> step 6 (SpeechKit gRPC)
//
// It also allocates the per-call PulseAudio sink + Xvfb display so parallel
// calls (step 8) never share an audio device.

import { CallContext, WorkerEnv } from "../types";
import { WorkerDeps, MeetingClient, AudioCapture, Transcriber, Segment } from "./deps";
import { log } from "../util/log";

function deriveEnv(ctx: CallContext): WorkerEnv {
  // Unique per call so concurrent workers don't collide on audio/display.
  const slot = process.env.WORKER_SLOT ?? String(process.pid % 1000);
  return {
    callId: ctx.callId,
    pulseSinkName: `bot_sink_${slot}`,
    display: process.env.DISPLAY ?? `:${99 + (Number(slot) % 10)}`,
  };
}

class StubMeeting implements MeetingClient {
  async join(joinUrl: string): Promise<void> {
    log.warn({ joinUrl }, "stub.meeting.join — replace in step 4");
  }
  onEnd(_cb: (reason: never) => void): void {}
  async leave(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class StubAudio implements AudioCapture {
  async start(): Promise<void> {
    log.warn("stub.audio.start — replace in steps 4/5");
  }
  onFrame(_cb: (pcm: Buffer) => void): void {}
  onSilence(_cb: (silent: boolean) => void): void {}
  async stop(): Promise<void> {}
}

class StubTranscriber implements Transcriber {
  async start(): Promise<void> {
    log.warn("stub.transcriber.start — replace in step 6");
  }
  push(_pcm: Buffer): void {}
  onSegment(_cb: (seg: Segment) => void): void {}
  async stop(): Promise<void> {}
}

export async function buildDeps(ctx: CallContext): Promise<WorkerDeps> {
  const env = deriveEnv(ctx);
  log.info({ callId: ctx.callId, env }, "worker.buildDeps");
  return {
    env,
    meeting: new StubMeeting(),
    audio: new StubAudio(),
    transcriber: new StubTranscriber(),
  };
}
