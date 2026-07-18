import { WebSocketServer, WebSocket } from 'ws';

// Backpressure guard: if a viewer already has this many bytes queued, skip sending it
// this frame rather than let a backlog build up. Latest-frame-wins, never queue.
const MAX_BUFFERED_BYTES = 256 * 1024;

// Relays binary JPEG frames from a single phone "source" connection to any number of
// Quest "viewer" connections. Connect with ?role=source or ?role=viewer on the WS URL.
//
// Built with `noServer: true` -- index.js owns a single 'upgrade' listener on the shared
// httpServer and routes to this (or controlRelay's) wss by pathname. Attaching two
// separate WebSocketServer instances directly via `{ server: httpServer, path }` (their
// own supported-looking pattern) triggers a real bug in this environment where the
// second instance's connections fail near-instantly with "Invalid WebSocket frame: RSV1
// must be clear" -- reproduced with a minimal repro isolated from the rest of this app.
// Manual single-listener routing avoids it entirely.
export function attachVideoRelay({ token } = {}) {
  // Frames are already-compressed JPEGs -- permessage-deflate just burns CPU for no benefit.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const viewers = new Set();
  let source = null;
  let frameCount = 0;
  let lastLogTime = Date.now();

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const role = url.searchParams.get('role');

    // Viewers reach this over the public ngrok URL, so gate them the same as control.
    // The phone source is expected to stay LAN-only, but checking it too costs nothing.
    if (token && url.searchParams.get('token') !== token) {
      console.warn(`[video] rejected ${role} connection: bad/missing token`);
      ws.close(4001, 'unauthorized');
      return;
    }

    if (role === 'source') {
      if (source) {
        console.log('[video] replacing existing source connection');
        source.terminate();
      }
      source = ws;
      console.log('[video] phone source connected');

      ws.on('message', (data, isBinary) => {
        if (!isBinary) return;
        frameCount++;
        const now = Date.now();
        if (now - lastLogTime > 5000) {
          console.log(`[video] ~${(frameCount / ((now - lastLogTime) / 1000)).toFixed(1)}fps, ${data.length}B/frame`);
          frameCount = 0;
          lastLogTime = now;
        }
        for (const viewer of viewers) {
          if (viewer.readyState !== WebSocket.OPEN) continue;
          if (viewer.bufferedAmount > MAX_BUFFERED_BYTES) continue; // drop, don't queue
          viewer.send(data, { binary: true });
        }
      });

      ws.on('close', () => {
        if (source === ws) source = null;
        console.log('[video] phone source disconnected');
      });
    } else {
      viewers.add(ws);
      console.log(`[video] viewer connected (${viewers.size} total)`);

      ws.on('close', () => {
        viewers.delete(ws);
        console.log(`[video] viewer disconnected (${viewers.size} total)`);
      });
    }

    ws.on('error', (err) => console.error('[video] ws error:', err.message));
  });

  return {
    wss,
    hasSource: () => source !== null,
    viewerCount: () => viewers.size,
  };
}
