import * as THREE from 'three';

const CONTROL_SEND_HZ = 20;
const CONTROL_SEND_INTERVAL_MS = 1000 / CONTROL_SEND_HZ;
const BASE_ROTATE_SPEED_DEG_PER_SEC = 60;
const STICK_DEADZONE = 0.08;
const RECONNECT_DELAY_MS = [1000, 2000, 4000];

const token = new URLSearchParams(location.search).get('token') || '';
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const videoWsUrl = `${wsProto}://${location.host}/ws/video?role=viewer&token=${encodeURIComponent(token)}`;
const controlWsUrl = `${wsProto}://${location.host}/ws/control?token=${encodeURIComponent(token)}`;

const enterVrBtn = document.getElementById('enterVr');
const overlay = document.getElementById('overlay');

// ---------- Three.js scene ----------

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 50);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);

// Video feed rendered onto a flat canvas texture. The same canvas doubles as a status
// overlay -- when the video/control link drops, a banner is drawn over the last frame.
const feedCanvas = document.createElement('canvas');
feedCanvas.width = 640;
feedCanvas.height = 480;
const feedCtx = feedCanvas.getContext('2d');
feedCtx.fillStyle = '#111';
feedCtx.fillRect(0, 0, feedCanvas.width, feedCanvas.height);

const feedTexture = new THREE.CanvasTexture(feedCanvas);
feedTexture.colorSpace = THREE.SRGBColorSpace;
const quadGeometry = new THREE.PlaneGeometry(3.2, 2.4);
const quadMaterial = new THREE.MeshBasicMaterial({ map: feedTexture });
const quad = new THREE.Mesh(quadGeometry, quadMaterial);
quad.position.set(0, 1.6, -3);
scene.add(quad);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- WebXR session entry ----------

let xrSupported = false;
if (navigator.xr) {
  navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
    xrSupported = supported;
    enterVrBtn.disabled = !supported;
    enterVrBtn.textContent = supported ? 'Enter VR' : 'WebXR not available';
  });
} else {
  enterVrBtn.textContent = 'WebXR not available in this browser';
}

let currentSession = null;

enterVrBtn.addEventListener('click', async () => {
  if (!xrSupported) return;
  const session = await navigator.xr.requestSession('immersive-vr', {
    optionalFeatures: ['local-floor'],
  });
  currentSession = session;
  overlay.style.display = 'none';
  session.addEventListener('end', () => {
    currentSession = null;
    overlay.style.display = 'flex';
  });
  await renderer.xr.setSession(session);
});

// ---------- Video link (viewer) ----------

let videoWs = null;
let videoReconnectAttempt = 0;
let videoConnected = false;
let lastFrameTime = 0;

function connectVideo() {
  videoWs = new WebSocket(videoWsUrl);
  videoWs.binaryType = 'arraybuffer';

  videoWs.onopen = () => {
    videoConnected = true;
    videoReconnectAttempt = 0;
  };

  videoWs.onmessage = async (ev) => {
    lastFrameTime = performance.now();
    try {
      const blob = new Blob([ev.data], { type: 'image/jpeg' });
      const bitmap = await createImageBitmap(blob);
      feedCtx.drawImage(bitmap, 0, 0, feedCanvas.width, feedCanvas.height);
      bitmap.close();
      feedTexture.needsUpdate = true;
    } catch {
      // corrupt/partial frame -- just skip it, the next one arrives in ~60ms
    }
  };

  videoWs.onclose = scheduleVideoReconnect;
  videoWs.onerror = () => videoWs.close();
}

function scheduleVideoReconnect() {
  videoConnected = false;
  const delay = RECONNECT_DELAY_MS[Math.min(videoReconnectAttempt, RECONNECT_DELAY_MS.length - 1)];
  videoReconnectAttempt++;
  setTimeout(connectVideo, delay);
}

connectVideo();

// ---------- Control link ----------

let controlWs = null;
let controlConnected = false;
let controlReconnectAttempt = 0;

function connectControl() {
  controlWs = new WebSocket(controlWsUrl);

  controlWs.onopen = () => {
    controlConnected = true;
    controlReconnectAttempt = 0;
  };

  controlWs.onclose = scheduleControlReconnect;
  controlWs.onerror = () => controlWs.close();
}

