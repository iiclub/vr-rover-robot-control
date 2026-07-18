# Remote Robot Teleoperation via Oculus Quest 2 — POC Plan

## Context

The goal is to drive a physical robot (differential-drive chassis + 3-DOF servo arm + gripper, controlled by a NodeMCU/ESP8266) from anywhere in the world using an Oculus Quest 2: left Touch controller for the arm, right Touch controller for chassis movement, with a live first-person camera feed from a phone mounted on the robot. The project directory is currently empty — this is a from-scratch build.

Key constraints that shape the design:
- The video feed must be low-latency (teleoperation, not passive viewing) — target sub-200ms glass-to-glass.
- Control must work from anywhere on the internet, but the user wants to avoid deploying separate cloud infrastructure — a single local Node.js server on the home network, exposed via one ngrok tunnel, is the preferred approach over router port-forwarding or a hosted relay.
- The robot must fail safe: if the network drops for any reason (WiFi outage, ngrok tunnel death, Quest disconnects), the robot must stop moving — and this must not depend on the thing that failed still working.
- The user's original hardware pin plan (D7/D8/D9 for 4 servos; D1/D2 double-booked) has real conflicts that need correcting before wiring.

## Architecture

Four components. Both control and video traffic flow through **one local Node.js server**, reached via **one ngrok tunnel** — this is the crux of the design and is what keeps the "single server + single tunnel" goal compatible with low latency (see rationale below).

```
PHONE (PWA, on robot's home WiFi)                    QUEST 2 (WebXR, anywhere on internet)
  getUserMedia -> canvas -> JPEG                        immersive-vr session
  -> binary WS frames                                   Gamepad API (2x Touch controllers)
        |  ws:// (LAN)                                  video quad (CanvasTexture)
        v                                                      ^  |
  ┌─────────────────────────────────────────────────────────────────────────┐
  │                    LOCAL NODE.JS SERVER (home LAN)                       │
  │  express: serves /quest + /phone static apps                             │
  │  ws channels: /ws/video (phone->server->fanout), /ws/control (quest),    │
  │                /ws/robot (server<->nodemcu)                              │
  │  video: latest-frame-wins relay (never queues/backs up)                  │
  │  control: 250ms staleness watchdog -> sends stop to robot                │
  └───────────────────────────────┬───────────────────────────────┬─────────┘
                                   │ ws:// (LAN)                   │ ngrok wss:// tunnel
                                   v                                (Quest side only)
                          NODEMCU (ESP8266)
                          WebSocketsServer :81, PCA9685 (I2C) for 4 servos,
                          L298N-style motor driver, 400ms firmware watchdog
```

**Video path:** phone → LAN → server → ngrok → Quest
**Control path:** Quest → ngrok → server → LAN → NodeMCU

### Why MJPEG-over-WebSocket, not WebRTC

WebRTC media (SRTP/ICE) is UDP; ngrok tunnels are TCP (HTTP/WSS/raw TCP). Getting real WebRTC media through ngrok requires a TURN server with a TCP/TLS relay and effectively a small SFU — real infrastructure, working against the "one server, one tunnel" goal. Instead, JPEG frames sent as binary WebSocket messages ride the *same* `wss://` tunnel already carrying control traffic — no ICE/STUN/TURN, no second port. Each frame is independently decodable (no MSE/decoder buffering), which is what makes low latency achievable — browser MediaSource/WebM streaming typically adds 500ms-1s of unavoidable buffering, which would blow the target.

Mechanics: phone captures frames at 15-20fps → `canvas.toBlob('image/jpeg', ~0.5-0.6 quality)` at ~480x360-640x480 → binary WS send. Server fans out to viewers, keeping only the latest frame per client (drop, never queue — this is the single biggest latency lever). Quest does `createImageBitmap` → canvas → `THREE.CanvasTexture`.

If this proves insufficient after tuning, the documented fallback is a WebRTC setup where the Node server itself is a media peer for both sides (not phone↔Quest direct), with a TURN relay reachable over ngrok's TCP tunnel support — noted as a Phase 2 option, not part of the v1 build.

## Hardware: Corrected Wiring (needs your confirmation before flashing)

Problems with the original plan:
- **D7/D8/D9 for 4 servos** — 3 pins for 4 signals, doesn't work.
- **D8 = GPIO15** is a boot-strapping pin (must be LOW at boot) — risky for any continuously active signal.
- **D9/D10** map to the hardware UART0 (RX0/TX0) — using them as GPIO breaks serial debugging/flashing.
- **Direct GPIO servo PWM + ESP8266 WiFi is a known-bad combination**: software PWM jitters when the WiFi radio does periodic TX bursts (competing interrupt timing) — shows up as servo twitch, exactly under a WebSocket-over-WiFi workload.

