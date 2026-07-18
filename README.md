# Robot Control POC

Teleoperate a NodeMCU-driven robot (chassis + 3-servo arm) from a Meta Quest 2, anywhere
in the world, using a phone as the camera. See `docs/PLAN.md` for the full architecture
and rationale.

## Components

- `firmware/` — NodeMCU (ESP8266) firmware: motors, 3 servos (base + lift + gripper), 400ms
  command-timeout watchdog, AP-mode captive portal for WiFi provisioning (no hardcoded
  WiFi required — see "WiFi provisioning" below).
- `server/` — Local Node.js relay server: serves the landing page, Quest, and phone web
  apps, relays video frames, relays and gates control commands, talks to the robot over
  the LAN. **Must run on the same LAN as the robot and phone — see "Where does the server
  run?" below.**
- `server/public/home/` — Landing page: links into the phone/Quest apps, live status, and
  a field to update the robot's LAN address at runtime.
- `server/public/phone/` — Phone camera PWA.
- `server/public/quest/` — Quest 2 WebXR control client.
- `server/public/test/` — Browser button UI (`/test`) for bench-testing drive/arm/gripper
  without the headset — hold-to-move D-pad, arm nudge buttons, gripper open/close, big
  STOP button. Uses the exact same `/ws/control` protocol as the Quest, so it's a good way
  to confirm wiring/direction/servo range before ever putting the headset on.

## Where does the server run?

The server-to-robot connection (`ws://<robot-ip>:81`) is a **direct LAN connection, not
tunneled through ngrok** — LAN IPs aren't reachable from the public internet at all. So
the server must run on a machine that stays on the same WiFi as the robot and phone (a
Raspberry Pi or an always-on machine left at the robot's site works well) — not on
whatever laptop travels with you. Only the Quest (and you) are free to roam; it reaches
in through the ngrok tunnel.

## WiFi provisioning (robot)

The NodeMCU no longer needs WiFi credentials flashed in. On first boot (or if it can't
reconnect), it starts an access point named `Robot-Control-POC` with a captive portal —
connect to it from your phone, pick the real WiFi network and enter its password, and the
robot saves it to EEPROM and reboots onto that network. Because of this, the robot's LAN
IP can change between sessions — see "Updating the robot's address" below instead of
editing `.env` each time.

## One-time setup

**Firmware:**
1. Install [PlatformIO](https://platformio.org/install) (VS Code extension, or `pip install platformio`).
2. `cp firmware/src/secrets.h.example firmware/src/secrets.h` — optional now that AP-mode
   provisioning exists, but still useful as a default so the robot connects immediately
   on first boot without needing the captive portal.
3. Wire the robot per `docs/PLAN.md`'s pin map — **verify with a multimeter before powering on.**
4. From `firmware/`: `pio run --target upload`, then `pio device monitor`. If it connects
   using `secrets.h`, note the printed IP. If not, connect to the `Robot-Control-POC` WiFi
   network from your phone, complete the captive portal, and check the serial monitor
   after it reboots for the IP it lands on.

**Server:**
1. `cd server && npm install`
2. `cp .env.example .env` and set:
   - `ROBOT_WS_URL` — only used as the *initial* default before you first set the robot's
     address via the landing page (see "Updating the robot's address" below); after that,
     `server/data/robot-config.json` takes over.
   - `CONTROL_TOKEN` to a random string — this gates the control/video channels *and* the
     robot-address update endpoint once exposed to the internet.
3. `npm start`

**ngrok** (for remote access, once LAN testing works — see build order below):
```
ngrok http 8080
```
Use the `https://...ngrok-free.app` URL it prints for the Quest.

## Running it

Open `http://<lan-ip>:8080/?token=<CONTROL_TOKEN>` (or the ngrok URL for remote use) —
this is the landing page, with buttons into the phone and Quest apps that carry the token
through automatically, plus live status (robot link, video source, viewer count).

- Phone: from the landing page, tap "Open Phone Camera", add to home screen, grant camera permission.
- Quest (LAN testing): from the landing page in the Quest Browser, tap "Open Quest Control", then Enter VR.
- Quest (remote): same, but load the ngrok URL instead of the LAN address.

Left stick X: arm base rotation. Left stick Y: lift joint. Left trigger: gripper. Right stick: chassis drive.

## Updating the robot's address

Since the robot's WiFi (and therefore its IP) is now configured via the captive portal
rather than fixed at flash time, use the landing page's "Update robot address" field
whenever it changes — paste the IP (or `ws://ip:81`) shown on the NodeMCU's serial
monitor after it connects, and hit Save. This updates the running server immediately (no
restart) and is remembered across restarts via `server/data/robot-config.json`. This
field is only reachable with the correct `CONTROL_TOKEN`, same as the control channel.

## Recommended build order

Don't wire this up end-to-end on day one — isolate hardware bugs from network bugs from
tunnel bugs:

1. **Bench test firmware alone** (no WS traffic) — confirm servo range and motor
   direction/polarity by watching the robot, fix wiring before writing any control logic.
2. **NodeMCU + LAN only** — drive it with `wscat -c ws://<ip>:81` and hand-typed JSON
   commands. Time the watchdog stop (should be ~400ms after you stop sending).
3. **Server + phone video, LAN only** — confirm frames arrive with `curl localhost:8080/healthz`.
4. **Quest WebXR, LAN only** — full loop on the same WiFi, no ngrok yet. Tune video
   quality/framerate and control feel here.
5. **Add ngrok** — test from a genuinely different network (cellular hotspot). Explicitly
   test: killing ngrok mid-drive, power-cycling the router, closing the Quest tab — the
   robot should stop within ~400ms in every case.

## Safety notes

- The firmware's 400ms watchdog is independent of WiFi/server state — it fires even if
  the whole network is down, because it's checked every `loop()` iteration.
- The server issues an explicit stop after 250ms of control silence (tighter than the
  firmware's threshold, so it normally fires first) and on Quest disconnect.
- `CONTROL_TOKEN` gates both `/ws/control` and `/ws/video` — without it, anyone with your
  ngrok URL could drive the robot or watch its camera. Don't skip setting it before
  exposing the tunnel.
