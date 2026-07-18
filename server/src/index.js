import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodemcuClient } from './nodemcuClient.js';
import { attachVideoRelay } from './videoRelay.js';
import { attachControlRelay } from './controlRelay.js';
import { loadRobotUrl, saveRobotUrl, normalizeRobotUrl } from './robotConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8080;
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || '';
const CONTROL_STALE_MS = Number(process.env.CONTROL_STALE_MS || 250);

if (!CONTROL_TOKEN || CONTROL_TOKEN === 'change-me') {
  console.warn('[server] WARNING: CONTROL_TOKEN is unset or default -- the control channel is unprotected.');
}

// The robot's LAN address can now change at runtime (WiFi is provisioned dynamically via
// the firmware's captive portal), so .env's ROBOT_WS_URL is only the initial default --
// server/data/robot-config.json (updated via POST /api/robot-url) takes over from there.
const initialRobotUrl = loadRobotUrl(process.env.ROBOT_WS_URL || 'ws://robot.local:81');

const app = express();
app.use(express.json());
app.use('/quest', express.static(path.join(__dirname, '../public/quest')));
app.use('/phone', express.static(path.join(__dirname, '../public/phone')));
app.use('/test', express.static(path.join(__dirname, '../public/test')));
app.use(express.static(path.join(__dirname, '../public/home')));

const httpServer = http.createServer(app);

const nodemcu = createNodemcuClient(initialRobotUrl, {
  onStatusChange: (connected) => console.log(`[server] robot link ${connected ? 'UP' : 'DOWN'}`),
});

const video = attachVideoRelay({ token: CONTROL_TOKEN });
const control = attachControlRelay(nodemcu, { token: CONTROL_TOKEN, staleMs: CONTROL_STALE_MS });

// Both relays are built with `noServer: true` -- a single 'upgrade' listener here routes
// by pathname to whichever one applies. See the comment atop videoRelay.js's
// attachVideoRelay for why this indirection exists (attaching two WebSocketServer
// instances directly via `{ server: httpServer, path }` each corrupts frames on this
// ws/Node combination).
httpServer.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/ws/video') {
    video.wss.handleUpgrade(req, socket, head, (ws) => video.wss.emit('connection', ws, req));
  } else if (pathname === '/ws/control') {
    control.handleUpgrade(req, socket, head, (ws) => control.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

function checkToken(req) {
  const provided = req.headers['x-control-token'] || req.query.token;
  return CONTROL_TOKEN && provided === CONTROL_TOKEN;
}

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    robotConnected: nodemcu.isConnected(),
    robotUrl: nodemcu.getUrl(),
    videoSource: video.hasSource(),
    viewers: video.viewerCount(),
  });
});

app.post('/api/robot-url', (req, res) => {
  if (!checkToken(req)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  let normalized;
  try {
    normalized = normalizeRobotUrl(String(req.body?.url || ''));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
    return;
  }

  saveRobotUrl(normalized);
  nodemcu.setTargetUrl(normalized);
  res.json({ ok: true, currentUrl: normalized });
});

httpServer.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] landing page: http://localhost:${PORT}/`);
  console.log(`[server] quest client: http://localhost:${PORT}/quest`);
  console.log(`[server] phone client: http://localhost:${PORT}/phone`);
  console.log(`[server] robot target: ${initialRobotUrl}`);
});
