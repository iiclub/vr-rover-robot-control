// Shared RTCPeerConnection helpers.
//
// TURN fallback: STUN-only failed even on a same-LAN test -- Chrome hides local IPs
// behind per-session mDNS hostnames (privacy feature) that the other peer must resolve,
// and the remaining STUN/srflx candidate pair (same public IP on both sides, behind the
// same router) commonly fails too since most consumer routers don't support NAT
// hairpinning. A TURN relay sidesteps both failure modes and is also what cross-network
// sessions (phone/Quest on different networks) will need anyway. Direct P2P is still
// preferred when it works -- TURN candidates are only used when host/srflx pairs fail.
// openrelay.metered.ca is a free public TURN service, fine for personal/low-traffic use;
// swap for a private TURN (metered.ca paid tier, Twilio, self-hosted coturn) if this
// project ever needs guaranteed bandwidth/uptime.
export function createPeerConnection() {
  return new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
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

// Logs every candidate as it's discovered (host/srflx/relay) and any gathering
// errors (e.g. a TURN server rejecting credentials or being unreachable) -- the
// single most useful thing to look at when a connection won't establish. Call this
// right after createPeerConnection(), before creating the offer/answer.
export function logIceDiagnostics(pc, label) {
  pc.addEventListener('icecandidate', (ev) => {
    if (!ev.candidate) {
      console.log(`[${label}] ICE gathering finished`);
      return;
    }
    const { type, protocol, address, relatedAddress } = ev.candidate;
    console.log(`[${label}] ICE candidate: type=${type} protocol=${protocol} address=${address} relatedAddress=${relatedAddress}`);
  });
  pc.addEventListener('icecandidateerror', (ev) => {
    console.error(`[${label}] ICE candidate error: url=${ev.url} errorCode=${ev.errorCode} errorText=${ev.errorText}`);
  });
}
