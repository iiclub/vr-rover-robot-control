// Quest: WebXR viewer + controller input. Ported from the old
// server/public/quest/app.js. The three.js scene, WebXR session handling, gamepad
// reading and control-send cadence are unchanged; only the transport changed --
// instead of two relayed WebSockets (video + control), this is now the offerer side
// of a single WebRTC RTCPeerConnection carrying both a video track (from the phone's
// camera) and a DataChannel (control JSON), connected directly to the phone.
import * as THREE from 'three';
import { createPeerConnection, waitForIceGatheringComplete } from '../lib/webrtc.js';
import { postOffer, pollForAnswer } from '../lib/signaling.js';

const CONTROL_SEND_HZ = 20;
const CONTROL_SEND_INTERVAL_MS = 1000 / CONTROL_SEND_HZ;
const BASE_ROTATE_SPEED_DEG_PER_SEC = 60;
const STICK_DEADZONE = 0.08;
const RECONNECT_DELAY_MS = [1000, 2000, 4000];

export function start() {
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

  enterVrBtn.addEventListener('click', async () => {
    if (!xrSupported) return;
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor'],
    });
    overlay.style.display = 'none';
    session.addEventListener('end', () => {
      overlay.style.display = 'flex';
    });
    await renderer.xr.setSession(session);
  });

  // ---------- Video element (receives the phone's camera track) ----------

  const videoEl = document.createElement('video');
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  videoEl.muted = true;

  let videoConnected = false;
  let lastFrameTime = 0;
  let fallbackVideoDraw = false;

  function drawVideoFrame() {
    lastFrameTime = performance.now();
    feedCtx.drawImage(videoEl, 0, 0, feedCanvas.width, feedCanvas.height);
    feedTexture.needsUpdate = true;
  }

  function startVideoFrameLoop() {
    if ('requestVideoFrameCallback' in videoEl) {
      const onFrame = () => {
        drawVideoFrame();
        videoEl.requestVideoFrameCallback(onFrame);
      };
      videoEl.requestVideoFrameCallback(onFrame);
    } else {
      // Fallback for browsers without requestVideoFrameCallback: draw every
      // render-loop tick once the video element has enough data.
      fallbackVideoDraw = true;
    }
  }

  // ---------- WebRTC (offerer) ----------

  let pc = null;
  let dataChannel = null;
  let controlConnected = false;
  let reconnectAttempt = 0;

  async function connectToPhone() {
    if (pc) pc.close();
    videoConnected = false;
    controlConnected = false;

    pc = createPeerConnection();
    dataChannel = pc.createDataChannel('control', { ordered: false, maxRetransmits: 0 });
    dataChannel.onopen = () => {
      controlConnected = true;
      reconnectAttempt = 0;
    };
    dataChannel.onclose = () => {
      controlConnected = false;
    };

    pc.ontrack = (ev) => {
      videoEl.srcObject = ev.streams[0] || new MediaStream([ev.track]);
      videoEl.play().catch(() => {});
      videoConnected = true;
      startVideoFrameLoop();
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        videoConnected = false;
        controlConnected = false;
        scheduleReconnect();
      }
    };

    const sessionId = crypto.randomUUID();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);
    await postOffer(sessionId, pc.localDescription.sdp);
    const answer = await pollForAnswer(sessionId);
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  }

  function scheduleReconnect() {
    const delay = RECONNECT_DELAY_MS[Math.min(reconnectAttempt, RECONNECT_DELAY_MS.length - 1)];
    reconnectAttempt++;
    setTimeout(() => {
      connectToPhone().catch((err) => {
        console.warn('reconnect failed:', err.message);
        scheduleReconnect();
      });
    }, delay);
  }

  connectToPhone().catch((err) => {
    console.warn('initial connect failed:', err.message);
    scheduleReconnect();
  });

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
    if (!controlConnected || dataChannel.readyState !== 'open') return;
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
    dataChannel.send(JSON.stringify({
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
    if (fallbackVideoDraw && videoEl.readyState >= 2) drawVideoFrame();
    drawStatusBanner();
    lastFrameClock = now;
    renderer.render(scene, camera);
  });
}
