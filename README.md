# STARLANE — Motion Arcade

STARLANE is a forward-moving, on-rails space shooter that runs in a laptop browser and is
flown with a **native Android app**. Two devices share one WebSocket room on a small Node.js
server: the phone streams roll-based steering and forward/back pitch throttle, the laptop
runs the game and sends hit events back so the phone can buzz. The interceptor
**autofires** — there is no fire button, no shake gesture and no touchscreen gameplay control.

| Component | Runs on | Runs with |
| --- | --- | --- |
| Game + Flight-Link panel | Laptop browser | HTML, CSS, vanilla JS, Canvas 2D |
| Room server + static host | Laptop | Node.js ≥ 18, **zero npm dependencies** |
| Motion controller | Android phone (or emulator) | Java, OkHttp WebSocket, SensorManager |

A full walkthrough of the code, the audit that removed its dead paths and every tuning
constant lives in **[EXPLANATION.md](EXPLANATION.md)**.

---

## Tech stack

### Browser game (`public/`)

| Piece | Used for |
| --- | --- |
| HTML5 + CSS grid/flex, custom properties, four responsive breakpoints | Game shell, pairing panel, phone-sized layout |
| Vanilla ES2020+ JavaScript (single IIFE, `'use strict'`) | Game loop, simulation, rendering |
| Canvas 2D (`alpha: false`, DPR-aware backing store) | Perspective rails, starfield, asteroids, ship, particles |
| `requestAnimationFrame` + delta-time clamp (`≤ 40 ms`) | Frame-rate-independent movement |
| WebSocket API, `localStorage`, Clipboard API, `ResizeObserver` | Flight link, room-code persistence, copy button, resize handling |
| No framework, no bundler, no build step | Three static files served as-is |

### Room server (`server.js`)

| Piece | Used for |
| --- | --- |
| Node.js built-in `http`, `fs`, `path`, `crypto`, `os`, `url` | Static hosting, `/api/info`, upgrade handling |
| Hand-rolled RFC 6455 framing (`WebSocketPeer`) | Text frames, fragmentation, masking, ping/pong, close codes |
| `Map` of rooms + `Set` of peers, TTL timers, 25 s heartbeat | Pairing, cleanup, dead-socket eviction |
| **No dependencies, no database, no build** | `npm start` is the whole deployment |

### Android controller (`android/`)

| Piece | Used for |
| --- | --- |
| Java 17, single `MainActivity` (no XML layout — UI built in code) | Pairing form, sensor card, status footer |
| `SensorManager`: `TYPE_GAME_ROTATION_VECTOR` → `TYPE_ROTATION_VECTOR` → `TYPE_GYROSCOPE`, `SENSOR_DELAY_GAME` | Roll/pitch steering, gyro lead term |
| OkHttp 4.12.0 `WebSocket` (`pingInterval` 20 s) | Input stream, hit events, latency probes |
| `Vibrator` / `VibrationEffect` | Asteroid hit = short light pulse, damage = stronger pulse |
| `SharedPreferences`, `Handler` ticker, custom `View` dial | Saved server/room, ~30 Hz sender, tilt dial read-out |
| Android Gradle Plugin 8.7.3, Gradle 8.9, JDK 17, `compileSdk`/`targetSdk` 35, `minSdk` 23 | Build toolchain |

---

## Quick start

Two things must run: the server (on the laptop) and the Android app (on the phone). The
laptop browser is the game screen.

```bash
# terminal, in the repo root
npm start            # → STARLANE Motion Arcade listening at http://0.0.0.0:3000
```

Then open `http://localhost:3000` on the laptop → the **Flight Link** panel shows a server
address and a six-character room code. Enter both in the Android app and tap
**Connect to Game**. Details for each step are below.

---

## 1. Run the game server

Requirements: **Node.js 18 or newer**. There are no npm dependencies to install.

```bash
npm start
```

Open `http://localhost:3000` on the laptop. The server binds to `0.0.0.0` so the phone can
reach it over the same Wi-Fi. `PORT` overrides the default 3000:

```bash
PORT=8080 npm start
```

The Flight Link panel gives you the two things the phone needs:

