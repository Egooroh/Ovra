// Captures per-participant audio from a Telemost call by intercepting WebRTC
// at the browser level via Playwright's addInitScript.
//
// Each remote RTCPeerConnection audio track = one participant stream.
// Speaker names are resolved by matching the track's MediaStream to the video
// element in the Telemost participant tile, then reading the name label.
//
// Works on any OS — no PulseAudio or ffmpeg required.

import type { Page } from "playwright";
import type { AudioCapture } from "../deps";
import { config } from "../../util/config";
import { log } from "../../util/log";

const SILENCE_THRESHOLD = 500; // RMS on 0–32 767 scale

// JavaScript injected into Telemost before the page loads.
// Runs in the browser context — no Node.js globals available.
const CAPTURE_SCRIPT = `
(function () {
  var SAMPLE_RATE = ${/* replaced at runtime */ 16000};
  var FRAME_SAMPLES = SAMPLE_RATE / 10; // 100 ms

  var audioCtx = null;
  var trackSeq = 0;
  // Names already claimed by earlier tracks so each track gets a unique name.
  var claimedNames = [];

  function ensureCtx() {
    if (!audioCtx) {
      audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioCtx.resume().catch(function () {});
    }
    return audioCtx;
  }

  // Returns participant names from Telemost tile DOM, excluding known bot names.
  // Telemost renders each tile with a <span class="TextName_<hash>"> label.
  // We deduplicate and skip "Meeting Assistant" / "Гость" (bot fallback names).
  function getRemoteNames() {
    var nameEls = document.querySelectorAll('[class*="TextName_"]');
    var seen = {};
    var names = [];
    for (var i = 0; i < nameEls.length; i++) {
      var txt = (nameEls[i].textContent || '').trim();
      if (!txt || txt.length > 80) continue;
      if (txt === 'Meeting Assistant' || txt === 'Гость') continue;
      if (seen[txt]) continue;
      seen[txt] = true;
      names.push(txt);
    }
    return names;
  }

  function attachAudioTrack(track, seq) {
    var ctx = ensureCtx();
    var ms = new MediaStream([track]);
    var source = ctx.createMediaStreamSource(ms);
    var processor = ctx.createScriptProcessor(4096, 1, 1);

    var speakerName = 'Speaker_' + seq;
    var remainder = new Float32Array(0);

    // Try to find the N-th remote participant name (seq is 1-based).
    // Telemost renders tiles asynchronously, so retry up to 5 times.
    function tryResolveName(left) {
      var names = getRemoteNames();
      // Filter names already taken by earlier tracks
      var available = names.filter(function(n) {
        for (var i = 0; i < claimedNames.length; i++) {
          if (claimedNames[i] === n && claimedNames.indexOf(n) !== seq - 1) return false;
        }
        return true;
      });
      var name = names[seq - 1];
      if (name) {
        speakerName = name;
        claimedNames[seq - 1] = name;
        if (window.__telemostSpeakerResolved) {
          window.__telemostSpeakerResolved(track.id, name);
        }
        return;
      }
      if (left > 0) setTimeout(function () { tryResolveName(left - 1); }, 2000);
    }
    setTimeout(function () { tryResolveName(5); }, 500);

    processor.onaudioprocess = function (e) {
      var input = e.inputBuffer.getChannelData(0);
      var combined = new Float32Array(remainder.length + input.length);
      combined.set(remainder);
      combined.set(input, remainder.length);

      var offset = 0;
      while (offset + FRAME_SAMPLES <= combined.length) {
        var slice = combined.subarray(offset, offset + FRAME_SAMPLES);
        var int16 = new Int16Array(FRAME_SAMPLES);
        for (var i = 0; i < FRAME_SAMPLES; i++) {
          var s = slice[i] < -1 ? -1 : slice[i] > 1 ? 1 : slice[i];
          int16[i] = s < 0 ? s * 32768 : s * 32767;
        }
        // btoa in chunks to avoid call-stack overflow on large buffers
        var bytes = new Uint8Array(int16.buffer);
        var binary = '';
        for (var j = 0; j < bytes.length; j += 1024) {
          binary += String.fromCharCode.apply(
            null,
            bytes.subarray(j, Math.min(j + 1024, bytes.length))
          );
        }
        if (window.__telemostAudioChunk) {
          window.__telemostAudioChunk(btoa(binary), speakerName);
        }
        offset += FRAME_SAMPLES;
      }
      var newRem = new Float32Array(combined.length - offset);
      newRem.set(combined.subarray(offset));
      remainder = newRem;
    };

    source.connect(processor);
    processor.connect(ctx.destination);

    track.addEventListener('ended', function () {
      try { source.disconnect(); } catch (_) {}
      try { processor.disconnect(); } catch (_) {}
    });
  }

  var OrigPC = window.RTCPeerConnection;

  function PatchedPC(cfg, constraints) {
    var pc = new OrigPC(cfg, constraints);
    pc.addEventListener('track', function (ev) {
      if (ev.track.kind !== 'audio') return;
      trackSeq++;
      attachAudioTrack(ev.track, trackSeq);
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

export class WebRtcCapture implements AudioCapture {
  private frameCallbacks: Array<(pcm: Buffer, speaker?: string) => void> = [];
  private silenceCallbacks: Array<(silent: boolean) => void> = [];
  private silentBySpeaker = new Map<string, boolean>();
  private firstChunkBySpeaker = new Set<string>();

  /** Returns a hook to be passed to TelemostClient so it can inject the script
   *  after page creation but before page.goto(). */
  asPageHook(): (page: Page) => Promise<void> {
    return async (page: Page) => {
      // Expose callbacks that the injected script calls back into Node.js.
      await page.exposeFunction(
        "__telemostAudioChunk",
        (base64pcm: string, speaker: string) => this.onChunk(base64pcm, speaker),
      );
      await page.exposeFunction(
        "__telemostSpeakerResolved",
        (trackId: string, name: string) =>
          log.info({ trackId, name }, "webrtc.speaker_resolved"),
      );
      await page.addInitScript({ content: CAPTURE_SCRIPT });
      page.on("console", (msg) => {
        const text = msg.text();
        if (text.startsWith("[webrtc]")) log.info({ browser: text }, "browser.console");
      });
      log.info("webrtc.capture_script_injected");
    };
  }

  async start(): Promise<void> {
    // Nothing to start — capture begins when the first track arrives in the browser.
    log.info("webrtc.capture_ready");
  }

  private onChunk(base64pcm: string, speaker: string): void {
    if (!this.firstChunkBySpeaker.has(speaker)) {
      this.firstChunkBySpeaker.add(speaker);
      log.info({ speaker }, "webrtc.first_chunk");
    }
    const pcm = Buffer.from(base64pcm, "base64");
    for (const cb of this.frameCallbacks) cb(pcm, speaker);
    this.updateSilence(pcm, speaker);
  }

  private updateSilence(pcm: Buffer, speaker: string): void {
    let sumSq = 0;
    const samples = pcm.length / 2;
    for (let i = 0; i < pcm.length; i += 2) {
      const s = pcm.readInt16LE(i);
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / samples);
    const nowSilent = rms < SILENCE_THRESHOLD;
    const wasSilent = this.silentBySpeaker.get(speaker) ?? false;
    if (nowSilent !== wasSilent) {
      this.silentBySpeaker.set(speaker, nowSilent);
      // Emit silence only when ALL known speakers are silent.
      const allSilent = [...this.silentBySpeaker.values()].every(Boolean);
      for (const cb of this.silenceCallbacks) cb(allSilent);
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
