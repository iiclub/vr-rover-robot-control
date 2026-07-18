#include "secrets.h"
#include <ArduinoJson.h>
#include <DNSServer.h>
#include <EEPROM.h>
#include <ESP8266WebServer.h>
#include <ESP8266WiFi.h>
#include <Servo.h>
#include <WebSocketsServer.h>

// ---------- Pin map (see /docs for rationale) ----------
// D3/D4 double as ESP8266 boot-strapping pins; firmware clears them to LOW as
// its very first action in setup() to keep motors off until commanded. See plan
// doc for why an external pull-down resistor must NOT be added here (it can
// prevent normal boot). D8 (GPIO15) is also a boot-strapping pin, but the
// opposite case: it must be LOW at boot, and NodeMCU boards already have a
// pull-down on it for that reason. A servo signal wire is a high-impedance
// input until driven, so it doesn't fight that pull-down
// -- safe to use for the 3rd servo, unlike D3/D4 which need to be HIGH at boot.
const uint8_t PIN_SERVO_BASE = D1;
const uint8_t PIN_SERVO_GRIPPER = D2;
const uint8_t PIN_SERVO_LIFT = D8;
const uint8_t PIN_MOTOR_L_IN1 = D5;
const uint8_t PIN_MOTOR_L_IN2 = D6;
const uint8_t PIN_MOTOR_R_IN1 = D7;
const uint8_t PIN_MOTOR_R_IN2 = D0;
const uint8_t PIN_MOTOR_L_EN = D4;
const uint8_t PIN_MOTOR_R_EN = D3;

const unsigned long COMMAND_TIMEOUT_MS = 400;
const int PWM_MAX = 1023; // ESP8266 analogWrite range is 0-1023, not 0-255

const int SERVO_BASE_MIN_DEG = 0;
const int SERVO_BASE_MAX_DEG = 180;
const int SERVO_BASE_HOME_DEG = 90;
const int SERVO_LIFT_MIN_DEG = 0;
const int SERVO_LIFT_MAX_DEG = 180;
const int SERVO_LIFT_HOME_DEG = 90;
const int GRIPPER_OPEN_DEG = 20;
const int GRIPPER_CLOSED_DEG = 110;

WebSocketsServer webSocket(81);
Servo baseServo;
Servo gripperServo;
Servo liftServo;

unsigned long lastCommandMillis = 0;
bool motorsStopped = true;

// --- AP Mode & Config Portal ---
const byte DNS_PORT = 53;
DNSServer dnsServer;
ESP8266WebServer webServer(80);

enum DeviceState { STATE_CONNECTING, STATE_CONNECTED, STATE_AP_MODE };

DeviceState deviceState = STATE_CONNECTING;
unsigned long wifiConnectStartMillis = 0;
unsigned long wifiDisconnectStartMillis = 0;
bool wifiDisconnected = false;

char savedSsid[33] = "";
char savedPassword[65] = "";

struct WifiConfig {
  char magic[4]; // "WCFG"
  char ssid[33];
  char password[65];
};

void saveConfig(const char *ssid, const char *password) {
  WifiConfig config;
  memcpy(config.magic, "WCFG", 4);
  strncpy(config.ssid, ssid, sizeof(config.ssid) - 1);
  config.ssid[sizeof(config.ssid) - 1] = '\0';
  strncpy(config.password, password, sizeof(config.password) - 1);
  config.password[sizeof(config.password) - 1] = '\0';

  EEPROM.begin(512);
  EEPROM.put(0, config);
  EEPROM.commit();
  EEPROM.end();
}

bool loadConfig(char *ssid, char *password) {
  EEPROM.begin(512);
  WifiConfig config;
  EEPROM.get(0, config);
  EEPROM.end();

  if (strncmp(config.magic, "WCFG", 4) == 0) {
    strcpy(ssid, config.ssid);
    strcpy(password, config.password);
    return true;
  }
  return false;
}

void stopMotors() {
  analogWrite(PIN_MOTOR_L_EN, 0);
  analogWrite(PIN_MOTOR_R_EN, 0);
  digitalWrite(PIN_MOTOR_L_IN1, LOW);
  digitalWrite(PIN_MOTOR_L_IN2, LOW);
  digitalWrite(PIN_MOTOR_R_IN1, LOW);
  digitalWrite(PIN_MOTOR_R_IN2, LOW);
  motorsStopped = true;
  // Arm servos deliberately hold their last commanded position on stop/timeout
  // rather than snapping to a home pose -- see plan doc's failsafe design
  // section.
}

