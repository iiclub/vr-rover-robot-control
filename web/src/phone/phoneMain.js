// Phone: camera source + local bridge to the NodeMCU. Ported from the old
// server/public/phone/app.js, but instead of JPEG-encoding frames and pushing them
// over a WebSocket relay, the raw camera MediaStreamTrack is handed straight to a
// WebRTC RTCPeerConnection (pc.addTrack) -- WebRTC handles codec/bitrate itself, so
// there's no canvas/JPEG step anymore. The peer connection's DataChannel carries
// control JSON from the Quest, which this module forwards verbatim onto the
// NodeMCU's local WebSocket (ws://robot.local:81 by default), exactly the message
// shape firmware/src/main.cpp already expects -- no firmware changes needed.
import { createPeerConnection, waitForIceGatheringComplete, logIceDiagnostics } from '../lib/webrtc.js';
import { pollForNewOffer, postAnswer } from '../lib/signaling.js';

const RECONNECT_DELAY_MS = 1000;
const ROBOT_URL_STORAGE_KEY = 'robotWsUrl';
const DEFAULT_ROBOT_URL = 'ws://robot.local:81';
const CONTROL_STALE_MS = 250; // matches the old server/src/controlRelay.js watchdog

export function start() {
  const videoEl = document.getElementById('preview');
  const dotEl = document.getElementById('dot');
  const statusText = document.getElementById('statusText');
  const statsEl = document.getElementById('stats');
  const robotUrlInput = document.getElementById('robotUrlInput');
  const robotUrlSave = document.getElementById('robotUrlSave');

  let wakeLock = null;
  let cameraStream = null;
  let robotWs = null;
  let robotWsReconnectTimer = null;
  let lastControlMsgTime = 0;
  let robotStopped = true;
  let pc = null;
  let lastSeenSessionId = null;

  function setStatus(live, text) {
    dotEl.classList.toggle('live', live);
    statusText.textContent = text;
  }

  function getRobotUrl() {
    return localStorage.getItem(ROBOT_URL_STORAGE_KEY) || DEFAULT_ROBOT_URL;
  }

  function setRobotUrl(url) {
    localStorage.setItem(ROBOT_URL_STORAGE_KEY, url);
  }

  robotUrlInput.value = getRobotUrl();
  robotUrlSave.addEventListener('click', () => {
    const url = robotUrlInput.value.trim();
    if (!url) return;
    setRobotUrl(url);
    connectRobotWs();
  });

  // ---------- Camera ----------

  async function startCamera() {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
    videoEl.srcObject = cameraStream;
    await videoEl.play();
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

  // ---------- NodeMCU bridge (local WebSocket) ----------

  function connectRobotWs() {
    clearTimeout(robotWsReconnectTimer);
    if (robotWs) robotWs.close();
    try {
      robotWs = new WebSocket(getRobotUrl());
    } catch (err) {
      scheduleRobotWsReconnect();
      return;
    }
    robotWs.onopen = () => statsEl.textContent = `robot: connected`;
    robotWs.onclose = () => {
      statsEl.textContent = `robot: disconnected`;
      scheduleRobotWsReconnect();
    };
    robotWs.onerror = () => robotWs.close();
  }

  function scheduleRobotWsReconnect() {
    clearTimeout(robotWsReconnectTimer);
    robotWsReconnectTimer = setTimeout(connectRobotWs, RECONNECT_DELAY_MS);
  }

  function sendToRobot(obj) {
    if (robotWs && robotWs.readyState === WebSocket.OPEN) {
      robotWs.send(JSON.stringify(obj));
    }
  }

  // Independent of the NodeMCU's own 400ms firmware watchdog -- this fires first
  // under normal conditions, same 250ms figure the old cloud relay used.
  setInterval(() => {
    if (!robotStopped && Date.now() - lastControlMsgTime > CONTROL_STALE_MS) {
      robotStopped = true;
      sendToRobot({ type: 'stop' });
    }
  }, 50);

  // ---------- WebRTC (answerer) ----------

  async function runSignalingLoop() {
    for (;;) {
      let offer;
      try {
        offer = await pollForNewOffer(lastSeenSessionId);
      } catch (err) {
        console.warn('poll for offer failed, retrying:', err.message);
        await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
        continue;
      }
      lastSeenSessionId = offer.sessionId;
      setStatus(false, 'pairing...');
      try {
        await connectToQuest(offer);
      } catch (err) {
        console.warn('peer connection setup failed:', err.message);
        setStatus(false, 'pairing failed, retrying...');
      }
    }
  }

  async function connectToQuest(offer) {
    if (pc) pc.close();
    pc = createPeerConnection();
    logIceDiagnostics(pc, 'phone');

    pc.ondatachannel = (ev) => {
      console.log('[phone] ondatachannel fired:', ev.channel.label);
      const channel = ev.channel;
      channel.onmessage = (msg) => {
        let data;
        try {
          data = JSON.parse(msg.data);
        } catch {
          return;
        }
        lastControlMsgTime = Date.now();
        robotStopped = false;
        sendToRobot(data);
      };
    };

    // Block here until this connection ends, then the outer loop polls for the
    // next offer (Quest generates a fresh sessionId whenever it reconnects).
    const ended = new Promise((resolve) => {
      pc.oniceconnectionstatechange = () => {
        console.log('[phone] iceConnectionState:', pc.iceConnectionState);
      };
      pc.onconnectionstatechange = () => {
        console.log('[phone] connectionState:', pc.connectionState);
        if (pc.connectionState === 'connected') {
          setStatus(true, 'connected');
        } else if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
          setStatus(false, 'disconnected');
          resolve();
        }
      };
    });

    // setRemoteDescription must happen before addTrack: Quest's offer already
    // declares a recvonly video slot (see questMain.js's addTransceiver call), and
    // addTrack binds into that existing slot instead of needing a whole new
    // negotiation round -- calling it before the remote offer is set would leave
    // the track with no m-line to attach to at all.
    console.log('[phone] setting remote description (offer), sessionId:', offer.sessionId);
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    for (const track of cameraStream.getVideoTracks()) {
      console.log('[phone] adding video track:', track.label, track.readyState);
      pc.addTrack(track, cameraStream);
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    console.log('[phone] local description set, gathering ICE candidates...');
    await waitForIceGatheringComplete(pc);
    console.log('[phone] posting answer');
    await postAnswer(offer.sessionId, pc.localDescription.sdp);
    console.log('[phone] answer posted, waiting for ICE/DTLS to connect...');

    await ended;
  }

  (async function init() {
    try {
      await startCamera();
    } catch (err) {
      setStatus(false, `camera error: ${err.message}`);
      return;
    }
    await acquireWakeLock();
    connectRobotWs();
    setStatus(false, 'waiting for quest...');
    runSignalingLoop();
  })();
}
