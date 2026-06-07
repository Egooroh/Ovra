// Captures audio from a named PulseAudio sink monitor via ffmpeg.
// Emits 16-bit signed little-endian PCM at 16 kHz, 1 channel.
// On non-Linux systems ffmpeg won't find the pulse source and exits immediately;
// the class becomes a no-op so the worker still runs in dev.

import { spawn, ChildProcess } from "child_process";
import type { AudioCapture } from "../deps";
import { config } from "../../util/config";
import { log } from "../../util/log";
import type { WorkerEnv } from "../../types";

// 100 ms of 16-bit mono PCM at the configured sample rate.
const FRAME_BYTES =
  Math.round(config.audio.sampleRate / 10) * 2 * config.audio.channels;

// RMS amplitude below this threshold (0–32 767 scale) counts as silence.
const SILENCE_THRESHOLD = 500;

export class FfmpegAudioCapture implements AudioCapture {
  private proc?: ChildProcess;
  private frameCallbacks: Array<(pcm: Buffer, speaker?: string) => void> = [];
  private silenceCallbacks: Array<(silent: boolean) => void> = [];
  private isSilent = false;
  private remainder = Buffer.alloc(0);

  constructor(private readonly env: WorkerEnv) {}

  async start(): Promise<void> {
    const { sampleRate, channels } = config.audio;
    // PulseAudio exposes a ".monitor" stream for each sink — this is what we read.
    const source = `${this.env.pulseSinkName}.monitor`;

    const args = [
      "-hide_banner", "-loglevel", "warning",
      "-f", "pulse", "-i", source,
      "-ac", String(channels),
      "-ar", String(sampleRate),
      "-f", "s16le",
      "-",
    ];

    log.info({ source, sampleRate, channels }, "audio.start");

    this.proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

    this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));

    this.proc.stderr!.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) log.debug({ msg }, "audio.ffmpeg_stderr");
    });

    this.proc.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        log.warn("audio.ffmpeg_not_found — audio capture disabled on this platform");
      } else {
        log.error({ err: String(err) }, "audio.ffmpeg_error");
      }
    });

    this.proc.on("exit", (code, signal) => {
      if (code !== 0 && signal !== "SIGTERM") {
        log.warn({ code, signal }, "audio.ffmpeg_unexpected_exit");
      } else {
        log.info({ code, signal }, "audio.ffmpeg_exit");
      }
    });
  }

  private onData(chunk: Buffer): void {
    this.remainder = Buffer.concat([this.remainder, chunk]);
    while (this.remainder.length >= FRAME_BYTES) {
      const frame = this.remainder.subarray(0, FRAME_BYTES);
      this.remainder = this.remainder.subarray(FRAME_BYTES);
      for (const cb of this.frameCallbacks) cb(frame);
      this.updateSilence(frame);
    }
  }

  private updateSilence(frame: Buffer): void {
    let sumSq = 0;
    const samples = frame.length / 2;
    for (let i = 0; i < frame.length; i += 2) {
      const s = frame.readInt16LE(i);
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / samples);
    const nowSilent = rms < SILENCE_THRESHOLD;
    if (nowSilent !== this.isSilent) {
      this.isSilent = nowSilent;
      for (const cb of this.silenceCallbacks) cb(nowSilent);
    }
  }

  onFrame(cb: (pcm: Buffer, speaker?: string) => void): void {
    this.frameCallbacks.push(cb);
  }

  onSilence(cb: (silent: boolean) => void): void {
    this.silenceCallbacks.push(cb);
  }

  async stop(): Promise<void> {
    this.proc?.kill("SIGTERM");
    this.proc = undefined;
    log.info("audio.stopped");
  }
}