void setMotor(uint8_t in1, uint8_t in2, uint8_t enPin, float value) {
  value = constrain(value, -1.0f, 1.0f);
  if (value > 0.02f) {
    digitalWrite(in1, HIGH);
    digitalWrite(in2, LOW);
  } else if (value < -0.02f) {
    digitalWrite(in1, LOW);
    digitalWrite(in2, HIGH);
  } else {
    digitalWrite(in1, LOW);
    digitalWrite(in2, LOW);
  }
  analogWrite(enPin, (int)(fabs(value) * PWM_MAX));
}

void applyDrive(float linear, float angular) {
  linear = constrain(linear, -1.0f, 1.0f);
  angular = constrain(angular, -1.0f, 1.0f);
  float left = constrain(linear + angular, -1.0f, 1.0f);
  float right = constrain(linear - angular, -1.0f, 1.0f);
  setMotor(PIN_MOTOR_L_IN1, PIN_MOTOR_L_IN2, PIN_MOTOR_L_EN, left);
  setMotor(PIN_MOTOR_R_IN1, PIN_MOTOR_R_IN2, PIN_MOTOR_R_EN, right);
  motorsStopped = false;
}

void applyArm(JsonVariantConst arm, JsonVariantConst gripper) {
  if (!arm.isNull()) {
    int baseDeg = arm["base"] | SERVO_BASE_HOME_DEG;
    baseDeg = constrain(baseDeg, SERVO_BASE_MIN_DEG, SERVO_BASE_MAX_DEG);
    baseServo.write(baseDeg);

    int liftDeg = arm["lift"] | SERVO_LIFT_HOME_DEG;
    liftDeg = constrain(liftDeg, SERVO_LIFT_MIN_DEG, SERVO_LIFT_MAX_DEG);
    liftServo.write(liftDeg);
  }
  if (!gripper.isNull()) {
    float g = constrain(gripper.as<float>(), 0.0f, 1.0f);
    int deg =
        GRIPPER_OPEN_DEG + (int)(g * (GRIPPER_CLOSED_DEG - GRIPPER_OPEN_DEG));
    gripperServo.write(deg);
  }
}

void handleCommand(uint8_t *payload, size_t length) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload, length);
  if (err)
    return; // malformed/oversized payload -- ignore rather than propagate

  const char *type = doc["type"] | "";
  lastCommandMillis = millis();

  if (strcmp(type, "stop") == 0) {
    stopMotors();
    Serial.println("[cmd] STOP received");
    return;
  }
  if (strcmp(type, "control") == 0) {
    JsonVariantConst drive = doc["drive"];
    float linear = 0.0f;
    float angular = 0.0f;
    if (!drive.isNull()) {
      linear = drive["linear"] | 0.0f;
      angular = drive["angular"] | 0.0f;
      applyDrive(linear, angular);
    }
    applyArm(doc["arm"], doc["gripper"]);

    // Print command details to Serial for debugging/bench testing
    Serial.printf("[cmd] Drive: lin=%.2f ang=%.2f", linear, angular);
    if (!doc["arm"].isNull()) {
      Serial.printf(" | Arm Base: %d Lift: %d", doc["arm"]["base"].as<int>(),
                    doc["arm"]["lift"].as<int>());
    }
    if (!doc["gripper"].isNull()) {
      Serial.printf(" | Gripper: %.2f", doc["gripper"].as<float>());
    }
    Serial.println();
  }
}

void onWsEvent(uint8_t num, WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
  case WStype_CONNECTED:
    Serial.printf("[ws] client #%u connected\n", num);
    lastCommandMillis = millis(); // grace period before the watchdog can fire
    break;
  case WStype_DISCONNECTED:
    Serial.printf("[ws] client #%u disconnected\n", num);
    break;
  case WStype_TEXT:
    handleCommand(payload, length);
    break;
  default:
    break;
  }
}

bool isIp(String str) {
  for (size_t i = 0; i < str.length(); i++) {
    int c = str.charAt(i);
    if (c != '.' && (c < '0' || c > '9'))
      return false;
  }
  return true;
}

