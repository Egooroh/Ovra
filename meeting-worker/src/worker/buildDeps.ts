// Wires concrete implementations for a worker process.
// On Linux:       FfmpegAudioCapture reads from PulseAudio sink (prod path).
// On Windows/Mac: WebRtcCapture intercepts RTCPeerConnection tracks in the
//                 browser and delivers labeled PCM per participant.

import { CallContext, WorkerEnv } from "../types";
import { WorkerDeps } from "./deps";
import { TelemostClient } from "./meeting/telemostClient";
import { FfmpegAudioCapture } from "./audio/ffmpegCapture";
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

  const isLinux = process.platform === "linux";

  let audio: FfmpegAudioCapture | WebRtcCapture;
  let pageHook: ((page: import("playwright").Page) => Promise<void>) | undefined;

  if (isLinux) {
    audio = new FfmpegAudioCapture(env);
  } else {
    const rtc = new WebRtcCapture();
    pageHook = rtc.asPageHook();
    audio = rtc;
  }

  return {
    env,
    meeting: new TelemostClient(env, pageHook),
    audio,
    transcriber: new SpeechKitTranscriber(),
  };
}
