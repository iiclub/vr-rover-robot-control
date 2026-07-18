import { WebSocketServer } from 'ws';

const HEARTBEAT_INTERVAL_MS = 7000;
const WATCHDOG_TICK_MS = 50;

// Relays control messages from the Quest client to the NodeMCU, with a staleness
// watchdog: if no control message arrives within `staleMs`, an explicit stop is sent
// immediately (this is layer 2 of the failsafe -- layer 1 is the firmware's own
// independent 400ms timeout, layer 3 is the Quest client giving up and not queuing input).
//
// Built with `noServer: true` -- see the comment atop videoRelay.js's attachVideoRelay
// for why (two WebSocketServer instances each attached via `{ server, path }` corrupts
// frames on this ws/Node combination; index.js routes upgrades to both by pathname instead).
export function attachControlRelay(nodemcu, { token, staleMs = 250 } = {}) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    if (token && url.searchParams.get('token') !== token) {
      console.warn('[control] rejected connection: bad/missing token');
      ws.close(4001, 'unauthorized');
      return;
    }

    console.log('[control] quest connected');
    let lastMsgTime = Date.now();
    let stopped = false;
    let isAlive = true;

    ws.on('pong', () => { isAlive = true; });

    const heartbeat = setInterval(() => {
      if (!isAlive) {
        console.warn('[control] heartbeat failed, terminating stale connection');
        ws.terminate();
        return;
      }
      isAlive = false;
      ws.ping();
    }, HEARTBEAT_INTERVAL_MS);

    const watchdog = setInterval(() => {
      const stale = Date.now() - lastMsgTime > staleMs;
      if (stale && !stopped) {
        stopped = true;
        nodemcu.sendStop();
        console.log('[control] control input stale, stop sent to robot');
      }
    }, WATCHDOG_TICK_MS);

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // ignore malformed input rather than crash the connection
      }

      lastMsgTime = Date.now();
      stopped = false;

      if (msg.type === 'control') {
        nodemcu.sendControl({ drive: msg.drive, arm: msg.arm, gripper: msg.gripper, seq: msg.seq });
      } else if (msg.type === 'stop') {
        stopped = true;
        nodemcu.sendStop();
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      clearInterval(watchdog);
      nodemcu.sendStop();
      console.log('[control] quest disconnected, stop sent to robot');
    });

    ws.on('error', (err) => console.error('[control] ws error:', err.message));
  });

  return wss;
}