String toStringIp(IPAddress ip) {
  return String(ip[0]) + "." + String(ip[1]) + "." + String(ip[2]) + "." +
         String(ip[3]);
}

bool captivePortalRedirect() {
  if (!isIp(webServer.hostHeader()) &&
      webServer.hostHeader() != "robot.local") {
    Serial.println("[AP] Redirecting request to captive portal");
    webServer.sendHeader("Location", "http://" + toStringIp(WiFi.softAPIP()),
                         true);
    webServer.send(302, "text/plain", "");
    return true;
  }
  return false;
}

void handleRoot() {
  if (captivePortalRedirect())
    return;

  Serial.println("[AP] Serving config page");

  // Scan networks
  int numNetworks = WiFi.scanNetworks();
  String networksHtml = "";
  for (int i = 0; i < numNetworks; i++) {
    networksHtml += "<option value=\"" + WiFi.SSID(i) + "\">";
  }

  String html = R"raw(
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Robot Config Portal</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #121214; color: #e1e1e6; padding: 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #202024; padding: 30px; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); width: 100%; max-width: 360px; box-sizing: border-box; }
    h2 { margin-top: 0; color: #00e676; text-align: center; }
    label { display: block; margin: 15px 0 5px; font-weight: 500; font-size: 14px; }
    input { width: 100%; padding: 10px; background: #121214; border: 1px solid #323238; border-radius: 6px; color: #fff; box-sizing: border-box; font-size: 16px; margin-bottom: 10px; }
    button { width: 100%; padding: 12px; background: #00e676; border: none; border-radius: 6px; color: #121214; font-weight: bold; font-size: 16px; cursor: pointer; margin-top: 15px; transition: background 0.2s; }
    button:hover { background: #00b359; }
    .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #7c7c8a; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Robot Config Portal</h2>
    <form action="/save" method="POST">
      <label for="ssid">WiFi Network (SSID)</label>
      <input type="text" id="ssid" name="ssid" placeholder="Enter WiFi SSID" required list="networks">
      <datalist id="networks">
  )raw";
  html += networksHtml;
  html += R"raw(
      </datalist>
      <label for="password">Password</label>
      <input type="password" id="password" name="password" placeholder="Enter password">
      <button type="submit">Save and Connect</button>
    </form>
  </div>
  <div class="footer">Robot Control POC &bull; Meta Quest 2 Teleoperation</div>
</body>
</html>
  )raw";

  webServer.send(200, "text/html", html);
}

void handleSave() {
  String ssid = webServer.arg("ssid");
  String password = webServer.arg("password");

  Serial.println("[AP] Saving WiFi credentials:");
  Serial.printf("[AP] SSID: %s\n", ssid.c_str());

  saveConfig(ssid.c_str(), password.c_str());

  String html = R"raw(
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Credentials Saved</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #121214; color: #e1e1e6; padding: 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #202024; padding: 30px; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); width: 100%; max-width: 360px; box-sizing: border-box; text-align: center; }
    h2 { margin-top: 0; color: #00e676; }
    p { margin-bottom: 20px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Configuration Saved</h2>
    <p>The robot is now restarting and attempting to connect to <strong>)raw";
  html += ssid;
  html += R"raw(</strong>.</p>
    <p>Please connect your control client or server to the new LAN IP once connected.</p>
  </div>
</body>
</html>
  )raw";

  webServer.send(200, "text/html", html);
  delay(1000);
  ESP.restart();
}

void startAP() {
  deviceState = STATE_AP_MODE;
  stopMotors();

  Serial.println("\n[AP] Starting access point mode...");
  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(IPAddress(192, 168, 4, 1), IPAddress(192, 168, 4, 1),
                    IPAddress(255, 255, 255, 0));

  bool apSuccess = WiFi.softAP("Robot-Control-POC");
  if (apSuccess) {
    Serial.println("[AP] SSID: Robot-Control-POC");
    Serial.print("[AP] IP: ");
    Serial.println(WiFi.softAPIP());
  } else {
    Serial.println("[AP] Failed to start softAP!");
  }

  dnsServer.start(DNS_PORT, "*", WiFi.softAPIP());

  webServer.on("/", HTTP_GET, handleRoot);
  webServer.on("/save", HTTP_POST, handleSave);
  webServer.onNotFound([]() {
    if (captivePortalRedirect())
      return;
    webServer.send(404, "text/plain", "Not Found");
  });
  webServer.begin();
  Serial.println("[AP] HTTP server and Captive Portal active");
}

void setup() {
  // Motor pins config first
  pinMode(PIN_MOTOR_L_IN1, OUTPUT);
  pinMode(PIN_MOTOR_L_IN2, OUTPUT);
  pinMode(PIN_MOTOR_R_IN1, OUTPUT);
  pinMode(PIN_MOTOR_R_IN2, OUTPUT);
  pinMode(PIN_MOTOR_L_EN, OUTPUT);
  pinMode(PIN_MOTOR_R_EN, OUTPUT);
  stopMotors();

  Serial.begin(115200);

  baseServo.attach(PIN_SERVO_BASE);
  gripperServo.attach(PIN_SERVO_GRIPPER);
  liftServo.attach(PIN_SERVO_LIFT);
  baseServo.write(SERVO_BASE_HOME_DEG);
  gripperServo.write(GRIPPER_OPEN_DEG);
  liftServo.write(SERVO_LIFT_HOME_DEG);

  // Load saved credentials
  bool loaded = loadConfig(savedSsid, savedPassword);
  if (!loaded || strlen(savedSsid) == 0) {
    // Check if secrets.h has actual config (not placeholder)
    if (strcmp(WIFI_SSID, "your-wifi-name") != 0 && strlen(WIFI_SSID) > 0) {
      Serial.println("[STA] Saving defaults from secrets.h to EEPROM");
      strcpy(savedSsid, WIFI_SSID);
      strcpy(savedPassword, WIFI_PASSWORD);
      saveConfig(savedSsid, savedPassword);
      loaded = true;
    }
  }

  if (loaded && strlen(savedSsid) > 0) {
    Serial.printf("\n[STA] Config found. Connecting to SSID: %s\n", savedSsid);
    WiFi.mode(WIFI_STA);
    WiFi.begin(savedSsid, savedPassword);
    deviceState = STATE_CONNECTING;
    wifiConnectStartMillis = millis();
  } else {
    Serial.println("\n[STA] No WiFi config found. Starting AP config portal.");
    startAP();
  }

  webSocket.begin();
  webSocket.onEvent(onWsEvent);

  lastCommandMillis = millis();
}

void loop() {
  if (deviceState == STATE_CONNECTED) {
    webSocket.loop();

    // Independent watchdog: check control command staleness
    if (!motorsStopped && millis() - lastCommandMillis > COMMAND_TIMEOUT_MS) {
      stopMotors();
      Serial.println("[watchdog] command timeout, motors stopped");
    }

    // Monitor WiFi status
    if (WiFi.status() != WL_CONNECTED) {
      if (!wifiDisconnected) {
        wifiDisconnected = true;
        wifiDisconnectStartMillis = millis();
        Serial.println("[STA] Connection lost. Monitoring for timeout...");
      } else if (millis() - wifiDisconnectStartMillis >
                 30000) { // 30s timeout before falling back to AP
        Serial.println(
            "[STA] Connection lost for 30s. Falling back to AP mode...");
        wifiDisconnected = false;
        startAP();
      }
    } else {
      wifiDisconnected = false;
    }

  } else if (deviceState == STATE_CONNECTING) {
    if (WiFi.status() == WL_CONNECTED) {
      deviceState = STATE_CONNECTED;
      Serial.println("\n[STA] Connected successfully!");
      Serial.print("[STA] IP address: ");
      Serial.println(WiFi.localIP());
      lastCommandMillis = millis();
    } else if (millis() - wifiConnectStartMillis > 30000) { // 30s timeout
      Serial.println("\n[STA] Connection failed to connect in 30s. Falling "
                     "back to AP mode.");
      startAP();
    } else {
      // Print dot every 500ms to show progress
      static unsigned long lastDot = 0;
      if (millis() - lastDot > 500) {
        lastDot = millis();
        Serial.print(".");
      }
    }

  } else if (deviceState == STATE_AP_MODE) {
    dnsServer.processNextRequest();
    webServer.handleClient();
  }
}