**Update: scope is 3 servos (base rotation, lift joint, gripper) — no PCA9685.** 3 servos is still light enough to drive directly off NodeMCU GPIO using the ESP8266 `Servo` library (software PWM via timer interrupts), so D1/D2 (freed from I2C) plus D8 cover it without any driver board.

| Function | Pin | GPIO | Note |
|---|---|---|---|
| Servo: Base rotation | D1 | GPIO5 | ESP8266 `Servo` library |
| Servo: Gripper open/close | D2 | GPIO4 | ESP8266 `Servo` library |
| Servo: Lift joint | D8 | GPIO15 | boot-strapping pin, must be LOW at boot -- but NodeMCU boards already have a pull-down on it for that reason, and a servo signal wire is high-impedance until driven, so it doesn't fight that. Safe to use, unlike D3/D4 below which need the opposite (HIGH at boot). |
| Motor A (Left) IN1/IN2 | D5 / D6 | GPIO14/12 | digital direction only |
| Motor B (Right) IN1/IN2 | D7 / D0 | GPIO13/16 | digital direction only |
| Motor A EN (PWM speed) | D4 | GPIO2 | boot-strapping pin, must be HIGH at boot |
| Motor B EN (PWM speed) | D3 | GPIO0 | boot-strapping pin, must be HIGH at boot (flash-mode select) |

**Correction from an earlier draft of this plan:** do not add an external pull-down resistor on D3/D4 as a hardware-level failsafe. D3 (GPIO0) selects flash mode when LOW at boot and D4 (GPIO2) must also read HIGH at boot — an external pull-down fighting either one risks the board failing to boot into normal run mode at all (worse than the problem it was meant to solve). The real mitigation is firmware-only: `setup()` sets all motor pins to `OUTPUT`/`LOW` as its very first action, before WiFi or anything else. There remains a brief (sub-second) power-on window before `setup()` runs where pin state is technically undefined, but a motor spinning meaningfully in that window would require both direction pins to disagree *and* EN to be nonzero simultaneously by chance — a low-probability edge case, and standard practice for ESP8266 motor-driver projects. Treat it as a known, accepted limitation rather than something a resistor can safely fix here.

Servos should still be powered from a separate 5-6V supply rail (common ground with NodeMCU), not off the NodeMCU's own 5V/3.3V pin — 3 servos can brown out the regulator under stall current.

Software PWM + WiFi can still jitter occasionally with only 2 channels, but the risk is much lower than with 4 — acceptable for this scope. This is a recommendation to verify with a continuity check against your actual current wiring before powering anything on — not a confirmed diagram of what's already connected.

## Failsafe Design (layered, each layer independent of the one above it)

