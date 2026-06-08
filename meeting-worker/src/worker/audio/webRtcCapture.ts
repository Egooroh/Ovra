// Captures audio from a Telemost call and labels it per active speaker.
//
// Topology (verified by the SPEAKER_DIAG diagnostic on 2026-06-07):
//   Telemost is an MCU — it sends ONE mixed audio track carrying every remote
//   participant (a second, silent track is the bot's own loopback). So we
//   cannot separate speakers by track. Instead we:
//     1. Mix all remote tracks into a single stream (the silent one adds
//        nothing) and emit 100 ms PCM frames from it.
//     2. Poll the DOM for the active-speaker ring Telemost paints on the
//        speaking participant's tile (a class containing "rootStroke" on the
//        tile root). Whoever currently has it is the active speaker.
//     3. Tag every emitted frame with that speaker's name. Downstream the
//        transcriber opens one SpeechKit session per name, so each utterance
//        is transcribed under whoever was speaking when it was captured.
//
// Works on any OS — no PulseAudio or ffmpeg required.

import type { Page } from "playwright";
import type { AudioCapture } from "../deps";
import { config } from "../../util/config";
import { log } from "../../util/log";

const SILENCE_THRESHOLD = 500; // RMS on 0–32 767 scale
const BOT_NAME = process.env.BOT_NAME ?? "Meeting Assistant";
// Fallback label when nobody has the active-speaker ring yet (e.g. the very
// first words before Telemost paints the ring, or unlabelable cross-talk).
const FALLBACK_SPEAKER = "Участник";
const DIAG = process.env.SPEAKER_DIAG === "1";

// Builds the JS injected into Telemost before the page loads.
// Runs in the browser context — no Node.js globals available.
function buildCaptureScript(opts: {
  sampleRate: number;
  botName: string;
  fallbackSpeaker: string;
  diag: boolean;
}): string {
  return `
(function () {
  var SAMPLE_RATE = ${opts.sampleRate};
  var FRAME_SAMPLES = SAMPLE_RATE / 10; // 100 ms
  var BOT_NAME = ${JSON.stringify(opts.botName)};
  var FALLBACK_SPEAKER = ${JSON.stringify(opts.fallbackSpeaker)};
  var DIAG = ${opts.diag ? "true" : "false"};

  // ---- active-speaker tracking (DOM) --------------------------------------
  // Telemost adds a class containing "rootStroke" to the tile root of whoever
  // is currently speaking. The ring flickers every ~250 ms, so we debounce:
  // once a speaker is detected we latch their name and only clear it after
  // DEBOUNCE_MS of continuous absence — preventing mid-word attribution gaps.
  var DEBOUNCE_MS = 700;
  var currentSpeaker = null; // debounced active speaker (used for audio tagging)
  var lastSpeaker = null;    // last non-null, used as fallback before first ring
  var ringAbsentSince = null; // timestamp when ring last disappeared

  function pollActiveSpeaker() {
    var nameEls = document.querySelectorAll('[class*="TextName_"]');
    var speaking = null;
    for (var i = 0; i < nameEls.length; i++) {
      var name = (nameEls[i].textContent || '').trim();
      if (!name || name === BOT_NAME) continue;
      var el = nameEls[i];
      for (var d = 0; d < 8 && el && el !== document.body; d++) {
        var cls = (el.className && el.className.toString()) || '';
        if (cls.indexOf('rootStroke') !== -1) { speaking = name; break; }
        el = el.parentElement;
      }
      if (speaking) break;
    }

    if (speaking) {
      // Ring is present — latch immediately.
      ringAbsentSince = null;
      if (currentSpeaker !== speaking) {
        currentSpeaker = speaking;
        lastSpeaker = speaking;
        if (DIAG && window.__telemostDiag) {
          window.__telemostDiag({ kind: 'active_speaker', name: speaking });
        }
      }
    } else {
      // Ring absent — wait DEBOUNCE_MS before clearing.
      if (ringAbsentSince === null) ringAbsentSince = Date.now();
      if (Date.now() - ringAbsentSince >= DEBOUNCE_MS && currentSpeaker !== null) {
        currentSpeaker = null;
        if (DIAG && window.__telemostDiag) {
          window.__telemostDiag({ kind: 'active_speaker', name: '' });
        }
      }
    }
  }
  setInterval(pollActiveSpeaker, 150);

  // ---- single mixed-audio capture graph -----------------------------------
  var audioCtx = null, mixGain = null, processor = null, remainder = new Float32Array(0);

  function ensureGraph() {
    if (audioCtx) return;
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    audioCtx.resume().catch(function () {});
    mixGain = audioCtx.createGain();
    processor = audioCtx.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = function (e) {
      var input = e.inputBuffer.getChannelData(0);
      var combined = new Float32Array(remainder.length + input.length);
      combined.set(remainder);
      combined.set(input, remainder.length);

      var speaker = currentSpeaker || lastSpeaker || FALLBACK_SPEAKER;

      var offset = 0;
      while (offset + FRAME_SAMPLES <= combined.length) {
        var slice = combined.subarray(offset, offset + FRAME_SAMPLES);
        var int16 = new Int16Array(FRAME_SAMPLES);
        for (var i = 0; i < FRAME_SAMPLES; i++) {
          var s = slice[i] < -1 ? -1 : slice[i] > 1 ? 1 : slice[i];
          int16[i] = s < 0 ? s * 32768 : s * 32767;
        }
        var bytes = new Uint8Array(int16.buffer);
        var binary = '';
        for (var j = 0; j < bytes.length; j += 1024) {
          binary += String.fromCharCode.apply(
            null, bytes.subarray(j, Math.min(j + 1024, bytes.length))
          );
        }
        if (window.__telemostAudioChunk) {
          window.__telemostAudioChunk(btoa(binary), speaker);
        }
        offset += FRAME_SAMPLES;
      }
      var newRem = new Float32Array(combined.length - offset);
      newRem.set(combined.subarray(offset));
      remainder = newRem;
    };

    mixGain.connect(processor);
    processor.connect(audioCtx.destination);
  }

  function attachAudioTrack(track) {
    ensureGraph();
    var ms = new MediaStream([track]);
    var source = audioCtx.createMediaStreamSource(ms);
    source.connect(mixGain); // all remote tracks summed into one stream
    track.addEventListener('ended', function () {
      try { source.disconnect(); } catch (_) {}
    });
  }

  var OrigPC = window.RTCPeerConnection;
  function PatchedPC(cfg, constraints) {
    var pc = new OrigPC(cfg, constraints);
    pc.addEventListener('track', function (ev) {
      if (ev.track.kind !== 'audio') return;
      if (DIAG && window.__telemostDiag) {
        window.__telemostDiag({ kind: 'track_added', trackId: ev.track.id });
      }
      attachAudioTrack(ev.track);
    });
    return pc;
  }
  PatchedPC.prototype = OrigPC.prototype;
  try { Object.setPrototypeOf(PatchedPC, OrigPC); } catch (_) {}
  if (OrigPC.generateCertificate) {
    PatchedPC.generateCertificate = OrigPC.generateCertificate.bind(OrigPC);
  }
  window.RTCPeerConnection = PatchedPC;
})();
`;
}

