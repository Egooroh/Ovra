// Wires concrete implementations for a worker process.
// On non-Linux / missing env vars the implementations degrade gracefully:
//   - FfmpegAudioCapture logs a warning if ffmpeg/PulseAudio isn't available.
//   - SpeechKitTranscriber is a no-op if YANDEX_API_KEY is not set.

import { CallContext, WorkerEnv } from "../types";
import { WorkerDeps } from "./deps";
import { TelemostClient } from "./meeting/telemostClient";
import { FfmpegAudioCapture } from "./audio/ffmpegCapture";
import { SpeechKitTranscriber } from "./transcriber/speechKitTranscriber";
import { log } from "../util/log";

function deriveEnv(ctx: CallContext): WorkerEnv {
  // Unique per call so concurrent workers don't collide on audio device / display.
  const slot = process.env.WORKER_SLOT ?? String(process.pid % 1000);
  return {
    callId: ctx.callId,
    pulseSinkName: `bot_sink_${slot}`,
    display: process.env.DISPLAY ?? `:${99 + (Number(slot) % 10)}`,
  };
}

export async function buildDeps(ctx: CallContext): Promise<WorkerDeps> {
  const env = deriveEnv(ctx);
  log.info({ callId: ctx.callId, env }, "worker.buildDeps");
  return {
    env,
    meeting: new TelemostClient(env),
    audio: new FfmpegAudioCapture(env),
    transcriber: new SpeechKitTranscriber(),
  };
}
