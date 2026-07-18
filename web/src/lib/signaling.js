// Thin fetch wrappers around /api/signal -- the one-time WebRTC handshake mailbox.
// See web/api/signal.js for the server side.

function signalUrl(type, params = {}) {
  const token = new URLSearchParams(location.search).get('token') || '';
  const qs = new URLSearchParams({ type, token, ...params });
  return `/api/signal?${qs.toString()}`;
}

async function postSignal(type, sessionId, sdp) {
  const token = new URLSearchParams(location.search).get('token') || '';
  const res = await fetch(`/api/signal?type=${type}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signal-Token': token },
    body: JSON.stringify({ sessionId, sdp }),
  });
  if (!res.ok) throw new Error(`postSignal(${type}) failed: ${res.status}`);
}

export function postOffer(sessionId, sdp) {
  return postSignal('offer', sessionId, sdp);
}

export function postAnswer(sessionId, sdp) {
  return postSignal('answer', sessionId, sdp);
}

// Polls until a *new* offer (different sessionId than lastSeenSessionId) appears.
// Resolves with { sessionId, sdp }. Stops if `signal.aborted` becomes true.
export async function pollForNewOffer(lastSeenSessionId, { intervalMs = 1000, signal } = {}) {
  for (;;) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const res = await fetch(signalUrl('offer'), { signal });
    const body = await res.json();
    if (body.ok && body.offer && body.offer.sessionId !== lastSeenSessionId) {
      return body.offer;
    }
    await sleep(intervalMs, signal);
  }
}

// Polls until an answer for this exact sessionId appears. Resolves with { sdp }.
export async function pollForAnswer(sessionId, { intervalMs = 1000, timeoutMs = 30000, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (Date.now() > deadline) throw new Error('timed out waiting for answer');
    const res = await fetch(signalUrl('answer', { sessionId }), { signal });
    const body = await res.json();
    if (body.ok && body.answer) return body.answer;
    await sleep(intervalMs, signal);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  });
}