export class WebRtcCapture implements AudioCapture {
  private frameCallbacks: Array<(pcm: Buffer, speaker?: string) => void> = [];
  private silenceCallbacks: Array<(silent: boolean) => void> = [];
  private silent = false;
  private firstChunkSeen = false;

  /** Returns a hook to be passed to TelemostClient so it can inject the script
   *  after page creation but before page.goto(). */
  asPageHook(): (page: Page) => Promise<void> {
    return async (page: Page) => {
      await page.exposeFunction(
        "__telemostAudioChunk",
        (base64pcm: string, speaker: string) => this.onChunk(base64pcm, speaker),
      );

      if (DIAG) {
        await page.exposeFunction("__telemostDiag", (ev: DiagEvent) => this.onDiag(ev));
        log.warn("webrtc.SPEAKER_DIAG_enabled");
      }

      const script = buildCaptureScript({
        sampleRate: config.audio.sampleRate,
        botName: BOT_NAME,
        fallbackSpeaker: FALLBACK_SPEAKER,
        diag: DIAG,
      });
      await page.addInitScript({ content: script });
      log.info("webrtc.capture_script_injected");
    };
  }

  async start(): Promise<void> {
    // Nothing to start — capture begins when the first track arrives in the browser.
    log.info("webrtc.capture_ready");
  }

  private lastDiagSpeaker = "";
  private onDiag(ev: DiagEvent): void {
    if (ev.kind === "track_added") {
      log.info({ trackId: ev.trackId }, "diag.track_added");
    } else if (ev.kind === "active_speaker" && ev.name !== this.lastDiagSpeaker) {
      this.lastDiagSpeaker = ev.name;
      log.info({ speaker: ev.name || "(none)" }, "diag.active_speaker");
    }
  }

  private onChunk(base64pcm: string, speaker: string): void {
    if (!this.firstChunkSeen) {
      this.firstChunkSeen = true;
      log.info("webrtc.first_chunk");
    }
    const pcm = Buffer.from(base64pcm, "base64");
    for (const cb of this.frameCallbacks) cb(pcm, speaker);
    this.updateSilence(pcm);
  }

  private updateSilence(pcm: Buffer): void {
    let sumSq = 0;
    const samples = pcm.length / 2;
    for (let i = 0; i < pcm.length; i += 2) {
      const s = pcm.readInt16LE(i);
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / samples);
    const nowSilent = rms < SILENCE_THRESHOLD;
    if (nowSilent !== this.silent) {
      this.silent = nowSilent;
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
    this.frameCallbacks = [];
    this.silenceCallbacks = [];
    log.info("webrtc.capture_stopped");
  }
}

// Shapes emitted by the injected diagnostic script (only when SPEAKER_DIAG=1).
type DiagEvent =
  | { kind: "track_added"; trackId: string }
  | { kind: "active_speaker"; name: string };
