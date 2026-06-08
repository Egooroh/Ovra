// Wires concrete implementations for a worker process.
// WebRtcCapture intercepts RTCPeerConnection tracks in the browser and
// delivers labeled PCM per participant — works in headless mode on all OS.

import { CallContext, WorkerEnv } from "../types";
import { WorkerDeps } from "./deps";
import { TelemostClient } from "./meeting/telemostClient";
import { WebRtcCapture } from "./audio/webRtcCapture";
import { SpeechKitTranscriber } from "./transcriber/speechKitTranscriber";
import { log } from "../util/log";

function deriveEnv(ctx: CallContext): WorkerEnv {
  const slot = process.env.WORKER_SLOT ?? String(process.pid % 1000);
  return {
    callId: ctx.callId,
    pulseSinkName: `bot_sink_${slot}`,
    display: process.env.DISPLAY ?? `:${99 + (Number(slot) % 10)}`,
  };
}

export async function buildDeps(ctx: CallContext): Promise<WorkerDeps> {
  const env = deriveEnv(ctx);
  log.info({ callId: ctx.callId, env, platform: process.platform }, "worker.buildDeps");

  const rtc = new WebRtcCapture();
  const pageHook = rtc.asPageHook();

  return {
    env,
    meeting: new TelemostClient(env, pageHook),
    audio: rtc,
    transcriber: new SpeechKitTranscriber(),
  };
}
