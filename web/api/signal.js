// Vercel serverless function: the entire WebRTC handshake "mailbox" between the
// Quest (offerer) and the phone (answerer). Only SDP blobs pass through here --
// once the RTCPeerConnection is up, video and control traffic never touch this
// endpoint or Vercel again. Non-trickle ICE (see web/src/lib/webrtc.js) means each
// side only ever needs to post one complete offer/answer, so a single KV get/set
// per request is all this needs -- no long-lived connection or queue.
import { Redis } from '@upstash/redis';

const SIGNAL_TOKEN = process.env.SIGNAL_TOKEN || '';
const TTL_SECONDS = 300;

// Supports both the Upstash-native env var names and the legacy Vercel KV names
// (some accounts still have the old integration, which used the KV_REST_API_* names).
const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const kv = new Redis({ url: redisUrl, token: redisToken });

function checkToken(req) {
  const provided = req.headers['x-signal-token'] || req.query.token;
  return SIGNAL_TOKEN && provided === SIGNAL_TOKEN;
}

export default async function handler(req, res) {
  if (!redisUrl || !redisToken) {
    // Most common cause: the Redis integration's env vars were added to the Vercel
    // project after this function was last deployed -- Vercel only injects env vars
    // into the build that follows, so a redeploy is needed to pick them up.
    res.status(500).json({ ok: false, error: 'server misconfigured: missing Redis URL/token env vars' });
    return;
  }

  if (!checkToken(req)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  const type = req.query.type;
  if (type !== 'offer' && type !== 'answer') {
    res.status(400).json({ ok: false, error: 'type must be "offer" or "answer"' });
    return;
  }

  try {
    if (req.method === 'GET') {
      if (type === 'offer') {
        const offer = await kv.get('offer:latest');
        res.status(200).json({ ok: true, offer: offer || null });
        return;
      }
      // answer
      const sessionId = req.query.sessionId;
      if (!sessionId) {
        res.status(400).json({ ok: false, error: 'sessionId required' });
        return;
      }
      const answer = await kv.get(`answer:${sessionId}`);
      res.status(200).json({ ok: true, answer: answer || null });
      return;
    }

    if (req.method === 'POST') {
      const { sessionId, sdp } = req.body || {};
      if (!sessionId || !sdp) {
        res.status(400).json({ ok: false, error: 'sessionId and sdp required' });
        return;
      }
      if (type === 'offer') {
        await kv.set('offer:latest', { sessionId, sdp }, { ex: TTL_SECONDS });
      } else {
        await kv.set(`answer:${sessionId}`, { sdp }, { ex: TTL_SECONDS });
      }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (err) {
    console.error('[api/signal] Redis operation failed:', err);
    res.status(500).json({ ok: false, error: `redis error: ${err.message}` });
  }
}
