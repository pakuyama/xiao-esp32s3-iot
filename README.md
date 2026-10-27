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
**백엔드 (Render)** — GitHub 저장소 기준 (Git Bash에서 실행 시 `export MSYS_NO_PATHCONV=1` 필수: `/api/health` 경로가 Windows 경로로 바뀌는 문제)
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

## 배포 주소
- 대시보드: https://xiao-iot-dashboard-eight.vercel.app
- API: https://xiao-iot-api-3uh2.onrender.com (Swagger: `/docs`)

---

# 📷 카메라 데이터 수집 (XIAO ESP32S3 Sense → Edge Impulse)

```
[XIAO ESP32S3 Sense] --HTTPS JPEG push--> [FastAPI @ Render] <--> [Supabase Storage: dataset 버킷]
                                                 ^ 롱폴링(실시간 영상) / 촬영 / ZIP
                         [camera.html @ Vercel] -+
```

ESP32가 프레임을 서버로 계속 보내고(대시보드가 보고 있을 때 최대 속도, 아니면 3초마다 1장),
서버는 디바이스별 **최신 프레임만 메모리에** 보관합니다. 촬영 버튼을 누르면 그 이후 도착한 프레임을
`dataset/{user_id}/{클래스}/{클래스}.{시각}.jpg` 로 저장 → 파일명 앞부분이 Edge Impulse 라벨로 인식됩니다.

## 사용법
1. 대시보드 로그인 → 상단 **📷 카메라 수집** (`camera.html`)
2. 카메라용 디바이스 추가 → **ESP32 펌웨어 설정값**을 `camera/firmware/xiao_cam/secrets.h` 에 복사
   (`secrets.example.h` 참고, WiFi 도 입력)
3. 업로드 (**PSRAM=opi 필수**)
   ```powershell
   arduino-cli compile -b esp32:esp32:XIAO_ESP32S3:PSRAM=opi camera/firmware/xiao_cam
   arduino-cli upload  -b esp32:esp32:XIAO_ESP32S3:PSRAM=opi -p COM4 camera/firmware/xiao_cam
   ```
4. 클래스 추가(영문/숫자/_/-) → 촬영

| 기능 | 방법 |
|---|---|
| 촬영 / 연속 촬영 | `Space` / `B` (장수·간격 설정, 다시 `B` 또는 `Esc` 로 중지) |
| 클래스 선택 | 클릭 또는 `1`~`9` |
| 잘못 찍은 사진 삭제 | 썸네일 클릭(Shift+클릭 범위) → `Del` / 썸네일의 × |
| 다운로드 | 클래스별 ZIP, 전체 ZIP (`{클래스}/{파일}.jpg` 구조) |
| 카메라 설정 | 해상도(96×96~640×480), JPEG 화질, 상하/좌우 반전 → ESP32 에 즉시 반영 |

## API (카메라)
| Method | Path | 인증 | 설명 |
|---|---|---|---|
| POST | `/api/device/frame` | X-Device-Key | (ESP32) JPEG 업로드 → `{active, framesize, quality, vflip, hmirror}` |
| GET | `/api/devices/{id}/frame?after=seq` | Bearer | 새 프레임 롱폴링 (최대 8초, 없으면 204, `X-Frame-Seq` 헤더) |
| GET/PUT | `/api/devices/{id}/camera` | Bearer | 상태 / 카메라 설정 |
| POST | `/api/devices/{id}/capture` | Bearer | `{label}` 촬영 → Storage 저장 |
| GET | `/api/dataset` | Bearer | 클래스별 개수 |
| GET | `/api/dataset/{label}` | Bearer | 이미지 목록 (1시간 서명 URL) |
| POST | `/api/dataset/{label}/delete` | Bearer | `{names: [...]}` 선택 삭제 |
| DELETE | `/api/dataset/{label}` | Bearer | 클래스 전체 삭제 |
| GET | `/api/dataset/{label}/zip`, `/api/dataset-zip` | Bearer | ZIP 다운로드 |

> `dataset` 버킷은 백엔드 시작 시 자동 생성(비공개)되므로 Supabase 에서 따로 할 일은 없습니다.
> 프레임은 서버 메모리에만 있으므로 Render 는 인스턴스 1개(무료 플랜 기본)로 운영해야 합니다.
