# STARLANE. Motion Arcade

STARLANE is a space shooter that you play in a web browser while using your phone as a controller. The laptop runs the game the Android app acts as the controller. The two communicate through a WebSocket room on a Node server.

---

## Quick start

Two things must run: the server on the laptop and the Android app on the phone. The browser displays the game screen.

```bash

npm start # → listening at http://0.0.0.0:3000
```

http://localhost:3000` on the laptop. The **Flight Link** panel displays a server address and a six‑character room code. Enter both values into the Android app. Tap **Connect to Game**.

### Server

The server requires Node.js version 18 or higher. Run `npm start`; there is no need to install any dependencies.

```bash

npm start

#. On a different port

PORT=8080 npm start
```

The server listens on `0.0.0.0` allowing the phone to connect over Wi‑Fi. The **Flight Link** panel automatically shows the LAN address when you open the page on `localhost`.

### Android app

1. Install Android. Sdk (API 35 AGP 8.7.3 JDK 17).

2. Open the `android/` folder as a project. Let Gradle sync (OkHttp 4.12.0 is pulled from Maven Central).

3. Plug in a phone with USB debugging. Start an emulator and hit **Run**.

4. Start the game on the laptop enter the server address and room code in the app and tap **Connect to Game**.

From the terminal:

```bash

cd android

./gradlew assembleDebug

# APK → android/app/build/outputs/apk/debug/app-debug.apk
```

---

## Pairing

There are no accounts, no tokens and no PIN. The room code acts as the pairing identifier. Exactly two sockets share a room: one socket belongs to the game the other socket belongs to the controller.

- The browser connects without providing a code. Receives a fresh room code. The room code consists of six characters and excludes I, O 0 and 1 to avoid confusion. The room code is stored in `localStorage` so refreshing the page reconnects to the room.

- The phone sends the room code that was displayed. If the room code is incorrect the server replies with `ROOM_NOT_FOUND`. Closes the socket.

- If a slot is already occupied, for example if the page is reloaded or the phone reconnects the older socket is closed and the newer socket takes its place. The room code remains unchanged.

- Empty rooms stay alive for five minutes. After that a TTL timer removes the room.

- The server sends a ping to every peer every 25 seconds. Dead sockets are evicted. On the phone side OkHttp sends a ping every 20 seconds.

- Both the game and the controller automatically reconnect after 1.4 seconds when the link drops.

Never type `localhost` into the phone because `localhost` refers to the phone itself. Use the laptops LAN address for example `http://192.168.1.20:3000`. The app rejects `localhost` `127.0.0.1` and `::1`. It explains the reason instead of failing silently.

Room codes are short‑lived session identifiers, not credentials. Anyone who knows a code can claim the controller slot.

---

## Latency and smoothing

The goal is for the phone to feel like a flight stick not like a networked input device. The server performs no simulation. It simply forwards each input soon as it arrives so the game never pauses while waiting for the network.

The end‑to‑end latency on an area network is roughly one hundred, to one hundred fifty milliseconds. Most of this latency is deliberate filtering that prevents the ship from jittering.

Phone side:

- The rotation vector provides roll and pitch data. The gyroscope adds a short lead term so that fast flicks do not lag.

- 2° roll / 1.5° pitch dead‑zone. **27° Roll = full deflection, 25° pitch = throttle.**

- smoothing per sample: `steer += (target − steer) × 0.34` `throttle += (target − throttle) × 0.24`. This line creates the smooth feel. One line to tune.

- ~30 Hz sender via a `Handler` ticker.

- Every 1.8 s the phone pings the server; the round‑trip time appears as `LINK 42MS` in the footer.

**Server side:**

- Input rate‑limited to per 10 ms.

- `X`. Throttle` clamped to `[-1 1]` with `Number.isFinite` – no `NaN` poisoning the sim.

- Role‑checked routing (`input` only from controller `hit` only from game).

- No state held, no buffering. Pure relay.

**Browser side:**

- Latest input just updates `inputX` / `inputThrottle`. Steering eases toward `0.5 + x × 0.44` at `9 × dt`; rail speed eases toward `clamp(1 + throttle × 0.8 0.45 1.8)` at `3.4 × dt`. Frame‑rate independent.

- Re‑clamps what it receives. The servers clamp is a courtesy, not a contract.

- Never blocks on the link. Phone dies? Ship. The pill flips to `RECONNECTING` → `LINK OFFLINE`.

**Why this shape:** a simple relay removes a hop from the latency path. Allows the entire backend to be audited in one file. Smoothing on both sides means neither side must trust the others timing. Intent travels over the wire, not state. There is no prediction, no reconciliation, no desync.

## Controls and gameplay

**Android. All motion:**

| Gesture | Effect |

| --- | --- |

Roll left / right | Steer across the lane |

Pitch forward | Speed up (up to 1.8×) |

| Pitch | Slow down (to 0.45×)

| **CALIBRATE** | Set hold as neutral (auto‑set on first reading) |

| Tilt dial | Live read‑out: marker = steering/throttle `SPD 1.4×` = rail multiplier |

Pairing, CALIBRATE and disconnect are the only touch controls.

**Weapons:**

Autofire ahead every 0.18 s. No homing, no button. Destroying an asteroid gives 100 points. A short light buzz. Getting hit costs a hull point (of three) gives 1.25 s of invulnerability flashes the screen red and buzzes harder.

**Progression:**

Waves scale, with score. Wave number equals the minimum of 99 and the integer part of score divided by 600 plus one. Waves spawn faster. When hull reaches zero the run ends. An overlay offers **FLY AGAIN**.

## Wire protocol

One JSON‑over‑WebSocket endpoint: `/ws?role=game|controller&room=<CODE>`.

| Direction | Message | Meaning |
| --- | --- | --- |
| → server | `{"type":"input","x":-1..1,"throttle":-1..1}` | Steering + rail speed (phone, ~30 Hz) |
| → server | `{"type":"latency","t":<ms>}` | RTT probe (phone, every 1.8 s) |
| → server | `{"type":"hit","target":"asteroid"\|"player"}` | Hit report (browser) |
| → browser| `{"type":"room","code":"K7QM2P"}` | Your room code |
| → browser | `{"type":"controller","connected":bool}` | Pilot joined/left |
| → browser | `{"type":"input" …}` | Relayed control input |
| → phone | `{"type":"joined","room":…,"gameOnline":bool}` | Pairing accepted |
| → phone | `{"type":"game","connected":bool}` | Game screen up/down |
| → phone | `{"type":"hit","target":…}` | Vibrate |
| → phone | `{"type":"latency","t":…}` | Echo for RTT read‑out |
| → phone | `{"type":"error","code":…,"message":…}` | e.g. `ROOM_NOT_FOUND` |

Close codes: `1000` takeover, `1001` heartbeat timeout / server stopping, `1002` protocol error, `1003` frame, `1008` bad room or role `1009` message over 1 MiB.

---

## Project layout

```text
server.js                       HTTP static host + room pairing + input relay
public/index.html               Game, HUD, Flight-Link pairing panel
public/game.js                  Canvas shooter + game-side socket client
public/styles.css               Responsive styling
android/                        Native Android Studio project
app/src/main/AndroidManifest.xml
app/src/main/java/com/orbitalarcade/starlane/MainActivity.java
app/src/main/res/{values/styles.xml,drawable/ic_launcher.xml}
package.json                    npm start → node server.js (no dependencies)
```