function scheduleControlReconnect() {
  controlConnected = false;
  const delay = RECONNECT_DELAY_MS[Math.min(controlReconnectAttempt, RECONNECT_DELAY_MS.length - 1)];
  controlReconnectAttempt++;
  setTimeout(connectControl, delay);
}

connectControl();

// ---------- Controller input ----------

let baseAngleDeg = 90; // servo center
let liftAngleDeg = 90; // servo center

function applyDeadzone(v) {
  return Math.abs(v) < STICK_DEADZONE ? 0 : v;
}

function readGamepads() {
  const session = renderer.xr.getSession();
  let left = null;
  let right = null;
  if (session) {
    for (const source of session.inputSources) {
      if (!source.gamepad) continue;
      if (source.handedness === 'left') left = source.gamepad;
      else if (source.handedness === 'right') right = source.gamepad;
    }
  }
  return { left, right };
}

function stickAxes(gamepad) {
  if (!gamepad) return [0, 0];
  const axes = gamepad.axes;
  // xr-standard mapping: thumbstick is axes[2]/[3] when a touchpad also exists at [0]/[1];
  // falls back to [0]/[1] on controllers that only report one 2-axis input.
  if (axes.length >= 4) return [applyDeadzone(axes[2]), applyDeadzone(axes[3])];
  if (axes.length >= 2) return [applyDeadzone(axes[0]), applyDeadzone(axes[1])];
  return [0, 0];
}

let seq = 0;
let lastSendTime = 0;
let lastFrameClock = performance.now();

function sendControlIfDue(now) {
  if (!controlConnected || controlWs.readyState !== WebSocket.OPEN) return;
  if (now - lastSendTime < CONTROL_SEND_INTERVAL_MS) return;
  lastSendTime = now;

  const { left, right } = readGamepads();
  const [leftX, leftY] = stickAxes(left);
  const [rightX, rightY] = stickAxes(right);

  // right stick: chassis drive (forward/back = -Y, turn = X)
  const linear = -rightY;
  const angular = rightX;

  // left stick X: nudges base rotation; left stick Y: nudges lift joint;
  // left trigger: gripper openness (0=open,1=closed)
  const dt = (now - lastFrameClock) / 1000;
  baseAngleDeg += leftX * BASE_ROTATE_SPEED_DEG_PER_SEC * dt;
  baseAngleDeg = Math.max(0, Math.min(180, baseAngleDeg));
  liftAngleDeg += -leftY * BASE_ROTATE_SPEED_DEG_PER_SEC * dt;
  liftAngleDeg = Math.max(0, Math.min(180, liftAngleDeg));
  const gripperValue = left && left.buttons[0] ? left.buttons[0].value : 0;

  seq++;
  controlWs.send(JSON.stringify({
    type: 'control',
    seq,
    drive: { linear, angular },
    arm: { base: Math.round(baseAngleDeg), lift: Math.round(liftAngleDeg) },
    gripper: gripperValue,
  }));
}

// ---------- Status banner ----------

function drawStatusBanner() {
  const videoStale = performance.now() - lastFrameTime > 1000;
  if (videoConnected && controlConnected && !videoStale) return;

  const msg = !videoConnected
    ? 'VIDEO RECONNECTING...'
    : videoStale
      ? 'VIDEO STALLED'
      : 'CONTROL RECONNECTING...';

  feedCtx.save();
  feedCtx.fillStyle = 'rgba(0,0,0,0.55)';
  feedCtx.fillRect(0, feedCanvas.height / 2 - 24, feedCanvas.width, 48);
  feedCtx.fillStyle = '#ff5555';
  feedCtx.font = 'bold 24px system-ui, sans-serif';
  feedCtx.textAlign = 'center';
  feedCtx.textBaseline = 'middle';
  feedCtx.fillText(msg, feedCanvas.width / 2, feedCanvas.height / 2);
  feedCtx.restore();
  feedTexture.needsUpdate = true;
}

// ---------- Render loop ----------

renderer.setAnimationLoop((now) => {
  sendControlIfDue(now);
  drawStatusBanner();
  lastFrameClock = now;
  renderer.render(scene, camera);
});
