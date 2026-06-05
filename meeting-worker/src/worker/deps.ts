// Contracts for the sub-systems each worker drives. Implementations land in
// later steps; the worker only depends on these interfaces so the skeleton
// compiles and the integration points are explicit.

import { EndReason, WorkerEnv } from "../types";

/** Drives the headless browser into a Telemost room. (Playwright, step 4/9) */
export interface MeetingClient {
  /** Open the room and get the bot admitted. Resolves once truly in-call. */
  join(joinUrl: string): Promise<void>;
  /** Signals the call has ended (all left / kicked / host ended). */
  onEnd(cb: (reason: EndReason) => void): void;
  leave(): Promise<void>;
  dispose(): Promise<void>;
}

/** Captures audio from the PulseAudio sink and emits PCM frames. (ffmpeg, steps 4/5) */
export interface AudioCapture {
  /** Start ffmpeg reading the sink; frames are 16-bit PCM @ configured rate. */
  start(): Promise<void>;
  onFrame(cb: (pcm: Buffer) => void): void;
  /** Emits true while audio is silent past the configured threshold. */
  onSilence(cb: (silent: boolean) => void): void;
  stop(): Promise<void>;
}

export interface Segment {
  startMs: number;
  endMs: number;
  text: string;
  isFinal: boolean;
}

/** Streams PCM to Yandex SpeechKit over gRPC and emits segments. (step 6) */
export interface Transcriber {
  start(): Promise<void>;
  push(pcm: Buffer): void;
  onSegment(cb: (seg: Segment) => void): void;
  stop(): Promise<void>;
}

/** Factory wiring concrete implementations; lets the worker stay testable. */
export interface WorkerDeps {
  meeting: MeetingClient;
  audio: AudioCapture;
  transcriber: Transcriber;
  env: WorkerEnv;
}
