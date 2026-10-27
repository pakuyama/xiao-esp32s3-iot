// Seeed XIAO ESP32S3 Sense 카메라 → 클라우드 백엔드 (이미지 수집용)
//
// ESP32 가 서버로 JPEG 프레임을 계속 POST 하는 구조라 포트포워딩 없이,
// 대시보드와 다른 네트워크(LTE 등)에서도 실시간 영상 확인 + 촬영이 가능하다.
//   POST /api/device/frame  (X-Device-Key, body = JPEG)
//   응답 {"active":true,"framesize":6,"quality":12,"vflip":0,"hmirror":0}
//     - active   : 대시보드가 보고 있으면 true → 최대 속도로 전송, 아니면 IDLE_MS 마다 1장
//     - 나머지    : 대시보드에서 바꾼 카메라 설정 → 바로 반영
//
// 보드 설정: XIAO_ESP32S3, PSRAM = OPI PSRAM (필수)
//   arduino-cli compile -b esp32:esp32:XIAO_ESP32S3:PSRAM=opi camera/firmware/xiao_cam

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "esp_camera.h"
#include "secrets.h"

const unsigned long IDLE_MS = 3000;  // 아무도 안 볼 때 전송 간격 (온라인 표시 유지용)

// XIAO ESP32S3 Sense 카메라 핀
#define PWDN_GPIO_NUM  -1
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM  10
#define SIOD_GPIO_NUM  40
#define SIOC_GPIO_NUM  39
#define Y9_GPIO_NUM    48
#define Y8_GPIO_NUM    11
#define Y7_GPIO_NUM    12
#define Y6_GPIO_NUM    14
#define Y5_GPIO_NUM    16
#define Y4_GPIO_NUM    18
#define Y3_GPIO_NUM    17
#define Y2_GPIO_NUM    15
#define VSYNC_GPIO_NUM 38
#define HREF_GPIO_NUM  47
#define PCLK_GPIO_NUM  13

WiFiClientSecure tls;
HTTPClient http;
bool active = false;
unsigned long lastSend = 0, lastReport = 0;
int sent = 0;

bool initCamera() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM;  c.pin_d1 = Y3_GPIO_NUM;
  c.pin_d2 = Y4_GPIO_NUM;  c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM;  c.pin_d5 = Y7_GPIO_NUM;
  c.pin_d6 = Y8_GPIO_NUM;  c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM;
  c.pin_pclk = PCLK_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM;
  c.pin_href = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM;
  c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM;
  c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size = FRAMESIZE_QVGA;    // 320x240, 이후 대시보드 설정을 따름
  c.jpeg_quality = 12;              // 0~63, 낮을수록 고화질
  c.fb_count = 2;
  c.fb_location = CAMERA_FB_IN_PSRAM;
  c.grab_mode = CAMERA_GRAB_LATEST; // 항상 최신 프레임

  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) {
    Serial.printf("카메라 초기화 실패 0x%x (PSRAM=OPI 설정 확인)\n", err);
    return false;
  }
  return true;
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  while (WiFi.status() != WL_CONNECTED) {
    Serial.printf("WiFi 연결 중: %s", WIFI_SSID);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) {
      delay(500);
      Serial.print(".");
    }
    Serial.println(WiFi.status() == WL_CONNECTED ? " 연결됨 " + WiFi.localIP().toString() : " 실패, 재시도");
    if (WiFi.status() != WL_CONNECTED) WiFi.disconnect();
  }
}

// {"key":123} / {"key":true} 형태에서 값 읽기 (없으면 fallback)
int jsonInt(const String& body, const char* key, int fallback) {
  String k = String("\"") + key + "\":";
  int i = body.indexOf(k);
  if (i < 0) return fallback;
  String rest = body.substring(i + k.length());
  if (rest.startsWith("true")) return 1;
  if (rest.startsWith("false")) return 0;
  return rest.toInt();
}

void applySettings(const String& body) {
  active = jsonInt(body, "active", 0);
  sensor_t* s = esp_camera_sensor_get();
  int v;
  if ((v = jsonInt(body, "framesize", s->status.framesize)) != s->status.framesize) s->set_framesize(s, (framesize_t)v);
  if ((v = jsonInt(body, "quality", s->status.quality)) != s->status.quality) s->set_quality(s, v);
  if ((v = jsonInt(body, "vflip", s->status.vflip)) != s->status.vflip) s->set_vflip(s, v);
  if ((v = jsonInt(body, "hmirror", s->status.hmirror)) != s->status.hmirror) s->set_hmirror(s, v);
}

void sendFrame() {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("프레임 캡처 실패");
    return;
  }
  http.begin(tls, String(API_BASE) + "/api/device/frame");
  http.addHeader("X-Device-Key", DEVICE_KEY);
  http.addHeader("Content-Type", "image/jpeg");
  int code = http.POST(fb->buf, fb->len);
  size_t len = fb->len;
  esp_camera_fb_return(fb);
  String body = code > 0 ? http.getString() : "";
  http.end();

  if (code == 200) {
    applySettings(body);
    sent++;
  } else {
    Serial.printf("프레임 전송 실패: %d (%u bytes) %s\n", code, len, body.c_str());
    active = false;  // 서버가 잠들어 있으면(Render 무료) 깨어날 때까지 천천히 재시도
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  if (!initCamera()) {
    while (true) delay(1000);
  }
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);   // 전송 지연 줄이기
  connectWiFi();
  tls.setInsecure();      // 테스트용: 서버 인증서 검증 생략
  http.setReuse(true);    // keep-alive 로 TLS 핸드셰이크 반복 줄이기
  http.setTimeout(10000);
  Serial.printf("카메라 준비 완료 → %s\n", API_BASE);
}

void loop() {
  connectWiFi();
  if (millis() - lastSend >= (active ? 0 : IDLE_MS)) {
    lastSend = millis();
    sendFrame();
  }
  if (millis() - lastReport >= 10000) {
    Serial.printf("전송 %.1f fps, 대시보드 %s, RSSI %d\n",
                  sent / ((millis() - lastReport) / 1000.0), active ? "시청 중" : "대기", WiFi.RSSI());
    lastReport = millis();
    sent = 0;
  }
  delay(10);
}
