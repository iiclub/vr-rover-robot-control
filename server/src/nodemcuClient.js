import { WebSocket } from 'ws';

const RECONNECT_DELAY_MS = 1000;

// Outbound client connection from this server to the NodeMCU's WebSocketsServer on the LAN.
// Auto-reconnects on drop. Exposes sendControl()/sendStop() that no-op silently if the
// robot link is currently down -- the firmware's own 400ms watchdog is the backstop for that case.
//
// The target URL is mutable via setTargetUrl() (the robot's LAN IP can change now that
// WiFi is provisioned dynamically via the firmware's captive portal). A generation counter
// guards against a stale socket's event handlers acting after the target has moved on --
// without it, a swap mid-reconnect could race and leave two sockets open to two robots.
export function createNodemcuClient(initialUrl, { onStatusChange } = {}) {
  let currentUrl = initialUrl;
  let ws = null;
  let connected = false;
  let reconnectTimer = null;
  let generation = 0;

  function setConnected(next) {
    if (connected === next) return;
    connected = next;
    onStatusChange?.(connected);
  }

  function connect() {
    const myGeneration = generation;
    const targetUrl = currentUrl;
    ws = new WebSocket(targetUrl);

    ws.on('open', () => {
      if (myGeneration !== generation) return; // superseded by a setTargetUrl() call
      setConnected(true);
      console.log(`[nodemcu] connected to ${targetUrl}`);
    });

    ws.on('close', () => {
      if (myGeneration !== generation) return;
      setConnected(false);
      console.log('[nodemcu] disconnected, retrying...');
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      if (myGeneration !== generation) return;
      console.error('[nodemcu] connection error:', err.message);
    });
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  }

  function send(obj) {
    if (!connected || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }

  function sendControl({ drive, arm, gripper, seq }) {
    return send({ type: 'control', seq, ts: Date.now(), drive, arm, gripper });
  }

  function sendStop() {
    return send({ type: 'stop' });
  }

  function setTargetUrl(newUrl) {
    if (newUrl === currentUrl) return;
    currentUrl = newUrl;
    clearTimeout(reconnectTimer);
    generation++; // invalidates the old socket's handlers immediately
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.terminate();
    setConnected(false);
    console.log(`[nodemcu] target changed to ${newUrl}, reconnecting...`);
    connect();
  }

  connect();

  return {
    sendControl,
    sendStop,
    isConnected: () => connected,
    getUrl: () => currentUrl,
    setTargetUrl,
  };
}
