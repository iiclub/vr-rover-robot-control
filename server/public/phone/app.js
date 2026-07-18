// Phone camera streamer: captures the rear camera, encodes frames as JPEG, and pushes
// them over a WebSocket to the local relay server. Deliberately per-frame (not a video
// codec stream) so there's no decoder buffering on the receiving end -- see plan docs.

const FRAME_INTERVAL_MS = 60; // ~16-17fps
const JPEG_QUALITY = 0.55;
const CAPTURE_WIDTH = 640;
const CAPTURE_HEIGHT = 480;
const RECONNECT_DELAY_MS = 1000;

const token = new URLSearchParams(location.search).get('token') || '';
const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/video?role=source&token=${encodeURIComponent(token)}`;

const videoEl = document.getElementById('preview');
const dotEl = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const statsEl = document.getElementById('stats');

const canvas = document.createElement('canvas');
canvas.width = CAPTURE_WIDTH;
canvas.height = CAPTURE_HEIGHT;
const ctx = canvas.getContext('2d', { alpha: false });

let ws = null;
let sending = false;
let frameTimer = null;
let sentCount = 0;
let lastStatsTime = Date.now();
let wakeLock = null;

function setStatus(live, text) {
  dotEl.classList.toggle('live', live);
  statusText.textContent = text;
}

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: 'environment',
      width: { ideal: CAPTURE_WIDTH },
      height: { ideal: CAPTURE_HEIGHT },
    },
    audio: false,
  });
  videoEl.srcObject = stream;
  await videoEl.play();
}

function connectWs() {
  setStatus(false, 'connecting...');
  ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    setStatus(true, 'streaming');
    startFrameLoop();
  };

  ws.onclose = () => {
    setStatus(false, 'reconnecting...');
    stopFrameLoop();
    setTimeout(connectWs, RECONNECT_DELAY_MS);
  };

  ws.onerror = () => ws.close();
}

function startFrameLoop() {
  if (frameTimer) return;
  frameTimer = setInterval(sendFrame, FRAME_INTERVAL_MS);
}

function stopFrameLoop() {
  clearInterval(frameTimer);
  frameTimer = null;
  sending = false;
}

function sendFrame() {
  if (sending || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (videoEl.readyState < 2) return; // not enough data yet
  sending = true;

  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  canvas.toBlob(
    (blob) => {
      sending = false;
      if (!blob || !ws || ws.readyState !== WebSocket.OPEN) return;
      blob.arrayBuffer().then((buf) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(buf);
      });
      sentCount++;
      const now = Date.now();
      if (now - lastStatsTime > 2000) {
        const fps = (sentCount / ((now - lastStatsTime) / 1000)).toFixed(1);
        statsEl.textContent = `${fps}fps ${canvas.width}x${canvas.height}`;
        sentCount = 0;
        lastStatsTime = now;
      }
    },
    'image/jpeg',
    JPEG_QUALITY
  );
}

// Mobile OSes suspend camera capture the moment the screen locks/backgrounds.
// Re-request the wake lock on every visibility change since the OS can release it
// on its own (e.g. low battery) even while the tab is foregrounded.
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch (err) {
    console.warn('wake lock failed:', err.message);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') acquireWakeLock();
});

(async function init() {
  try {
    await startCamera();
  } catch (err) {
    setStatus(false, `camera error: ${err.message}`);
    return;
  }
  await acquireWakeLock();
  connectWs();
})();
