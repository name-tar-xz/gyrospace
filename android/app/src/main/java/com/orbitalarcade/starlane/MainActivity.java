package com.orbitalarcade.starlane;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.DashPathEffect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.inputmethod.InputMethodManager;
import android.view.inputmethod.EditorInfo;
import android.text.InputFilter;
import android.text.InputType;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Locale;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

public class MainActivity extends Activity implements SensorEventListener {
    private static final int BG = Color.rgb(7, 11, 20);
    private static final int PANEL = Color.rgb(13, 20, 32);
    private static final int PANEL_INNER = Color.rgb(8, 14, 24);
    private static final int WHITE = Color.rgb(242, 246, 251);
    private static final int MUTED = Color.rgb(134, 149, 169);
    private static final int CYAN = Color.rgb(101, 232, 236);
    private static final int MINT = Color.rgb(182, 255, 206);
    private static final int ORANGE = Color.rgb(255, 185, 104);
    private static final int RED = Color.rgb(255, 105, 119);

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final OkHttpClient httpClient = new OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build();

    private EditText serverField;
    private EditText roomField;
    private TextView connectionBadge;
    private TextView connectionMessage;
    private TextView sensorState;
    private TextView motionMessage;
    private TextView angleValue;
    private TextView roomFooter;
    private TextView latencyFooter;
    private Button connectButton;
    private Button calibrateButton;
    private TiltDialView dialView;

    private SensorManager sensorManager;
    private Sensor rotationSensor;
    private Sensor gyroscope;
    private float gyroRollRateDegrees = 0f;
    private final float[] rotationMatrix = new float[9];
    private final float[] orientationAngles = new float[3];
    private int rotationSensorType = -1;
    private boolean motionEnabled = false;
    private boolean sensorSeen = false;
    private float lastRoll = Float.NaN;
    private float neutralRoll = Float.NaN;
    private float lastPitch = Float.NaN;
    private float neutralPitch = Float.NaN;
    private float motionSteer = 0f;
    private float effectiveSteer = 0f;
    private float motionThrottle = 0f;
    private float effectiveThrottle = 0f;

    private String roomCode = "";
    private WebSocket socket;
    private boolean isPaired = false;
    private boolean wantsConnection = false;
    private long connectionGeneration = 0;
    private long lastProbeAt = 0;
    private String lastError = "";

    private final Runnable inputTicker = new Runnable() {
        @Override public void run() {
            WebSocket activeSocket = socket;
            if (activeSocket != null && isPaired) {
                try {
                    JSONObject input = new JSONObject();
                    input.put("type", "input");
                    input.put("x", Math.max(-1f, Math.min(1f, effectiveSteer)));
                    input.put("throttle", Math.max(-1f, Math.min(1f, effectiveThrottle)));
                    activeSocket.send(input.toString());

                    long now = SystemClock.elapsedRealtime();
                    if (now - lastProbeAt >= 1800) {
                        JSONObject probe = new JSONObject();
                        probe.put("type", "latency");
                        probe.put("t", now);
                        activeSocket.send(probe.toString());
                        lastProbeAt = now;
                    }
                } catch (JSONException ignored) {
                    // The fixed input payload cannot fail under normal operation.
                }
            }
            handler.postDelayed(this, 33);
        }
    };

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        window.setStatusBarColor(BG);
        window.setNavigationBarColor(BG);
        if (Build.VERSION.SDK_INT >= 30) window.setDecorFitsSystemWindows(true);