1. **NodeMCU firmware** (last line of defense): `loop()` unconditionally checks `millis() - lastCommandMillis > 400ms` → zero all motor outputs. This check runs every loop iteration regardless of WiFi/server state, so total network loss is still caught.
2. **Local server**: tracks time since last control message per Quest connection; after **250ms** (tighter than firmware's 400ms, so this fires first under normal conditions) or on WS close/error, sends an explicit stop to the NodeMCU.
3. **Quest client**: on disconnect, stops its send loop, shows a reconnecting indicator, and never queues/replays stale input on reconnect — only ever sends live current state.

Open design choice (default chosen, flag if you want it different): on timeout, **motors hard-stop**; **arm servos hold their last commanded position** rather than snapping to a home pose (an arbitrary snap mid-task can be worse than holding still). Revisit if you'd prefer arm auto-retracts on disconnect instead.

Also flagged: an ngrok URL isn't a real secret — add a pre-shared token check on the control WebSocket before accepting connections, cheap insurance against a stranger driving the robot.

## Components to Build

**`/firmware`** — PlatformIO (`board = nodemcuv2`, `framework = arduino`). Libraries: `Links2004/arduinoWebSockets` (WebSocketsServer — more stable than ESPAsyncWebServer on ESP8266 specifically), `Adafruit PWM Servo Driver` + `Adafruit BusIO` (PCA9685), `ArduinoJson` v6/v7, `Wire.h`. Command format over WS (JSON):
```json
{"type":"control","seq":1,"ts":169..., "drive":{"linear":0.5,"angular":-0.2}, "arm":{"base":90,"lift":90}, "gripper":1}
```
Note: ESP8266 `analogWrite` range is 0-1023, not 0-255 — easy bug source. `Serial` stays on hardware UART for debug logging, not repurposed.

**`/server`** — Node.js: `express` (static + `/healthz`), `ws` (WebSocket, built-in ping/pong for half-open ngrok sockets), `dotenv`. Runs ngrok as a sibling CLI process (not the SDK) initially, so `localhost:4040`'s web inspector is available for debugging tunnel behavior during development. Owns the video fanout (latest-frame-wins) and the 250ms control watchdog described above.

**`/server/public/phone`** — plain-JS PWA served by the same Node server (no bundler needed at this scope). `getUserMedia` → canvas → JPEG → WS. Uses **Screen Wake Lock API** (re-requested on `visibilitychange`) — call this out as something that must be actively solved, since mobile OSes suspend camera capture on screen lock/backgrounding. Recommend Android for the camera phone; iOS Safari's wake-lock/background behavior is more restrictive and should be tested rather than assumed if used.

**`/server/public/quest`** — plain-JS + Three.js via CDN (no build step for v1). `navigator.xr.requestSession('immersive-vr')`, reads `XRInputSource.gamepad` (`xr-standard` mapping) per hand — left controller axes/trigger → arm (stick X = base rotation, stick Y = lift joint, trigger = gripper), right controller axes → chassis drive. Video renders as a `CanvasTexture` on a flat quad (no need for a full 3D scene for a mono feed). Poll controllers every XR frame (~72Hz) but throttle outgoing control messages to 20Hz to match the NodeMCU loop rate and avoid flooding the tunnel.

## Build Order (isolates hardware bugs from network bugs from tunnel bugs)

0. **Bench bring-up, no networking** — I2C scanner confirms PCA9685 at `0x40`, manual servo sweep confirms range/polarity, manual motor sequence confirms direction wiring. Fix wiring bugs here first.
1. **NodeMCU + LAN only** — bring up WebSocketsServer, drive it with `wscat`/a throwaway HTML page. Explicitly time the watchdog stop (target ~400ms ± 50ms), including under degraded WiFi.
2. **Server + phone video, LAN only** — verify with a plain debug page before touching Quest/WebXR at all.
3. **Quest WebXR, LAN only (no ngrok yet)** — full local loop end to end; tune video quality/framerate and control feel without network variance as a confound.
4. **Add ngrok** — Quest connects via `wss://` tunnel; phone stays on LAN. Test from a genuinely remote network. Explicitly test each failure mode: kill ngrok mid-drive, power-cycle the router, abruptly close the Quest tab — confirm each stop layer fires as designed.
5. **Polish** — multi-hour phone soak test (battery/heat/wake-lock reliability), Quest WiFi-toggle reconnect UX, add the control-channel auth token.

## Verification

- **Stage 0:** multimeter continuity check against the corrected pin map before power-on; I2C scan confirms `0x40`; servo sweep and motor direction test by observation.
- **Stage 1:** scripted `wscat` command sends; watchdog timing measured via serial log timestamps, including under weak signal.
- **Stage 2:** glass-to-glass latency test — film a running stopwatch with the robot's phone camera, view the relayed feed next to the physical stopwatch, photograph both together, measure the timestamp delta.
- **Stage 3:** repeat the clock test with the Quest headset rendering; confirm server logs show ~20Hz control traffic, not 72Hz.
- **Stage 4:** repeat the clock test from a real remote network; run all three failure-mode tests and confirm stop timing matches the design (server ~250ms, firmware ~400ms as backstop).
- **Stage 5:** multi-hour soak test for stream dropouts/overheating; WiFi-toggle reconnect test; confirm an unauthenticated control WS connection is rejected once the token is added.

## Suggested Project Structure

```
/robot-control-poc
  /firmware/src/main.cpp, platformio.ini
  /server/src/index.js, wsHub.js, videoRelay.js, controlRelay.js, nodemcuClient.js
  /server/public/quest/  (served at /quest)
  /server/public/phone/  (served at /phone)
  /docs (wiring diagram, this plan)
```

---

## Update (2026-07-12): Landing page + dynamic robot URL

### Context for this update

The v1 build above shipped and was verified locally (server boots, `/quest` and `/phone` serve, `/healthz` reports status). Since then the user added AP-mode WiFi provisioning to the firmware (`firmware/src/main.cpp`): the NodeMCU now falls back to a captive-portal config page when it can't connect, lets you pick a WiFi network and password from the phone/laptop, saves it to EEPROM, and reboots — a good pattern, left untouched here. The consequence is that the robot's LAN IP is no longer fixed at flash time, so the server's static `ROBOT_WS_URL` in `.env` (requiring a file edit + restart every time the IP changes) is now a worse fit than it was.

Two things are being added:
1. A landing page at `/` with links into `/phone` and `/quest` (token auto-embedded, no hand-typing a tokenized URL on a Quest headset) plus a live status readout from `/healthz`.
2. A manual "robot URL" field on that landing page so the robot's current LAN address can be updated at runtime, without editing `.env` or restarting the server.

**Important constraint surfaced and confirmed with the user:** the server-to-robot link (`ws://<robot-ip>:81`) is a direct LAN connection, not tunneled through ngrok — home LAN IPs aren't reachable from the public internet at all. This means the server must physically run on the same LAN as the robot and phone (e.g. a Raspberry Pi or always-on machine left at the robot's site), not on whatever device travels with the user. The Quest and the user are the only things free to roam, reaching in via the ngrok URL. Manual IP entry (vs. mDNS, which was considered and declined) doesn't change this constraint — it only changes how the co-located server finds the robot on that same LAN.

