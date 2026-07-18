import fs from 'node:fs';
import path from 'node:path';

const CONFIG_PATH = path.join(process.cwd(), 'data', 'robot-config.json');
const DEFAULT_PORT = 81;

export function loadRobotUrl(fallbackUrl) {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.robotWsUrl) return parsed.robotWsUrl;
  } catch {
    // no saved config yet -- fall through to the .env default
  }
  return fallbackUrl;
}

export function saveRobotUrl(url) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ robotWsUrl: url }, null, 2));
}

// Accepts a bare IP, "IP:port", or a full ws://.../wss://... URL and normalizes it to
// a ws:// URL with a default port, so the landing page's field can take any of those.
export function normalizeRobotUrl(input) {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('empty URL');

  const withScheme = /^wss?:\/\//i.test(trimmed) ? trimmed : `ws://${trimmed}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('not a valid URL');
  }

  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('URL must use ws:// or wss://');
  }
  if (!url.port) url.port = String(DEFAULT_PORT);

  return url.toString().replace(/\/$/, '');
}
