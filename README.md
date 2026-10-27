# XIAO ESP32S3 IoT (FastAPI + Supabase + Vercel + Render)

```
[XIAO ESP32S3] --HTTPS 폴링--> [FastAPI @ Render] <--> [Supabase (Auth + Postgres)]
                                      ^
                  [웹 대시보드 @ Vercel] --HTTPS--+
```

ESP32가 **먼저 서버로 요청**(1초마다 LED 상태 조회, 5초마다 센서 업로드)하는 구조라
포트포워딩 없이 **다른 네트워크(LTE, 다른 WiFi)에서도 제어**됩니다.

| 폴더 | 내용 |
|---|---|
| `backend/` | FastAPI 서버 (`main.py`) |
| `frontend/` | 정적 웹 대시보드 (로그인/회원가입, 센서 차트, LED 토글, API 로그) |
| `firmware/xiao_iot/` | Arduino 스케치 (XIAO ESP32S3) |
| `supabase/schema.sql` | 테이블 생성 SQL |

## 1. Supabase
1. 프로젝트 생성 → **SQL Editor**에서 `supabase/schema.sql` 실행
2. **Project Settings → API**에서 URL, anon(publishable) 키, service_role(secret) 키 확인
3. `backend/.env.example` → `backend/.env` 로 복사 후 값 입력

## 2. 백엔드 로컬 실행
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
.\.venv\Scripts\uvicorn main:app --reload
```
Swagger: http://127.0.0.1:8000/docs

## 3. API
| Method | Path | 인증 | 설명 |
|---|---|---|---|
| POST | `/api/auth/signup` | - | 회원가입 `{email, password}` (이메일 인증 생략) |
| POST | `/api/auth/login` | - | 로그인 → `access_token` |
| GET | `/api/auth/me` | Bearer | 내 정보 |
| GET/POST | `/api/devices` | Bearer | 디바이스 목록 / 등록 `{name}` → `device_key` 발급 |
| DELETE | `/api/devices/{id}` | Bearer | 디바이스 삭제 |
| GET | `/api/devices/{id}/readings?limit=50` | Bearer | 센서 기록 |
| PUT | `/api/devices/{id}/led` | Bearer | LED 제어 `{on: true}` |
| GET | `/api/device/led` | X-Device-Key | (ESP32) LED 상태 조회 |
| POST | `/api/device/readings` | X-Device-Key | (ESP32) 센서 업로드 `{temperature, analog}` |

## 4. 펌웨어 (XIAO ESP32S3)
1. `firmware/xiao_iot/secrets.example.h` → `secrets.h` 로 복사
2. WiFi 정보 + 대시보드의 **"ESP32 펌웨어 설정값"** (API_BASE, DEVICE_KEY) 입력
3. Arduino IDE 보드: **XIAO_ESP32S3** (esp32 코어 3.x) → 업로드

> ⚠️ 폴더 경로에 괄호 `( )` 가 있으면 esp32 코어 빌드가 실패합니다
> (`bootloader.bin은(는) 예상되지 않았습니다`). `C:\xiao_iot` 처럼 괄호 없는 곳에 복사해서 빌드하세요.
>
> ```powershell
> arduino-cli compile -b esp32:esp32:XIAO_ESP32S3 C:\xiao_iot
> arduino-cli upload  -b esp32:esp32:XIAO_ESP32S3 -p COM5 C:\xiao_iot
> ```

- 센서: 칩 내부 온도(`temperatureRead`) + A0 아날로그 입력 (가변저항·조도센서 연결 가능, 미연결 시 노이즈값)
- LED: 보드 내장 USER LED (GPIO21, active-low). 외부 LED는 `LED_PIN`, `LED_ACTIVE_LOW` 수정

## 5. 배포
**백엔드 (Render)** — GitHub 저장소 기준
```powershell
render login
render services create --name xiao-iot-api --type web_service --runtime python `
  --repo <GitHub URL> --branch main --root-directory backend --plan free --region singapore `
  --build-command "pip install -r requirements.txt" `
  --start-command "uvicorn main:app --host 0.0.0.0 --port `$PORT" `
  --health-check-path /api/health `
  --env-var SUPABASE_URL=... --env-var SUPABASE_ANON_KEY=... --env-var SUPABASE_SERVICE_KEY=... `
  --env-var CORS_ORIGINS=* --env-var PYTHON_VERSION=3.12.8 --confirm -o json
```

**프론트엔드 (Vercel)** — `frontend/config.js`의 `API_BASE`를 Render 주소로 바꾼 뒤
```powershell
cd frontend
vercel deploy --prod
```

> Render 무료 플랜은 15분간 요청이 없으면 잠듭니다. ESP32가 켜져 있으면 계속 요청하므로 깨어 있고,
> 꺼져 있을 땐 첫 요청에 30~60초 걸릴 수 있습니다.
