// Seeed XIAO ESP32S3 ↔ 클라우드 백엔드 (HTTP 폴링)
//
// ESP32 가 서버로 먼저 요청을 보내는 구조라 공유기 포트포워딩 없이,
// 대시보드와 다른 네트워크(LTE 등)에서도 LED 를 제어할 수 있다.
//   - LED_POLL_MS 마다  GET  /api/device/led       → LED 상태 반영
//   - UPLOAD_MS  마다  POST /api/device/readings  → 센서값 업로드
//
// 센서: 칩 내부 온도(temperatureRead) + A0(GPIO1) 아날로그 입력(가변저항/조도센서 등)
// LED : 보드 내장 주황색 USER LED (GPIO21, LOW 일 때 켜짐)

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "secrets.h"

#define LED_PIN        LED_BUILTIN   // 외부 LED 를 쓰려면 D0 등으로 변경
#define LED_ACTIVE_LOW true          // 외부 LED(핀→저항→LED→GND)면 false
#define ANALOG_PIN     A0

const unsigned long LED_POLL_MS = 1000;
const unsigned long UPLOAD_MS   = 5000;

WiFiClientSecure tls;
HTTPClient http;
unsigned long lastPoll = 0, lastUpload = 0;

void setLed(bool on) {
  digitalWrite(LED_PIN, (on ^ LED_ACTIVE_LOW) ? HIGH : LOW);
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("WiFi 연결 중: %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) {
    delay(500);
    Serial.print(".");
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? " 연결됨 " + WiFi.localIP().toString() : " 실패");
}

// 응답 본문을 받아 {"led":true|false} 를 해석해 LED 에 반영
void applyLed(const String& body) {
  if (body.indexOf("\"led\":true") >= 0) setLed(true);
  else if (body.indexOf("\"led\":false") >= 0) setLed(false);
}

// method: "GET" 또는 "POST". 성공 시 HTTP 코드, 실패 시 음수
int request(const char* method, const char* path, const String& payload, String& out) {
  http.begin(tls, String(API_BASE) + path);
  http.addHeader("X-Device-Key", DEVICE_KEY);
  int code;
  if (strcmp(method, "POST") == 0) {
    http.addHeader("Content-Type", "application/json");
    code = http.POST(payload);
  } else {
    code = http.GET();
  }
  out = code > 0 ? http.getString() : "";
  http.end();
  return code;
}

void pollLed() {
  String body;
  int code = request("GET", "/api/device/led", "", body);
  if (code == 200) applyLed(body);
  else Serial.printf("LED 폴링 실패: %d %s\n", code, body.c_str());
}

void uploadReading() {
  float temp = temperatureRead();
  int analog = analogRead(ANALOG_PIN);
  String payload = "{\"temperature\":" + String(temp, 1) + ",\"analog\":" + String(analog) + "}";
  String body;
  int code = request("POST", "/api/device/readings", payload, body);
  Serial.printf("업로드 %s → %d\n", payload.c_str(), code);
  if (code == 201) applyLed(body);
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  setLed(false);
  analogReadResolution(12);

  WiFi.mode(WIFI_STA);
  connectWiFi();

  tls.setInsecure();      // 테스트용: 서버 인증서 검증 생략
  http.setReuse(true);    // keep-alive 로 TLS 핸드셰이크 반복 줄이기
  http.setTimeout(15000); // Render 무료 플랜 콜드스타트 대비
}

void loop() {
  connectWiFi();
  if (WiFi.status() != WL_CONNECTED) {
    delay(2000);
    return;
  }

  unsigned long now = millis();
  if (now - lastUpload >= UPLOAD_MS || lastUpload == 0) {
    lastUpload = now;
    uploadReading();
  }
  if (now - lastPoll >= LED_POLL_MS) {
    lastPoll = now;
    pollLed();
  }
  delay(20);
}