### Design

**Config persistence** — new `server/data/robot-config.json` (gitignored), shape `{ "robotWsUrl": "ws://192.168.1.42:81" }`. On startup, `index.js` reads this file if present; otherwise falls back to `ROBOT_WS_URL` from `.env` as the initial default and writes it out. Every successful update via the API (below) overwrites this file, so the chosen address survives a server restart.

**`server/src/nodemcuClient.js` — hot-swappable target.** Refactor so the WS target URL is a mutable variable read at `connect()`-time rather than a closed-over constant, and add `setTargetUrl(newUrl)` / `getUrl()`. Use a `generation` counter incremented on every `setTargetUrl()` call so a stale socket's `close` handler (from the address just replaced) can detect it's superseded and skip its own reconnect-scheduling — otherwise a swap could race and briefly open two connections to two different robots. `connect()` captures its own generation at call time and every handler checks it's still current before acting.

**New endpoint `POST /api/robot-url`** in `server/src/index.js` (or a small new `server/src/robotConfig.js`), body `{ url }`, gated by the same `CONTROL_TOKEN` used elsewhere (query param or header — reuse the check pattern already in `controlRelay.js`/`videoRelay.js`). Normalizes input: if it doesn't start with `ws://`/`wss://`, treat it as a bare IP or `IP:port` and prepend `ws://` / append the default `:81` port. On success: persist to `robot-config.json`, call `nodemcu.setTargetUrl(...)`, return `{ ok, currentUrl }`.

**`/healthz` gains `robotUrl`** (from `nodemcu.getUrl()`) so the landing page can display what's currently configured.

**New landing page**, `server/public/home/` (`index.html` + `app.js`), served at `/` via `express.static` mounted at root in `index.js` (registered alongside, not replacing, the existing `/quest` and `/phone` static mounts — different paths, no conflict). Plain JS, no build step, matching the rest of the client code. Contents:
- Two buttons — "Open Phone Camera" → `/phone?token=…`, "Open Quest Control" → `/quest?token=…". Token is read client-side from the landing page's own `?token=` query string (same pattern already used in `public/phone/app.js` and `public/quest/app.js`) and appended to both hrefs by JS — no server-side templating needed, keeps everything a static file.
- A status panel polling `/healthz` every ~2s: robot link up/down, video source connected, viewer count, and the current `robotUrl`.
- A form (IP or `host:port` input + submit) that `POST`s to `/api/robot-url` with the token, shows the returned `currentUrl` or an error inline, and re-polls `/healthz` immediately after a successful update to confirm the swap.

### Verification

- Start the server, confirm `/` loads and both buttons carry the token through to `/phone` and `/quest`.
- With no robot on the network, confirm `/healthz` shows `robotConnected: false` and the landing page reflects that.
- Submit a bogus IP via the form, confirm it's rejected/stays disconnected without crashing the server; submit a real reachable `ws://` endpoint (can fake one with `wscat -l 81` for this test) and confirm `robotConnected` flips to `true` within a couple seconds and `robot-config.json` now contains it.
- Restart the server and confirm it reconnects to the last-saved URL from `robot-config.json` without needing the form re-submitted.
- Submit an update via `/api/robot-url` without the token, confirm it's rejected (401/4001-equivalent), consistent with how `controlRelay.js` already rejects unauthenticated control connections.
