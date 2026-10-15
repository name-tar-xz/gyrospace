# STARLANE — Motion Arcade

STARLANE is a forward-moving, on-rails browser space shooter controlled by a **native Android app**. The laptop runs the game and a Node.js room server; the Android app streams roll-based steering and forward/back pitch throttle over WebSockets. The interceptor autofires—there is no shake-to-fire action or touchscreen gameplay control.

## Run the game/server

Requirements: Node.js 18 or newer. The server has no npm dependencies.

```bash
npm start
```

Open `http://localhost:3000` on the laptop. The game server binds to `0.0.0.0`. The **Flight Link** panel shows the game server address and a six-character room code. Use **Copy Android Server URL** to copy the address for the Android app.

## Build and install the Android app

1. Install Android Studio and its Android SDK (API 35 / Android Gradle Plugin 8.7.3; JDK 17).
2. Open the `android/` folder as an Android Studio project and allow Gradle to sync. The project downloads OkHttp 4.12.0 from Maven Central.
3. Connect an Android phone with USB debugging enabled, or create an emulator. Choose **Run** in Android Studio to install `STARLANE Controller`.
4. Start the game on the laptop. In the Android app, enter the game server address and room code, then tap **Connect to Game**.
5. Motion starts automatically when the app opens. Hold the phone in your preferred neutral position and tap **Calibrate**. Roll left/right to steer; pitch forward to speed up the rail drive and pitch back to slow it down.

Build from a terminal with:

```bash
cd android
./gradlew assembleDebug
```

The installable debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. Android Studio can also build it from **Build → Build Bundle(s) / APK(s) → Build APK(s)**.

### Server address and network

Both devices must be able to reach the same game server. On a LAN, use the laptop's reachable address, such as `http://192.168.1.20:3000`, not `localhost` on the phone. When the game page is opened using localhost, it attempts to display the server's LAN IPv4 address for Android pairing. For an internet demo, use the HTTPS origin where the game is hosted. The Android app can use either `ws://` or `wss://`; HTTPS/WSS is recommended outside a trusted local network.

## Controls and gameplay

- **Android:** Motion is enabled automatically. The combined tilt dial moves left/right with steering and up/down with rail speed, with the speed multiplier shown in the dial. Use **Calibrate** to set neutral. Setup/pairing and calibration are the only touch controls; gameplay is motion-only.
- **Weapons:** The interceptor autofires throughout a run. There is no shake-to-fire gesture.
- Destroying an asteroid triggers a short, light phone pulse; taking damage from a collision triggers a stronger vibration. Destroying a drone does not trigger the asteroid-hit pulse.
- The app streams steering and throttle at about 30 Hz; the game smooths both movement and rail speed locally. OkHttp maintains the WebSocket and the app displays a small round-trip estimate.
- The game is a Canvas 2D forward-moving rail shooter with animated perspective rails, a speed-reactive starfield, asteroid and drone targets, hull/lives, waves and score. Autofiring laser bolts angle toward the nearest target. Desktop backup steering is **A/D** or **←/→**; **Enter/Space** starts a run. Firing is automatic.
- Rooms reconnect automatically after transient socket loss. Room codes are short-lived session identifiers, not authentication credentials.

## Stack and project layout

- **Browser game:** HTML, CSS, vanilla JavaScript, Canvas 2D.
- **Native phone controller:** Java Android Activity, SensorManager, OkHttp WebSocket client.
- **Room relay:** Node.js built-in HTTP server and a small RFC 6455 WebSocket implementation.

```text
server.js                         HTTP/WebSocket room pairing and input relay
public/index.html                 Laptop game and Android pairing details
public/game.js                    Canvas shooter and game-side socket client
public/styles.css                 Responsive game/pairing styling
android/                          Native Android Studio project
  app/src/main/AndroidManifest.xml
  app/src/main/java/com/orbitalarcade/starlane/MainActivity.java
```

## Prototype security notes

This is a local demo, not a production multiplayer service. Room codes are not authentication, and the server has no user accounts or deployment-grade rate limiting. Put it behind HTTPS/WSS and an appropriate reverse proxy before using it on an untrusted network.
