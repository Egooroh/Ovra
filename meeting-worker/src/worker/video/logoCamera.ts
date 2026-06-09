// Injects an animated OVRA logo as the bot's camera feed.
// Patches navigator.mediaDevices.getUserMedia and RTCPeerConnection.prototype.addTrack
// before page scripts load so Telemost receives a canvas-based video track.

import type { Page } from "playwright";

export function buildLogoCameraHook(): (page: Page) => Promise<void> {
  return async (page: Page) => {
    await page.addInitScript({ content: LOGO_CAMERA_SCRIPT });
  };
}

// Executed inside headless Chromium — no Node.js globals.
const LOGO_CAMERA_SCRIPT = `
(function () {
  var BG = '#3450CD';
  var W = 640, H = 480, FPS = 30;
  var startTime = Date.now();

  // Full OVRA wordmark (SVG viewBox 303×72) scaled to fit the upper canvas area.
  var SCALE = 1.5;
  var OX = ((W - 303 * SCALE) / 2) | 0;  // ≈ 92 — centres logo horizontally
  var OY = 128;

  // Iris/pupil in SVG units (from the source logo paths).
  var ICX = 53, ICY = 36, IRIS_R = 20, PUPIL_R = 8;

  // ── Pupil animation ──────────────────────────────────────────────────────
  var px = 5, py = -5;
  var fromPx = 5, toPx = 5;
  var inAnim = false, animStart = 0;
  var SACCADE_MS = 200;
  var phase = 'idle';
  var nextActionAt = Date.now() + 4000 + Math.random() * 8000;

  function ease(t) { return t < 0.5 ? 2*t*t : -1 + (4 - 2*t) * t; }

  function updatePupil() {
    var now = Date.now();
    if (inAnim) {
      var raw = Math.min(1, (now - animStart) / SACCADE_MS);
      px = fromPx + (toPx - fromPx) * ease(raw);
      if (raw >= 1) {
        px = toPx; inAnim = false;
        if (phase === 'glancing') {
          phase = 'returning';
          nextActionAt = now + 500 + Math.random() * 700;
        } else {
          phase = 'idle';
          nextActionAt = now + 4000 + Math.random() * 8000;
        }
      }
    } else if (now >= nextActionAt) {
      inAnim = true; animStart = now; fromPx = px;
      if (phase === 'idle') {
        phase = 'glancing';
        toPx = Math.random() < 0.5 ? -7 : 8;
      } else { toPx = 5; }
    }
  }

  // ── Timer ────────────────────────────────────────────────────────────────
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function formatTime(ms) {
    var s = Math.floor(ms / 1000);
    return pad2(Math.floor(s / 60)) + ':' + pad2(s % 60);
  }

  // ── Drawing ──────────────────────────────────────────────────────────────
  function drawFrame(ctx) {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    // ── OVRA logo (all paths share the same transform) ────────────────────
    ctx.save();
    ctx.translate(OX, OY);
    ctx.scale(SCALE, SCALE);
    ctx.fillStyle = 'white';

    // Top lens arc
    ctx.beginPath();
    ctx.moveTo(52.8828, 0);
    ctx.bezierCurveTo(72.3086, 0,       89.0412, 11.4253, 100.866, 28.2344);
    ctx.bezierCurveTo(99.4865, 30.9473, 98.0087, 33.5399, 96.4404, 36);
    ctx.bezierCurveTo(85.4363, 18.7382, 69.9892, 8,       52.8828, 8);
    ctx.bezierCurveTo(35.7763, 8,       20.3284, 18.738,  9.32422, 36);
    ctx.bezierCurveTo(7.75596, 33.5399, 6.2781,  30.9473, 4.89844, 28.2344);
    ctx.bezierCurveTo(16.7234, 11.4251, 33.4569, 0,       52.8828, 0);
    ctx.closePath();
    ctx.fill();

    // Bottom lens arc
    ctx.beginPath();
    ctx.moveTo(96.4404, 36);
    ctx.bezierCurveTo(98.0086, 38.4599, 99.4866, 41.052,  100.866, 43.7646);
    ctx.bezierCurveTo(89.0412, 60.5741, 72.3088, 72,      52.8828, 72);
    ctx.bezierCurveTo(33.4566, 72,      16.7234, 60.5743, 4.89844, 43.7646);
    ctx.bezierCurveTo(6.27799, 41.052,  7.75611, 38.4599, 9.32422, 36);
    ctx.bezierCurveTo(20.3284, 53.262,  35.7763, 64,      52.8828, 64);
    ctx.bezierCurveTo(69.9892, 64,      85.4363, 53.2618, 96.4404, 36);
    ctx.closePath();
    ctx.fill();

    // Left lash
    ctx.beginPath();
    ctx.moveTo(4.90625, 28.2344);
    ctx.bezierCurveTo(6.28574, 30.9469, 7.76304, 33.5393, 9.33105, 35.999);
    ctx.bezierCurveTo(7.76319, 38.4585, 6.28562, 41.0505, 4.90625, 43.7627);
    ctx.bezierCurveTo(4.40817, 43.0546, 3.91702, 42.338,  3.43652, 41.6113);
    ctx.bezierCurveTo(2.24142, 39.8038, 1.0962,  37.931,  0,       35.999);
    ctx.bezierCurveTo(1.0962,  34.067,  2.24142, 32.1942, 3.43652, 30.3867);
    ctx.bezierCurveTo(3.91717, 29.6598, 4.40801, 28.9426, 4.90625, 28.2344);
    ctx.closePath();
    ctx.fill();

    // Right lash
    ctx.beginPath();
    ctx.moveTo(100.873, 28.2344);
    ctx.bezierCurveTo(101.371, 28.9427, 101.862, 29.6597, 102.343, 30.3867);
    ctx.bezierCurveTo(103.538, 32.1943, 104.684, 34.0669, 105.78,  35.999);
    ctx.bezierCurveTo(104.684, 37.9311, 103.538, 39.8038, 102.343, 41.6113);
    ctx.bezierCurveTo(101.862, 42.3381, 101.371, 43.0546, 100.873, 43.7627);
    ctx.bezierCurveTo(99.4936, 41.0503, 98.0153, 38.4587, 96.4473, 35.999);
    ctx.bezierCurveTo(98.0154, 33.5391, 99.4935, 30.947,  100.873, 28.2344);
    ctx.closePath();
    ctx.fill();

    // Iris
    ctx.beginPath();
    ctx.arc(ICX, ICY, IRIS_R, 0, Math.PI * 2);
    ctx.fill();

    // Pupil (animated hole — background colour punches through the iris)
    ctx.beginPath();
    ctx.arc(ICX + px, ICY + py, PUPIL_R, 0, Math.PI * 2);
    ctx.fillStyle = BG;
    ctx.fill();
    ctx.fillStyle = 'white';

    // V
    ctx.beginPath();
    ctx.moveTo(118.509, 1);
    ctx.lineTo(139.315, 58.4889);
    ctx.lineTo(160.023, 1);
    ctx.lineTo(172.349, 1);
    ctx.lineTo(146.119, 70.7164);
    ctx.lineTo(132.215, 70.7164);
    ctx.lineTo(105.887, 1);
    ctx.closePath();
    ctx.fill();

    // R (outer body + inner bowl cutout — nonzero fill punches the counter)
    ctx.beginPath();
    ctx.moveTo(190.827, 45.1767);
    ctx.lineTo(190.827, 70.7164);
    ctx.lineTo(179.388, 70.7164);
    ctx.lineTo(179.388, 1);
    ctx.lineTo(206.505, 1);
    ctx.bezierCurveTo(210.121, 1,       213.507, 1.36156, 216.662, 2.08469);
    ctx.bezierCurveTo(219.818, 2.80782, 222.546, 4.024,   224.847, 5.73322);
    ctx.bezierCurveTo(227.213, 7.44243, 229.054, 9.71044, 230.369, 12.5372);
    ctx.bezierCurveTo(231.749, 15.364,  232.439, 18.8482, 232.439, 22.9897);
    ctx.bezierCurveTo(232.439, 25.8165, 232.012, 28.4132, 231.158, 30.7798);
    ctx.bezierCurveTo(230.369, 33.0807, 229.284, 35.1186, 227.903, 36.8936);
    ctx.bezierCurveTo(226.523, 38.6028, 224.912, 40.049,  223.072, 41.2323);
    ctx.bezierCurveTo(221.231, 42.3499, 219.259, 43.1717, 217.155, 43.6976);
    ctx.lineTo(232.242, 70.7164);
    ctx.lineTo(219.522, 70.7164);
    ctx.bezierCurveTo(217.221, 66.4433, 214.887, 62.2031, 212.52,  57.9958);
    ctx.bezierCurveTo(210.22,  53.7228, 207.886, 49.4497, 205.519, 45.1767);
    ctx.closePath();
    ctx.moveTo(204.928, 35.2172);
    ctx.bezierCurveTo(207.163, 35.2172, 209.266, 35.02,   211.239, 34.6256);
    ctx.bezierCurveTo(213.211, 34.2311, 214.92,  33.5737, 216.366, 32.6534);
    ctx.bezierCurveTo(217.812, 31.733,  218.93,  30.484,  219.719, 28.9063);
    ctx.bezierCurveTo(220.574, 27.2628, 221.001, 25.192,  221.001, 22.6939);
    ctx.bezierCurveTo(221.001, 20.4588, 220.639, 18.6181, 219.916, 17.1718);
    ctx.bezierCurveTo(219.259, 15.7256, 218.273, 14.5751, 216.958, 13.7205);
    ctx.bezierCurveTo(215.643, 12.8002, 214.065, 12.1757, 212.225, 11.847);
    ctx.bezierCurveTo(210.384, 11.4525, 208.346, 11.2553, 206.111, 11.2553);
    ctx.lineTo(190.827, 11.2553);
    ctx.lineTo(190.827, 35.2172);
    ctx.closePath();
    ctx.fill();

    // A (outer body + inner triangle cutout)
    ctx.beginPath();
    ctx.moveTo(290.122, 70.7164);
    ctx.lineTo(284.995, 56.6153);
    ctx.lineTo(253.341, 56.6153);
    ctx.lineTo(248.115, 70.7164);
    ctx.lineTo(235.69,  70.7164);
    ctx.lineTo(262.118, 1);
    ctx.lineTo(276.317, 1);
    ctx.lineTo(302.646, 70.7164);
    ctx.closePath();
    ctx.moveTo(281.445, 46.36);
    ctx.lineTo(269.217, 12.2414);
    ctx.lineTo(256.891, 46.36);
    ctx.closePath();
    ctx.fill();

    ctx.restore();

    // ── Timer ─────────────────────────────────────────────────────────────
    var elapsed = Date.now() - startTime;
    var timeStr = formatTime(elapsed);

    // Subtle label
    ctx.font = '12px system-ui, Arial, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ВРЕМЯ ВСТРЕЧИ', W / 2, 307);

    // Frosted-glass pill
    var pillW = 174, pillH = 52, pillY = 322;
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.roundRect((W - pillW) / 2, pillY, pillW, pillH, 26);
    ctx.fill();

    // Thin pill border
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect((W - pillW) / 2, pillY, pillW, pillH, 26);
    ctx.stroke();

    // Timer digits
    ctx.font = 'bold 36px "Courier New", "Liberation Mono", monospace';
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(timeStr, W / 2, pillY + pillH / 2);
  }

  // ── Bootstrap ────────────────────────────────────────────────────────────
  var canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  var ctx = canvas.getContext('2d');

  drawFrame(ctx);
  var captureStream = canvas.captureStream(FPS);

  window.addEventListener('DOMContentLoaded', function () {
    canvas.style.cssText = 'position:fixed;top:-9999px;left:-9999px;pointer-events:none;';
    document.body.appendChild(canvas);
  });

  setInterval(function () {
    updatePupil();
    drawFrame(ctx);
  }, 1000 / FPS);

  function getLogoVideoTrack() { return captureStream.getVideoTracks()[0] || null; }

  // Patch 1: getUserMedia — replace video track before Telemost stores the stream.
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    var origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async function (constraints) {
      var original = await origGUM(constraints);
      if (!constraints || !constraints.video) return original;
      var vt = getLogoVideoTrack();
      if (!vt) return original;
      var patched = new MediaStream([vt]);
      original.getAudioTracks().forEach(function (t) { patched.addTrack(t); });
      return patched;
    };
  }

  // Patch 2: RTCPeerConnection.prototype.addTrack — belt-and-suspenders intercept
  // at the WebRTC send level in case getUserMedia was called before our patch.
  var _origAddTrack = RTCPeerConnection.prototype.addTrack;
  RTCPeerConnection.prototype.addTrack = function (track) {
    var args = Array.prototype.slice.call(arguments);
    if (track && track.kind === 'video') {
      var vt = getLogoVideoTrack();
      if (vt) args[0] = vt;
    }
    return _origAddTrack.apply(this, args);
  };

  // Patch 3: RTCPeerConnection.prototype.addTransceiver — covers newer Telemost
  // builds that call addTransceiver(track|'video', init) instead of addTrack.
  var _origAddTransceiver = RTCPeerConnection.prototype.addTransceiver;
  RTCPeerConnection.prototype.addTransceiver = function (trackOrKind, init) {
    var args = Array.prototype.slice.call(arguments);
    var isVideoTrack = typeof trackOrKind === 'object' && trackOrKind !== null && trackOrKind.kind === 'video';
    var isVideoKind  = typeof trackOrKind === 'string' && trackOrKind === 'video';
    if (isVideoTrack || isVideoKind) {
      var vt = getLogoVideoTrack();
      if (vt) {
        if (isVideoTrack) { args[0] = vt; }
        var transceiver = _origAddTransceiver.apply(this, args);
        // For the addTransceiver('video', ...) form the sender starts with no track.
        if (isVideoKind) { transceiver.sender.replaceTrack(vt).catch(function () {}); }
        return transceiver;
      }
    }
    return _origAddTransceiver.apply(this, args);
  };

  // Patch 4: RTCRtpSender.prototype.replaceTrack — covers the sendrecv-transceiver
  // pattern where addTransceiver creates an empty sender then replaceTrack feeds it.
  var _origReplaceTrack = RTCRtpSender.prototype.replaceTrack;
  RTCRtpSender.prototype.replaceTrack = function (track) {
    if (track && track.kind === 'video') {
      var vt = getLogoVideoTrack();
      if (vt) return _origReplaceTrack.call(this, vt);
    }
    return _origReplaceTrack.call(this, track);
  };
})();
`;
