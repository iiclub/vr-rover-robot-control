// Bench-test control page: hold-to-move buttons sending the same control protocol the
// Quest client uses, for testing motors/servos with a keyboard-and-mouse (or touch)
// interface instead of needing the headset. Relies on the same server-side and firmware
// watchdogs as the Quest path -- if this page's tab dies or loses connection, the robot
// stops the same way it would if the Quest disconnected.

const SEND_INTERVAL_MS = 100; // 10Hz -- comfortably under the server's 250ms staleness timeout
const BASE_STEP_DEG = 3; // per tick, while a base button is held
const LIFT_STEP_DEG = 3;
const DRIVE_SPEED = 0.6; // fixed speed for button-driven movement, 0..1

const token = new URLSearchParams(location.search).get('token') || '';
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const controlWsUrl = `${wsProto}://${location.host}/ws/control?token=${encodeURIComponent(token)}`;

const dotRobot = document.getElementById('dotRobot');
const txtRobot = document.getElementById('txtRobot');
const dotControl = document.getElementById('dotControl');
const txtControl = document.getElementById('txtControl');

// ---------- Status polling (robot link) ----------

async function pollStatus() {
  try {
    const res = await fetch('/healthz');
    const data = await res.json();
    dotRobot.className = `dot ${data.robotConnected ? 'up' : 'down'}`;
    txtRobot.textContent = data.robotConnected ? 'connected' : 'disconnected';
  } catch {
    txtRobot.textContent = 'unreachable';
  }
}
pollStatus();
setInterval(pollStatus, 2000);

// ---------- Control WebSocket ----------

let ws = null;
let controlConnected = false;
let reconnectAttempt = 0;
const RECONNECT_DELAY_MS = [1000, 2000, 4000];

function setControlStatus(connected) {
  controlConnected = connected;
  dotControl.className = `dot ${connected ? 'up' : 'down'}`;
  txtControl.textContent = connected ? 'connected' : 'disconnected';
}

function connectControl() {
  ws = new WebSocket(controlWsUrl);
  ws.onopen = () => {
    setControlStatus(true);
    reconnectAttempt = 0;
  };
  ws.onclose = () => {
    setControlStatus(false);
    stopSendLoop();
    const delay = RECONNECT_DELAY_MS[Math.min(reconnectAttempt, RECONNECT_DELAY_MS.length - 1)];
    reconnectAttempt++;
    setTimeout(connectControl, delay);
  };
  ws.onerror = () => ws.close();
}
connectControl();

// ---------- Button state ----------

const held = new Set();
let baseAngleDeg = 90;
let liftAngleDeg = 90;
let gripperValue = 0; // 0 = open, 1 = closed
let seq = 0;
let sendLoopTimer = null;

function currentDrive() {
  let linear = 0;
  let angular = 0;
  if (held.has('fwd')) linear += DRIVE_SPEED;
  if (held.has('back')) linear -= DRIVE_SPEED;
  if (held.has('left')) angular += DRIVE_SPEED;
  if (held.has('right')) angular -= DRIVE_SPEED;
  return { linear, angular };
}

function tick() {
  if (held.has('baseLeft')) baseAngleDeg = Math.max(0, baseAngleDeg - BASE_STEP_DEG);
  if (held.has('baseRight')) baseAngleDeg = Math.min(180, baseAngleDeg + BASE_STEP_DEG);
  if (held.has('liftUp')) liftAngleDeg = Math.min(180, liftAngleDeg + LIFT_STEP_DEG);
  if (held.has('liftDown')) liftAngleDeg = Math.max(0, liftAngleDeg - LIFT_STEP_DEG);

  sendControl();
}

function sendControl() {
  if (!controlConnected || ws.readyState !== WebSocket.OPEN) return;
  seq++;
  ws.send(JSON.stringify({
    type: 'control',
    seq,
    drive: currentDrive(),
    arm: { base: Math.round(baseAngleDeg), lift: Math.round(liftAngleDeg) },
    gripper: gripperValue,
  }));
}

function startSendLoop() {
  if (sendLoopTimer) return;
  tick(); // send immediately on first press, don't wait a full interval
  sendLoopTimer = setInterval(tick, SEND_INTERVAL_MS);
}

function stopSendLoop() {
  clearInterval(sendLoopTimer);
  sendLoopTimer = null;
}

function sendStop() {
  if (controlConnected && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stop' }));
  }
}

// ---------- Hold-to-move button wiring ----------

function wireHoldButton(id, key) {
  const el = document.getElementById(id);
  const press = (ev) => {
    ev.preventDefault();
    held.add(key);
    el.classList.add('held');
    startSendLoop();
  };
  const release = () => {
    held.delete(key);
    el.classList.remove('held');
    if (held.size === 0) {
      stopSendLoop();
      sendStop();
    }
  };
  el.addEventListener('pointerdown', press);
  el.addEventListener('pointerup', release);
  el.addEventListener('pointerleave', release);
  el.addEventListener('pointercancel', release);
}

wireHoldButton('btnFwd', 'fwd');
wireHoldButton('btnBack', 'back');
wireHoldButton('btnLeft', 'left');
wireHoldButton('btnRight', 'right');
wireHoldButton('btnBaseLeft', 'baseLeft');
wireHoldButton('btnBaseRight', 'baseRight');
wireHoldButton('btnLiftUp', 'liftUp');
wireHoldButton('btnLiftDown', 'liftDown');

document.getElementById('btnGripperOpen').addEventListener('click', () => {
  gripperValue = 0;
  document.getElementById('btnGripperOpen').classList.add('active');
  document.getElementById('btnGripperClose').classList.remove('active');
  sendControl();
});

document.getElementById('btnGripperClose').addEventListener('click', () => {
  gripperValue = 1;
  document.getElementById('btnGripperClose').classList.add('active');
  document.getElementById('btnGripperOpen').classList.remove('active');
  sendControl();
});

document.getElementById('stopBtn').addEventListener('click', () => {
  held.clear();
  document.querySelectorAll('button.ctrl.held').forEach((el) => el.classList.remove('held'));
  stopSendLoop();
  sendStop();
});

// Safety: if the tab is hidden (backgrounded, screen locked), stop sending -- don't let
// a robot keep driving because a button got "stuck held" while the page wasn't visible.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    held.clear();
    stopSendLoop();
    sendStop();
  }
});
