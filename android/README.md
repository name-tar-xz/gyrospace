# STARLANE Controller (Android)

Native Android motion controller for the STARLANE on-rails space shooter. Motion sensors start automatically when the app opens. Roll steers across the lane; forward/back pitch controls rail speed, and the combined tilt dial shows both inputs. The app relays controls to the paired game over an OkHttp WebSocket. Weapons autofire in-game; there is no shake-to-fire or touchscreen gameplay control.

## Build

- Android Studio / Android Gradle Plugin 8.7.3
- JDK 17
- Android SDK Platform 35

In Android Studio, open this `android/` folder and run the `app` configuration. Or from a terminal:

```bash
./gradlew assembleDebug
```

The debug APK is at `app/build/outputs/apk/debug/app-debug.apk`.

## Pair and fly

On the laptop, run the Node game server and copy the **Game Server Address** from the Flight Link panel. Enter that address and the six-character room code in the app. Hold the phone in a comfortable neutral position and tap **Calibrate**. Roll left/right to steer; pitch forward to accelerate the rail drive and pitch backward to slow it down. The interceptor fires automatically while a run is active. Destroying an asteroid gives a short, light vibration; taking damage in a collision gives a stronger vibration. There are no touchscreen gameplay controls.

For a laptop on your Wi-Fi, use its LAN address such as `http://192.168.1.20:3000`. Do not enter `localhost` on the phone; that refers to the phone itself. HTTPS/WSS is recommended outside a trusted network.