        sensorManager = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        SharedPreferences preferences = getSharedPreferences("starlane-controller", MODE_PRIVATE);
        String savedServer = preferences.getString("server", "");
        buildInterface();
        if (!savedServer.isEmpty()) serverField.setText(savedServer);
        roomField.setText(preferences.getString("room", ""));
        handler.post(inputTicker);
    }

    private void buildInterface() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(BG);
        scroll.setClipToPadding(false);

        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(20), dp(8), dp(20), dp(24));
        scroll.addView(content, new ScrollView.LayoutParams(
                ScrollView.LayoutParams.MATCH_PARENT, ScrollView.LayoutParams.WRAP_CONTENT));
        setContentView(scroll);

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setOrientation(LinearLayout.HORIZONTAL);
        TextView brand = makeText("✦  ORBITAL / ARCADE", 11, CYAN, true);
        brand.setLetterSpacing(.10f);
        header.addView(brand, new LinearLayout.LayoutParams(0, dp(52), 1));
        connectionBadge = makeText("NOT PAIRED", 9, ORANGE, true);
        connectionBadge.setGravity(Gravity.CENTER);
        connectionBadge.setPadding(dp(10), dp(8), dp(10), dp(8));
        connectionBadge.setBackground(roundBackground(0x14FFB968, 0x44FFB968, 6));
        header.addView(connectionBadge, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, dp(30)));
        content.addView(header);
        addDivider(content, 0x223F5268, 1, 0, 0, 16);

        TextView eyebrow = makeText("REMOTE PILOTING   //   FLIGHT DECK 01", 9, MUTED, true);
        eyebrow.setLetterSpacing(.14f);
        content.addView(eyebrow, marginParams(-1, -2, 0, 17, 0));
        TextView title = makeText("YOUR PHONE.", 32, WHITE, true);
        title.setLetterSpacing(.025f);
        content.addView(title);
        TextView titleAccent = makeText("THE FLIGHT STICK.", 31, CYAN, true);
        titleAccent.setLetterSpacing(.02f);
        content.addView(titleAccent);
        TextView subtitle = makeText("Roll to steer. Pitch to control rail speed.", 12, MUTED, false);
        subtitle.setLineSpacing(dp(3), 1f);
        content.addView(subtitle, marginParams(-1, -2, 0, 18, 0));

        LinearLayout pairCard = card(content, "PAIR WITH YOUR GAME", "SIX-CHARACTER ROOM CODE");
        TextView serverLabel = label("GAME SERVER ADDRESS");
        pairCard.addView(serverLabel, marginParams(-1, -2, 0, 7, 0));
        serverField = makeField("https://your-game-host  or  http://192.168.1.x:3000", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        serverField.setImeOptions(EditorInfo.IME_ACTION_NEXT);
        pairCard.addView(serverField, marginParams(-1, 46, 0, 13, 0));

        TextView codeLabel = label("ROOM CODE");
        pairCard.addView(codeLabel, marginParams(-1, -2, 0, 7, 0));
        roomField = makeField("ENTER CODE", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        roomField.setFilters(new InputFilter[]{new InputFilter.AllCaps(), new InputFilter.LengthFilter(6)});
        roomField.setLetterSpacing(.20f);
        roomField.setImeOptions(EditorInfo.IME_ACTION_DONE);
        pairCard.addView(roomField, marginParams(-1, 46, 0, 11, 0));

        connectButton = makeButton("CONNECT TO GAME", CYAN, BG);
        pairCard.addView(connectButton, marginParams(-1, 44, 0, 0, 0));
        connectButton.setOnClickListener(view -> {
            hideKeyboard();
            if (wantsConnection) disconnectFromGame();
            else connectToGame();
        });
        connectionMessage = makeText("On the laptop, copy its server address and enter the six-character room code.", 9, MUTED, false);
        connectionMessage.setLineSpacing(dp(2), 1f);
        pairCard.addView(connectionMessage, marginParams(-1, -2, 1, 10, 0));

        LinearLayout motionCard = card(content, "MOTION SENSOR", "ANDROID DEVICE SENSOR");
        LinearLayout sensorRow = new LinearLayout(this);
        sensorRow.setGravity(Gravity.CENTER_VERTICAL);
        sensorState = makeText("SENSOR STARTING", 8, CYAN, true);
        sensorState.setLetterSpacing(.10f);
        sensorRow.addView(sensorState, new LinearLayout.LayoutParams(0, dp(24), 1));
        angleValue = makeText("0°", 13, CYAN, true);
        angleValue.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        sensorRow.addView(angleValue);
        motionCard.addView(sensorRow);

        dialView = new TiltDialView(this);
        LinearLayout.LayoutParams dialParams = new LinearLayout.LayoutParams(dp(176), dp(176));
        dialParams.gravity = Gravity.CENTER_HORIZONTAL;
        dialParams.topMargin = dp(4);
        dialParams.bottomMargin = dp(6);
        motionCard.addView(dialView, dialParams);

        motionMessage = makeText("Roll to steer · pitch forward to speed up, back to slow down.", 9, MUTED, false);
        motionMessage.setGravity(Gravity.CENTER);
        motionCard.addView(motionMessage, marginParams(-1, -2, 0, 13, 0));

        calibrateButton = makeButton("◎  CALIBRATE", 0xFF172332, 0xFFB9C7D5);
        calibrateButton.setEnabled(false);
        calibrateButton.setBackground(roundBackground(0xFF172332, 0xFF35475A, 6));
        motionCard.addView(calibrateButton, marginParams(-1, 42, 0, 0, 0));
        calibrateButton.setOnClickListener(view -> calibrateNeutral());


        LinearLayout footer = new LinearLayout(this);
        footer.setGravity(Gravity.CENTER_VERTICAL);
        footer.setPadding(dp(2), dp(17), dp(2), dp(3));
        roomFooter = makeText("ROOM  — — — — — —", 7, MUTED, true);
        roomFooter.setTypeface(Typeface.MONOSPACE, Typeface.NORMAL);
        roomFooter.setLetterSpacing(.05f);
        footer.addView(roomFooter, new LinearLayout.LayoutParams(0, dp(18), 1));
        latencyFooter = makeText("LINK —", 7, MUTED, true);
        latencyFooter.setTypeface(Typeface.MONOSPACE, Typeface.NORMAL);
        footer.addView(latencyFooter);
        content.addView(footer);
        TextView gameScreen = makeText("STARLANE  //  ANDROID MOTION CONTROLLER", 7, 0xFF526276, true);
        gameScreen.setLetterSpacing(.12f);
        gameScreen.setGravity(Gravity.CENTER);
        content.addView(gameScreen, marginParams(-1, dp(18), 0, 5, 0));
    }

    private LinearLayout card(LinearLayout parent, String title, String trailing) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(15), dp(14), dp(15), dp(14));
        card.setBackground(roundBackground(PANEL, 0x2A8BA9C5, 12));
        LinearLayout heading = new LinearLayout(this);
        heading.setGravity(Gravity.CENTER_VERTICAL);
        TextView left = label(title);
        heading.addView(left, new LinearLayout.LayoutParams(0, dp(22), 1));
        TextView right = makeText(trailing, 7, 0xFF64758B, true);
        right.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        right.setLetterSpacing(.08f);
        heading.addView(right);
        card.addView(heading);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = dp(12);
        parent.addView(card, params);
        return card;
    }

    private TextView label(String value) {
        TextView view = makeText(value, 8, 0xFF8292A8, true);
        view.setLetterSpacing(.12f);
        return view;
    }

    private TextView makeText(String value, float size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setIncludeFontPadding(false);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private EditText makeField(String hint, int inputType) {
        EditText field = new EditText(this);
        field.setSingleLine(true);
        field.setTextSize(12);
        field.setTextColor(WHITE);
        field.setHintTextColor(0xFF596A7F);
        field.setHint(hint);
        field.setInputType(inputType);
        field.setPadding(dp(12), 0, dp(12), 0);
        field.setBackground(roundBackground(PANEL_INNER, 0x337E9DB8, 7));
        field.setSelectAllOnFocus(false);
        return field;
    }

    private Button makeButton(String value, int background, int foreground) {
        Button button = new Button(this);
        button.setText(value);
        button.setTextSize(9);
        button.setTextColor(foreground);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setLetterSpacing(.08f);
        button.setAllCaps(false);
        button.setMinHeight(dp(42));
        button.setPadding(dp(12), 0, dp(12), 0);
        button.setBackground(roundBackground(background, background == CYAN ? 0xFF65E8EC : 0xFF35475A, 6));
        if (background == CYAN) button.setBackground(roundBackground(CYAN, CYAN, 6));
        return button;
    }

    private void addDivider(LinearLayout parent, int color, int height, int left, int top, int bottom) {
        View divider = new View(this);
        divider.setBackgroundColor(color);
        parent.addView(divider, marginParams(-1, height, left, top, bottom));
    }

    private LinearLayout.LayoutParams marginParams(int width, int height, int left, int top, int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(width < 0 ? width : dp(width), height < 0 ? height : dp(height));
        params.leftMargin = dp(left);
        params.topMargin = dp(top);
        params.bottomMargin = dp(bottom);
        return params;
    }

    private GradientDrawable roundBackground(int fill, int stroke, int radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(dp(radiusDp));
        if (stroke != 0) drawable.setStroke(dp(1), stroke);
        return drawable;
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void hideKeyboard() {
        try {
            InputMethodManager manager = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            manager.hideSoftInputFromWindow(roomField.getWindowToken(), 0);
            roomField.clearFocus();
            serverField.clearFocus();
        } catch (Exception ignored) { }
    }

    private void connectToGame() {
        String base = serverField.getText().toString().trim();
        String code = roomField.getText().toString().toUpperCase(Locale.US).replaceAll("[^A-Z0-9]", "");
        if (base.isEmpty()) {
            setConnection("SERVER ADDRESS NEEDED", "Enter the URL shown on the laptop's game screen.", false);
            serverField.requestFocus();
            return;
        }
        if (code.length() != 6) {
            setConnection("ROOM CODE NEEDED", "Enter the six-character code shown in Flight Link.", false);
            roomField.requestFocus();
            return;
        }
        roomCode = code;
        roomField.setText(code);
        getSharedPreferences("starlane-controller", MODE_PRIVATE).edit()
                .putString("server", base).putString("room", code).apply();
        wantsConnection = true;
        isPaired = false;
        lastError = "";
        setConnection("CONNECTING", "Opening a real-time WebSocket link to the game server…", false);
        connectButton.setText("CANCEL LINK");
        openSocket();
    }

    private String websocketUrl(String base, String code) throws IllegalArgumentException {
        String address = base.trim();
        if (!address.contains("://")) address = "https://" + address;
        Uri uri = Uri.parse(address);
        String scheme = uri.getScheme();
        String authority = uri.getEncodedAuthority();
        String host = uri.getHost();
        if (scheme == null || authority == null || host == null) {
            throw new IllegalArgumentException("Enter a valid server URL, including the host.");
        }
        if (host.equalsIgnoreCase("localhost") || host.equals("127.0.0.1") || host.equals("::1")) {
            throw new IllegalArgumentException("On a phone, localhost means the phone. Use the laptop's Wi-Fi IP (for example http://192.168.1.20:3000) or the hosted game URL.");
        }
        String wsScheme;
        if (scheme.equalsIgnoreCase("https") || scheme.equalsIgnoreCase("wss")) wsScheme = "wss";
        else if (scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("ws")) wsScheme = "ws";
        else throw new IllegalArgumentException("Use an http:// or https:// server address.");
        return wsScheme + "://" + authority + "/ws?role=controller&room=" + Uri.encode(code);
    }

    private void openSocket() {
        if (!wantsConnection) return;
        final long generation = ++connectionGeneration;
        final String target;
        try {
            target = websocketUrl(serverField.getText().toString(), roomCode);
        } catch (IllegalArgumentException error) {
            wantsConnection = false;
            setConnection("CHECK SERVER URL", error.getMessage(), false);
            connectButton.setText("CONNECT TO GAME");
            return;
        }

        Request request = new Request.Builder().url(target).build();
        WebSocket newSocket = httpClient.newWebSocket(request, new WebSocketListener() {
            @Override public void onOpen(WebSocket webSocket, Response response) {
                runOnUiThread(() -> {
                    if (generation != connectionGeneration) return;
                    socket = webSocket;
                    setConnection("PAIRING", "Server reached. Joining room " + roomCode + "…", false);
                });
            }

            @Override public void onMessage(WebSocket webSocket, String text) {
                try {
                    JSONObject message = new JSONObject(text);
                    String type = message.optString("type", "");
                    if (type.equals("joined")) {
                        boolean gameIsOnline = message.optBoolean("gameOnline", false);
                        String joinedRoom = message.optString("room", roomCode);
                        runOnUiThread(() -> {
                            if (generation != connectionGeneration) return;
                            roomCode = joinedRoom;
                            roomFooter.setText("ROOM  " + roomCode);
                            isPaired = true;
                            if (gameIsOnline) setConnection("GAME LINKED", "Paired. Roll to steer; pitch to adjust rail speed.", true);
                            else setConnection("WAITING FOR GAME", "Room found. Waiting for the game screen to reconnect.", false);
                            connectButton.setText("DISCONNECT");
                        });
                    } else if (type.equals("game")) {
                        boolean connected = message.optBoolean("connected", false);
                        runOnUiThread(() -> {
                            if (generation != connectionGeneration) return;
                            if (connected) setConnection("GAME LINKED", "Game screen connected. You are in the cockpit.", true);
                            else if (isPaired) setConnection("WAITING FOR GAME", "Game screen went offline. Reconnecting automatically.", false);
                        });
                    } else if (type.equals("hit")) {
                        String target = message.optString("target", "");
                        if ("asteroid".equals(target)) {
                            runOnUiThread(() -> {
                                if (generation == connectionGeneration) vibrate(24, 48);
                            });
                        } else if ("player".equals(target)) {
                            runOnUiThread(() -> {
                                if (generation == connectionGeneration) vibrate(85, 145);
                            });
                        }
                    } else if (type.equals("latency")) {
                        long sentAt = message.optLong("t", -1);
                        if (sentAt >= 0) {
                            long roundTrip = Math.max(0, SystemClock.elapsedRealtime() - sentAt);
                            runOnUiThread(() -> {
                                if (generation == connectionGeneration) {
                                    latencyFooter.setText("LINK " + roundTrip + "MS");
                                }
                            });
                        }
                    } else if (type.equals("error")) {
                        String errorText = message.optString("message", "Could not join that room.");
                        runOnUiThread(() -> {
                            if (generation != connectionGeneration) return;
                            isPaired = false;
                            wantsConnection = false;
                            lastError = errorText;
                            setConnection("ROOM NOT FOUND", errorText, false);
                            connectButton.setText("CONNECT TO GAME");
                            if (socket != null) socket.close(1000, "Room not found");
                        });
                    }
                } catch (JSONException ignored) {
                    // Ignore non-JSON application messages.
                }
            }

            @Override public void onClosed(WebSocket webSocket, int code, String reason) {
                handleSocketLoss(generation, "Connection closed. Reconnecting…");
            }

            @Override public void onFailure(WebSocket webSocket, Throwable error, Response response) {
                String detail = error.getMessage() == null ? "Network unavailable." : error.getMessage();
                if (response != null) detail = "HTTP " + response.code() + " · " + detail;
                handleSocketLoss(generation, detail);
            }
        });
        socket = newSocket;
    }

    private void handleSocketLoss(long generation, String detail) {
        runOnUiThread(() -> {
            if (generation != connectionGeneration) return;
            socket = null;
            isPaired = false;
            if (wantsConnection) {
                String detailText = detail == null || detail.trim().isEmpty() ? "Network unavailable" : detail.trim();
                if (detailText.length() > 100) detailText = detailText.substring(0, 97) + "…";
                setConnection("RECONNECTING", "Can't reach server (" + detailText + "). Check the server is running and the phone can reach that address.", false);
                connectButton.setText("CANCEL LINK");
                handler.postDelayed(() -> {
                    if (wantsConnection && generation == connectionGeneration) openSocket();
                }, 1400);
            } else if (!lastError.isEmpty()) {
                setConnection("ROOM NOT FOUND", lastError, false);
                connectButton.setText("CONNECT TO GAME");
            } else {
                setConnection("NOT PAIRED", detail, false);
                connectButton.setText("CONNECT TO GAME");
            }
        });
    }

    private void disconnectFromGame() {
        wantsConnection = false;
        connectionGeneration++;
        isPaired = false;
        WebSocket active = socket;
        socket = null;
        if (active != null) active.close(1000, "Controller disconnected");
        connectButton.setText("CONNECT TO GAME");
        setConnection("NOT PAIRED", "Enter the laptop's server address and room code to connect.", false);
    }

    private void setConnection(String badge, String message, boolean connected) {
        if (connectionBadge == null) return;
        connectionBadge.setText(badge);
        connectionBadge.setTextColor(connected ? MINT : (badge.contains("NOT") || badge.contains("ROOM") ? RED : ORANGE));
        connectionBadge.setBackground(roundBackground(
                connected ? 0x143ECA7F : 0x14FFB968,
                connected ? 0x4468D994 : 0x44FFB968, 6));
        if (connectionMessage != null) connectionMessage.setText(message);
        if (roomFooter != null && !roomCode.isEmpty()) roomFooter.setText("ROOM  " + roomCode);
    }

    private void startMotionSensors() {
        rotationSensor = sensorManager.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
        if (rotationSensor == null) rotationSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        gyroscope = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        if (rotationSensor == null) {
            motionEnabled = false;
            sensorState.setText("NO ROTATION SENSOR");
            sensorState.setTextColor(RED);
            calibrateButton.setEnabled(false);
            motionMessage.setText("This Android device has no rotation sensor; tilt steering is unavailable.");
            return;
        }
        rotationSensorType = rotationSensor.getType();
        boolean registered = sensorManager.registerListener(this, rotationSensor, SensorManager.SENSOR_DELAY_GAME);
        if (gyroscope != null) sensorManager.registerListener(this, gyroscope, SensorManager.SENSOR_DELAY_GAME);
        motionEnabled = registered;
        if (registered) {
            sensorState.setText("SENSOR STARTING");
            sensorState.setTextColor(CYAN);
            calibrateButton.setEnabled(true);
            motionMessage.setText("Motion is on. Hold the phone neutral and tap CALIBRATE.");
            sensorSeen = false;
            lastRoll = Float.NaN;
            neutralRoll = Float.NaN;
            lastPitch = Float.NaN;
            neutralPitch = Float.NaN;
            motionSteer = 0f;
            effectiveSteer = 0f;
            motionThrottle = 0f;
            effectiveThrottle = 0f;
            updateEffectiveControls();
        } else {
            sensorState.setText("SENSOR ERROR");
            sensorState.setTextColor(RED);
            calibrateButton.setEnabled(false);
            motionMessage.setText("Could not start the rotation sensor. Check sensor settings.");
        }
    }

    private void calibrateNeutral() {
        if (!motionEnabled || Float.isNaN(lastRoll)) {
            motionMessage.setText("Waiting for a sensor reading — hold the phone still, then retry.");
            return;
        }
        neutralRoll = lastRoll;
        neutralPitch = lastPitch;
        motionSteer = 0f;
        motionThrottle = 0f;
        updateEffectiveControls();
        angleValue.setText("0°");
        motionMessage.setText("Neutral set. Roll to steer; pitch to change rail speed.");
        vibrate(18);
    }

    private void updateEffectiveControls() {
        effectiveSteer = Math.max(-1f, Math.min(1f, motionSteer));
        effectiveThrottle = Math.max(-1f, Math.min(1f, motionThrottle));
        updateTiltIndicator();
    }

    private float railSpeedMultiplier() {
        return Math.max(.45f, Math.min(1.8f, 1f + effectiveThrottle * .8f));
    }

    private void updateTiltIndicator() {
        if (dialView != null) {
            dialView.setReading(effectiveSteer, effectiveThrottle, railSpeedMultiplier());
        }
    }

    private static float normalizeDegrees(float value) {
        while (value > 180f) value -= 360f;
        while (value < -180f) value += 360f;
        return value;
    }

    @Override public void onSensorChanged(SensorEvent event) {
        if (event.sensor.getType() == rotationSensorType) {
            SensorManager.getRotationMatrixFromVector(rotationMatrix, event.values);
            SensorManager.getOrientation(rotationMatrix, orientationAngles);
            lastRoll = (float) Math.toDegrees(orientationAngles[2]);
            lastPitch = (float) Math.toDegrees(orientationAngles[1]);
            if (!sensorSeen || Float.isNaN(neutralRoll) || Float.isNaN(neutralPitch)) {
                neutralRoll = lastRoll;
                neutralPitch = lastPitch;
            }
            sensorSeen = true;

            float rollDelta = normalizeDegrees(lastRoll - neutralRoll);
            float pitchDelta = normalizeDegrees(lastPitch - neutralPitch);
            float rollAdjusted = Math.abs(rollDelta) < 2f ? 0f : rollDelta - Math.signum(rollDelta) * 2f;
            float pitchAdjusted = Math.abs(pitchDelta) < 1.5f ? 0f : pitchDelta - Math.signum(pitchDelta) * 1.5f;
            motionSteer = Math.max(-1f, Math.min(1f, rollAdjusted / 27f));
            motionThrottle = Math.max(-1f, Math.min(1f, pitchAdjusted / 25f));

            float gyroLead = Math.max(-.12f, Math.min(.12f, gyroRollRateDegrees * .004f));
            float fusedTarget = Math.max(-1f, Math.min(1f, motionSteer + gyroLead));
            effectiveSteer += (fusedTarget - effectiveSteer) * .34f;
            effectiveThrottle += (motionThrottle - effectiveThrottle) * .24f;
            sensorState.setText("SENSOR ACTIVE");
            sensorState.setTextColor(MINT);
            motionMessage.setText("Roll to steer · pitch forward/back to change rail speed.");
            angleValue.setText(String.format(Locale.US, "%d°", Math.round(rollDelta)));
            updateTiltIndicator();
        } else if (event.sensor.getType() == Sensor.TYPE_GYROSCOPE) {
            if (event.values.length > 1) gyroRollRateDegrees = (float) Math.toDegrees(event.values[1]);
        }
    }

    private void vibrate(long millis) {
        vibrate(millis, -1);
    }

    private void vibrate(long millis, int requestedAmplitude) {
        try {
            Vibrator vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            if (vibrator == null || !vibrator.hasVibrator()) return;
            if (Build.VERSION.SDK_INT >= 26) {
                int amplitude = requestedAmplitude;
                if (amplitude != VibrationEffect.DEFAULT_AMPLITUDE && !vibrator.hasAmplitudeControl()) {
                    amplitude = VibrationEffect.DEFAULT_AMPLITUDE;
                }
                vibrator.vibrate(VibrationEffect.createOneShot(millis, amplitude));
            } else {
                vibrator.vibrate(millis);
            }
        } catch (Exception ignored) { }
    }

    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) { }

    @Override protected void onResume() {
        super.onResume();
        if (motionEnabled && rotationSensor != null) {
            sensorManager.registerListener(this, rotationSensor, SensorManager.SENSOR_DELAY_GAME);
            if (gyroscope != null) sensorManager.registerListener(this, gyroscope, SensorManager.SENSOR_DELAY_GAME);
        } else if (sensorManager != null && sensorState != null) {
            startMotionSensors();
        }
    }

    @Override protected void onPause() {
        if (sensorManager != null) sensorManager.unregisterListener(this);
        super.onPause();
    }

    @Override protected void onDestroy() {
        handler.removeCallbacks(inputTicker);
        handler.removeCallbacksAndMessages(null);
        if (sensorManager != null) sensorManager.unregisterListener(this);
        wantsConnection = false;
        if (socket != null) socket.close(1000, "App closed");
        httpClient.dispatcher().executorService().shutdown();
        super.onDestroy();
    }

    private class TiltDialView extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private float steer = 0f;
        private float throttle = 0f;
        private float speed = 1f;

        TiltDialView(Context context) {
            super(context);
            setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        }

        void setReading(float newSteer, float newThrottle, float newSpeed) {
            steer = Math.max(-1f, Math.min(1f, newSteer));
            throttle = Math.max(-1f, Math.min(1f, newThrottle));
            speed = newSpeed;
            invalidate();
        }

        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            float cx = getWidth() / 2f;
            float cy = getHeight() / 2f;
            float r = Math.min(getWidth(), getHeight()) * .43f;

            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(dp(1));
            paint.setColor(0x335DA1B4);
            paint.setPathEffect(new DashPathEffect(new float[]{dp(3), dp(4)}, 0));
            canvas.drawCircle(cx, cy, r, paint);
            paint.setPathEffect(null);
            paint.setColor(0x4455DCE3);
            canvas.drawCircle(cx, cy, r * .67f, paint);
            paint.setColor(0x303F7A91);
            canvas.drawLine(cx - r * .82f, cy, cx + r * .82f, cy, paint);
            canvas.drawLine(cx, cy - r * .82f, cx, cy + r * .82f, paint);
            paint.setColor(0x5555DCE3);
            canvas.drawCircle(cx, cy, dp(2), paint);

            paint.setStyle(Paint.Style.FILL);
            paint.setColor(0xFF617D91);
            paint.setTextSize(dp(7));
            paint.setTypeface(Typeface.create(Typeface.MONOSPACE, Typeface.NORMAL));
            canvas.drawText("LEFT", cx - r * .72f, cy + r + dp(10), paint);
            canvas.drawText("RIGHT", cx + r * .30f, cy + r + dp(10), paint);

            paint.setTextAlign(Paint.Align.CENTER);
            paint.setTextSize(dp(9));
            paint.setTypeface(Typeface.create(Typeface.MONOSPACE, Typeface.BOLD));
            paint.setColor(throttle < -.025f ? ORANGE : CYAN);
            canvas.drawText(String.format(Locale.US, "SPD %.1f×", speed), cx, cy - r * .72f, paint);
            paint.setTextAlign(Paint.Align.LEFT);

            float markerX = cx + steer * r * .56f;
            float markerY = cy - throttle * r * .56f;
            paint.setStyle(Paint.Style.FILL);
            paint.setShadowLayer(dp(10), 0, 0, 0x9965E8EC);
            paint.setColor(throttle < -.025f ? ORANGE : 0xFF65E8EC);
            canvas.drawCircle(markerX, markerY, dp(9), paint);
            paint.clearShadowLayer();
            paint.setColor(0xFF0B1D28);
            canvas.drawCircle(markerX, markerY, dp(3), paint);

        }
    }
}
