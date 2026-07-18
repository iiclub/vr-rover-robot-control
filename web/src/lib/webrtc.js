// Shared RTCPeerConnection helpers. STUN-only (no TURN) -- see docs/PLAN.md for why
// this is the accepted v1 tradeoff and what to add if a restrictive-NAT network needs it.

export function createPeerConnection() {
  return new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
}

// Non-trickle ICE: wait for gathering to finish, then send one complete SDP blob.
// Adds a one-time ~1-3s delay to session setup, never to steady-state latency.
export function waitForIceGatheringComplete(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    function check() {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    }
    pc.addEventListener('icegatheringstatechange', check);
  });
}
