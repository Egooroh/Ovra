import { EndReason, WorkerEnv } from "../types";

export interface MeetingClient {
  join(joinUrl: string): Promise<void>;
  onEnd(cb: (reason: EndReason) => void): void;
  leave(): Promise<void>;
  dispose(): Promise<void>;
}

export interface AudioCapture {
  start(): Promise<void>;
  /** speaker is the participant name resolved from the WebRTC DOM; undefined for mixed audio (Linux/ffmpeg). */
  onFrame(cb: (pcm: Buffer, speaker?: string) => void): void;
  onSilence(cb: (silent: boolean) => void): void;
  stop(): Promise<void>;
}

export interface Segment {
  startMs: number;
  endMs: number;
  text: string;
  isFinal: boolean;
  /** Participant display name resolved from WebRTC track → DOM tile. */
  speaker?: string;
}

export interface Transcriber {
  start(): Promise<void>;
  /** speaker routes PCM to a per-speaker gRPC session (created lazily). */
  push(pcm: Buffer, speaker?: string): void;
  onSegment(cb: (seg: Segment) => void): void;
  stop(): Promise<void>;
}

export interface WorkerDeps {
  meeting: MeetingClient;
  audio: AudioCapture;
  transcriber: Transcriber;
  env: WorkerEnv;
}