- **Game Server Address** — the URL to paste into the Android app (see
  [Server address and network](#31-server-address-and-network)).
- **YOUR ROOM CODE** — a six-character code such as `K7QM2P`, drawn from a 32-symbol
  alphabet with `I`, `O`, `0` and `1` removed so it can't be misread.

---

## 2. Build and install the Android controller

1. Install Android Studio and its SDK (API 35 / Android Gradle Plugin 8.7.3; JDK 17).
2. Open the `android/` folder as an Android Studio project and let Gradle sync. OkHttp
   4.12.0 is downloaded from Maven Central.
3. Connect a phone with USB debugging enabled, or start an emulator. Press **Run** in
   Android Studio to install **STARLANE Controller**.
4. Start the game on the laptop, then in the app enter the server address and room code and
   tap **Connect to Game**.

From a terminal instead:

```bash
cd android
./gradlew assembleDebug
# APK → android/app/build/outputs/apk/debug/app-debug.apk
```

Android Studio can also build it via **Build → Build Bundle(s) / APK(s) → Build APK(s)**.

---

## 3. Pairing and pairing recovery

### 3.1 Server address and network

Both devices must reach the same server.

| Situation | Use |
| --- | --- |
| Laptop + phone on the same Wi-Fi | The laptop's LAN address, e.g. `http://192.168.1.20:3000`. The Flight Link panel fills this in automatically when the page is opened on `localhost` (it asks the server's `/api/info` for its LAN IPv4 address). |
| Hosted on the internet | The HTTPS origin, e.g. `https://starlane.example.com` |
| Phone-side rule | Never type `localhost` into the phone — that means *the phone*. The app rejects `localhost`/`127.0.0.1`/`::1` and explains this instead of failing silently. |

The app accepts `http://`, `https://`, `ws://` or `wss://`; it maps `http→ws` and
`https→wss` and appends `/ws?role=controller&room=<CODE>`. HTTPS/WSS is recommended
anywhere outside a trusted local network.

### 3.2 How the pairing handshake works

There are no accounts, no tokens and no pairing PIN — **the room code is the pairing
mechanism**. Exactly two sockets share a room: one `game` slot and one `controller` slot.

```text
browser                                server                          phone
   │  GET /ws?role=game[&room=CODE]       │                               │
   ├──────────────────────────────────────►│  create/take over room        │
   │  ◄── {"type":"room","code":"K7QM2P"}  │                               │
   │  ◄── {"type":"controller",…:false}    │                               │
   │                                       │  ◄── /ws?role=controller&room=K7QM2P
   │                                       │  ──► {"type":"joined",…}      │
   │  ◄── {"type":"controller",…:true}     │  ──► {"type":"game",connected:true}
   │                                       │                               │
   │  ◄── {"type":"input","x":…,"throttle":…} ─────────────────────────────┤ (~30 Hz)
   │  ──► {"type":"hit","target":"asteroid"} ─────────────────────────────►│ (vibrate)
```

| Behaviour | Detail |
| --- | --- |
| Code creation | A browser connection **without** a code gets a fresh one; the code is shown in the panel and saved in `localStorage`. |
| Code reuse | A browser refresh reconnects **with** its saved code, so the room — and the phone's pairing — survives a page reload. |
| Join | The phone sends the code it was given; the server checks it is 6 characters and exists, then answers `joined` with `gameOnline` so the app knows whether the game screen is already up. |
| Wrong code | The phone gets `{"type":"error","code":"ROOM_NOT_FOUND"}`, shows the message, and the server closes the socket with 1008 after 250 ms. |
| Takeover | If a slot is already occupied (e.g. the game page reloaded, or the phone reconnected), the older socket is closed with 1000 and the newcomer takes the slot — the code never changes. |
| Empty rooms | When both slots are empty the room is kept for **5 minutes**, then dropped by a TTL timer. A room being re-joined cancels its own expiry. |
| Liveness | The server pings every peer every **25 s**; a peer that misses a pong is closed (1001). OkHttp also pings every 20 s from the phone side. |
| Auto-reconnect | Both ends retry after ~1.4 s on a dropped link. The browser re-uses its stored code; the phone retries only if the user hasn't tapped CANCEL. |
| Stale-socket safety | Each side tags its socket (browser: identity check; phone: a connection generation counter) so replies from an abandoned socket are ignored. |

Room codes are **short-lived session identifiers, not credentials** — anyone who knows a
live code can take the controller slot.

---

## 4. Latency and input smoothing

The design goal is *"the phone feels like a flight stick"*, not *"the server is a source of
truth"*. The server does no simulation, no interpolation and no buffering — it forwards each
input message the moment it arrives — and the game never stalls waiting for the network.

### 4.1 Latency budget

| Stage | Cost | Notes |
| --- | --- | --- |
| Sensor sample | ~5–20 ms | `SENSOR_DELAY_GAME` rotation vector, ~50 Hz |
| Phone smoothing | ~50 ms steer, ~75 ms throttle | Exponential filter (see 4.2) |
| Send cadence | up to 33 ms | One `input` message every ~30 Hz |
| Wi-Fi hop, laptop ⇄ phone | typically 2–10 ms on a LAN | Single hop, no relay chain |
| Server relay | ~0 ms | Parse → clamp → forward to the room's other socket |
| Game-side smoothing | ~110 ms to converge | Eased toward the target at frame rate |

Because the phone is a *continuous* stream rather than discrete commands, a dropped or
delayed message is simply superseded by the next one — there is nothing to re-send and no
rollback to perform. Total felt latency on a LAN is roughly **100–150 ms** end to end, most
of which is deliberate filtering that keeps the ship from jittering.

### 4.2 Phone side (Android)

1. **Sensor fusion** — rotation-vector roll/pitch gives tilt; the gyroscope adds a
   short-lived *lead* term (`rollRate × 0.004`, clamped to ±0.12) so steering anticipates a
   fast flick instead of lagging behind it.
2. **Dead-zone + scaling** — a 2° roll / 1.5° pitch dead-zone absorbs hand tremor; **27° of
   roll is full deflection** and **25° of pitch is full throttle**, clamped to ±1.
3. **Exponential smoothing** — per sensor sample: `steer += (target − steer) × 0.34`,
   `throttle += (target − throttle) × 0.24`. This is where most of the "sluggish but smooth"
   feel comes from, and it's tunable in one line.
4. **~30 Hz sender** — a `Handler` ticker posts `{"type":"input","x":…,"throttle":…}` every
   33 ms while paired. 30 Hz is plenty for a control signal and keeps radio wake-ups low.
5. **Latency probe** — every 1.8 s the app sends `{"type":"latency","t":elapsedRealtime}`
   and the server echoes it back verbatim; the round trip is shown as `LINK 42MS` in the
   app footer, so you can see link health while flying.

### 4.3 Server side

- **Rate limit** — controller input is accepted at most once per **10 ms** (30 Hz senders
  never hit this; a runaway client does not flood the game socket).
- **Clamp, never trust** — `x` and `throttle` are coerced with `Number.isFinite` and clamped
  to `[-1, 1]`, so `NaN` or an absurd value becomes `0` or `±1` rather than poisoning the
  simulation.
- **Role-checked routing** — `input` only from a controller, `hit` only from a game, and
  only for the allow-listed targets `asteroid` / `player`.
- **No state held** — nothing is queued or buffered per client, so the relay adds no
  head-of-line delay of its own.
- **Keepalive** — the 25 s heartbeat evicts sockets that died without closing, which is what
  prevents a "ghost pilot" from holding a room.

### 4.4 Browser side

- **Apply latest, smooth locally** — an incoming `input` just updates `inputX` /
  `inputThrottle`. Steering eases toward `0.5 + x × 0.44` at `9 × dt`, rail speed eases
  toward `clamp(1 + throttle × 0.8, 0.45, 1.8)` at `3.4 × dt`. Both are frame-rate
  independent, so 30 Hz or 144 Hz displays feel the same.
- **Clamp again** — the game re-clamps what it receives; the server's clamp is a courtesy,
  not a contract.
- **Never block on the link** — the loop runs off `requestAnimationFrame` and `dt`; loss of
  the phone (or the entire server) only freezes the ship in place and flips the link pill to
  `RECONNECTING`, then `LINK OFFLINE`.
- **Failure is visible** — the topbar pill, the pilot card and the app's badge/footer all
  report link state, so you can tell "phone asleep" from "server down" while playing.

### 4.5 Why this shape

- **Server as a dumb relay** keeps a hop out of the latency path and makes the whole backend
  auditable in one file.
- **Smoothing on both ends** — the phone filters sensor noise, the browser filters network
  jitter — so neither side has to trust the other's timing.
- **Intent, not state, on the wire** — the phone never receives gameplay state, so there is
  no prediction, no reconciliation and no desync to fix. The dial in the app shows what the
  phone is *asking for*, computed with the same speed formula the game uses.

---

## 5. Controls and gameplay

**Android (all gameplay is motion):**

| Gesture | Effect |
| --- | --- |
| Roll left / right | Steer across the lane |
| Pitch forward | Accelerate along the rail (up to 1.8×) |
| Pitch back | Slow the rail down (to 0.45×) |
| **CALIBRATE** | Capture the current hold as neutral (auto-set on first reading) |
| Tilt dial | Live read-out: marker = steering/throttle, `SPD 1.4×` = rail multiplier |

Pairing, CALIBRATE and disconnect are the only touch controls.

**Weapons and feedback:** the interceptor autofires straight ahead every 0.18 s — no homing,
no fire button. Destroying an asteroid scores 100 points and gives a short light vibration;
an asteroid collision costs one of three hull points, grants 1.25 s of invulnerability,
flashes the screen red and triggers a stronger vibration.

**Progression:** waves advance with score (`wave = min(99, floor(score ÷ 600) + 1)`) and
spawn asteroids faster. Runs end at zero hull and the overlay offers **FLY AGAIN**.

---

## 6. Wire protocol (quick reference)

One JSON-over-WebSocket endpoint: `/ws?role=game|controller&room=<CODE>`.

| Direction | Message | Meaning |
| --- | --- | --- |
| → server | `{"type":"input","x":-1..1,"throttle":-1..1}` | Steering + rail speed (phone, ~30 Hz) |
| → server | `{"type":"latency","t":<ms>}` | Round-trip probe (phone, every 1.8 s) |
| → server | `{"type":"hit","target":"asteroid"\|"player"}` | Game reports a hit (browser) |
| → browser | `{"type":"room","code":"K7QM2P"}` | Your room code |
| → browser | `{"type":"controller","connected":bool}` | Pilot joined/left |
| → browser | `{"type":"input",…}` | Relayed control input |
| → phone | `{"type":"joined","room":…,"gameOnline":bool}` | Pairing accepted |
| → phone | `{"type":"game","connected":bool}` | Game screen came up / went away |
| → phone | `{"type":"hit","target":…}` | Vibrate |
| → phone | `{"type":"latency","t":…}` | Echo for the RTT read-out |
| → phone | `{"type":"error","code":…,"message":…}` | e.g. `ROOM_NOT_FOUND` |

Close codes: `1000` slot takeover, `1001` heartbeat timeout / server stopping, `1002`
protocol error, `1003` binary frame, `1008` bad room or role, `1009` message over 1 MiB.

---

## 7. Project layout

```text
server.js                       HTTP static host + room pairing + input relay
public/index.html               Laptop game, HUD and Flight-Link pairing panel
public/game.js                  Canvas shooter and game-side socket client
public/styles.css               Responsive game/pairing styling
EXPLANATION.md                  Code walkthrough, dead-code audit, tuning constants
android/                        Native Android Studio project
  app/src/main/AndroidManifest.xml
  app/src/main/java/com/orbitalarcade/starlane/MainActivity.java
  app/src/main/res/{values/styles.xml,drawable/ic_launcher.xml}
package.json                    npm start → node server.js (no dependencies)
```

---

## 8. Prototype security notes

This is a local demo, not a production multiplayer service.

- Room codes are session identifiers, **not** authentication: the first `controller` socket
  to present a live code wins the slot.
- There are no user accounts, and the only rate limiting is the 10 ms input gate plus the
  1 MiB message cap.
- `usesCleartextTraffic` is enabled on the Android side so plain `http://` LAN addresses
  work. Prefer `https://`/`wss://` outside a trusted network.
- Put the server behind HTTPS/WSS and a reverse proxy with real limits before exposing it to
  an untrusted network, and read [EXPLANATION.md §11](EXPLANATION.md#11-honest-notes) for the
  rest of the honest caveats.
