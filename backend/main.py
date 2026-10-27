"""XIAO ESP32S3 IoT 백엔드 (FastAPI + Supabase)

- 사용자: Supabase Auth 로 회원가입/로그인, Bearer 토큰으로 API 호출
- 디바이스(ESP32): X-Device-Key 헤더로 센서값 업로드 / LED 상태 폴링
  → ESP32 가 클라우드로 먼저 요청을 보내는 구조라 같은 WiFi 가 아니어도 제어 가능
- 카메라(XIAO ESP32S3 Sense): ESP32 가 JPEG 프레임을 push → 서버 메모리에 최신 프레임 보관(중계)
  → 대시보드가 실시간 영상 확인 + 클래스별 촬영, Supabase Storage 에 학습용 이미지 저장
"""
import asyncio
import io
import os
import re
import secrets
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field
from supabase import AuthApiError, Client, ClientOptions, create_client

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_ANON_KEY = os.environ["SUPABASE_ANON_KEY"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]

_NO_SESSION = ClientOptions(auto_refresh_token=False, persist_session=False)

# DB 접근 + 토큰 검증 + 관리자 기능 전용 (로그인에 쓰면 세션이 바뀌므로 절대 sign_in 하지 않음)
db: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY, _NO_SESSION)

app = FastAPI(title="XIAO ESP32S3 IoT API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Frame-Seq"],
)


# ---------- 스키마 ----------
class Credentials(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6)


class DeviceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=50)


class LedCommand(BaseModel):
    on: bool


class Reading(BaseModel):
    temperature: float | None = None
    analog: int | None = None


# ---------- 의존성 ----------
def current_user_id(authorization: str = Header(default="")) -> str:
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "로그인이 필요합니다")
    try:
        res = db.auth.get_user(authorization[7:])
    except AuthApiError:
        res = None
    if not res or not res.user:
        raise HTTPException(401, "토큰이 만료되었거나 올바르지 않습니다")
    return res.user.id


def current_device(x_device_key: str = Header(default="")) -> dict:
    rows = db.table("devices").select("*").eq("device_key", x_device_key).limit(1).execute().data
    if not x_device_key or not rows:
        raise HTTPException(401, "디바이스 키가 올바르지 않습니다")
    return rows[0]


def owned_device(device_id: str, user_id: str = Depends(current_user_id)) -> dict:
    rows = (
        db.table("devices").select("*")
        .eq("id", device_id).eq("owner_id", user_id).limit(1).execute().data
    )
    if not rows:
        raise HTTPException(404, "디바이스를 찾을 수 없습니다")
    return rows[0]


# ---------- 공통 ----------
@app.get("/")
@app.get("/api/health")
def health():
    return {"status": "ok"}


# ---------- 인증 ----------
@app.post("/api/auth/signup", status_code=201)
def signup(body: Credentials):
    # 관리자 API 로 생성 + 이메일 확인 생략 → 테스트용으로 바로 로그인 가능
    try:
        res = db.auth.admin.create_user(
            {"email": body.email, "password": body.password, "email_confirm": True}
        )
    except AuthApiError as e:
        raise HTTPException(409 if "already" in e.message else 400, e.message)
    return {"id": res.user.id, "email": res.user.email}


@app.post("/api/auth/login")
def login(body: Credentials):
    auth_client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY, _NO_SESSION)
    try:
        res = auth_client.auth.sign_in_with_password({"email": body.email, "password": body.password})
    except AuthApiError:
        raise HTTPException(401, "이메일 또는 비밀번호가 올바르지 않습니다")
    return {
        "access_token": res.session.access_token,
        "token_type": "bearer",
        "expires_in": res.session.expires_in,
        "user": {"id": res.user.id, "email": res.user.email},
    }


@app.get("/api/auth/me")
def me(user_id: str = Depends(current_user_id)):
    user = db.auth.admin.get_user_by_id(user_id).user
    return {"id": user.id, "email": user.email}


# ---------- 디바이스 관리 (사용자) ----------
@app.get("/api/devices")
def list_devices(user_id: str = Depends(current_user_id)):
    return (
        db.table("devices").select("*")
        .eq("owner_id", user_id).order("created_at").execute().data
    )


@app.post("/api/devices", status_code=201)
def create_device(body: DeviceCreate, user_id: str = Depends(current_user_id)):
    row = {"owner_id": user_id, "name": body.name, "device_key": secrets.token_urlsafe(24)}
    return db.table("devices").insert(row).execute().data[0]


@app.delete("/api/devices/{device_id}", status_code=204)
def delete_device(device: dict = Depends(owned_device)):
    db.table("devices").delete().eq("id", device["id"]).execute()


@app.get("/api/devices/{device_id}/readings")
def list_readings(device: dict = Depends(owned_device), limit: int = Query(50, ge=1, le=500)):
    return (
        db.table("sensor_readings").select("temperature, analog, created_at")
        .eq("device_id", device["id"]).order("created_at", desc=True).limit(limit).execute().data
    )


@app.put("/api/devices/{device_id}/led")
def set_led(body: LedCommand, device: dict = Depends(owned_device)):
    db.table("devices").update({"led_on": body.on}).eq("id", device["id"]).execute()
    return {"led": body.on}


# ---------- ESP32 전용 ----------
@app.get("/api/device/led")
def device_led(device: dict = Depends(current_device)):
    return {"led": device["led_on"]}


@app.post("/api/device/readings", status_code=201)
def device_upload(body: Reading, device: dict = Depends(current_device)):
    db.table("sensor_readings").insert({"device_id": device["id"], **body.model_dump()}).execute()
    db.table("devices").update(
        {"last_seen": datetime.now(timezone.utc).isoformat()}
    ).eq("id", device["id"]).execute()
    return {"led": device["led_on"]}


# ---------- 카메라 중계 + 데이터셋 (XIAO ESP32S3 Sense) ----------
# ESP32 → POST /api/device/frame 으로 JPEG 를 계속 push, 서버는 디바이스별 최신 프레임만 메모리에 보관.
# 대시보드는 롱폴링으로 새 프레임을 받아 영상처럼 보여주고, 촬영 시 Storage 에 저장한다.
# 저장 경로: dataset/{user_id}/{label}/{label}.{시각}.jpg  (Edge Impulse 가 파일명 앞부분을 라벨로 인식)
BUCKET = "dataset"
LABEL_PATTERN = r"^[A-Za-z0-9_-]{1,40}$"
MAX_FRAME_BYTES = 300_000
VIEWER_TTL = 15   # 초: 최근에 대시보드가 영상을 봤으면 ESP32 가 빠르게 전송
FRAME_WAIT = 8    # 초: 롱폴링 최대 대기

try:
    db.storage.get_bucket(BUCKET)
except Exception:
    db.storage.create_bucket(BUCKET, options={"public": False})


def bucket():
    return db.storage.from_(BUCKET)


# 프레임은 초당 여러 번 오고 영상 롱폴링도 계속 돌기 때문에 인증 조회 결과를 잠깐 캐시
_cache: dict[str, tuple[float, object]] = {}


def cached(key: str, ttl: float, load):
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < ttl:
        return hit[1]
    value = load()
    _cache[key] = (time.monotonic(), value)
    return value


def camera_device(x_device_key: str = Header(default="")) -> dict:
    return cached(f"dev:{x_device_key}", 60, lambda: current_device(x_device_key))


def cached_user_id(authorization: str = Header(default="")) -> str:
    return cached(f"user:{authorization}", 60, lambda: current_user_id(authorization))


def owned_camera(device_id: str, user_id: str = Depends(cached_user_id)) -> dict:
    return cached(f"own:{user_id}:{device_id}", 60, lambda: owned_device(device_id, user_id))


def check_label(label: str) -> str:
    if not re.fullmatch(LABEL_PATTERN, label):
        raise HTTPException(400, "클래스 이름은 영문/숫자/_/- 만 사용할 수 있습니다 (최대 40자)")
    return label


@dataclass
class Camera:
    frame: bytes = b""
    seq: int = 0
    at: float = 0.0          # 마지막 프레임 수신 시각 (monotonic)
    viewer_at: float = 0.0   # 마지막으로 대시보드가 영상을 요청한 시각
    # framesize: 0=96x96, 1=160x120, 5=240x240, 6=320x240(QVGA), 8=400x296, 10=640x480
    settings: dict = field(default_factory=lambda: {"framesize": 6, "quality": 12, "vflip": 0, "hmirror": 0})
    cond: asyncio.Condition = field(default_factory=asyncio.Condition)


cameras: dict[str, Camera] = {}


def camera(device_id: str) -> Camera:
    return cameras.setdefault(device_id, Camera())


def camera_status(cam: Camera) -> dict:
    age = time.monotonic() - cam.at if cam.seq else None
    return {
        "online": age is not None and age < 10,
        "seq": cam.seq,
        "frame_age": round(age, 1) if age is not None else None,
        "settings": cam.settings,
    }


async def wait_frame(cam: Camera, after: int, timeout: float) -> bool:
    """seq 가 after 보다 큰 프레임이 올 때까지 대기"""
    try:
        async with cam.cond:
            await asyncio.wait_for(cam.cond.wait_for(lambda: cam.seq > after), timeout)
        return True
    except TimeoutError:
        return False


class CameraSettings(BaseModel):
    framesize: int = Field(ge=0, le=10)
    quality: int = Field(ge=4, le=63)
    vflip: bool = False
    hmirror: bool = False


class CaptureRequest(BaseModel):
    label: str = Field(pattern=LABEL_PATTERN)


class DeleteImages(BaseModel):
    names: list[str] = Field(min_length=1, max_length=1000)


@app.post("/api/device/frame")
async def device_frame(request: Request, device: dict = Depends(camera_device)):
    data = await request.body()
    if not data.startswith(b"\xff\xd8") or len(data) > MAX_FRAME_BYTES:
        raise HTTPException(400, "JPEG 프레임(300KB 이하)만 받을 수 있습니다")
    cam = camera(device["id"])
    async with cam.cond:
        cam.frame, cam.seq, cam.at = data, cam.seq + 1, time.monotonic()
        cam.cond.notify_all()
    # ESP32 는 응답의 active 로 전송 속도를, 나머지 값으로 카메라 설정을 맞춘다
    return {"active": time.monotonic() - cam.viewer_at < VIEWER_TTL, **cam.settings}


@app.get("/api/devices/{device_id}/camera")
async def get_camera(device: dict = Depends(owned_camera)):
    return camera_status(camera(device["id"]))


@app.put("/api/devices/{device_id}/camera")
async def set_camera(body: CameraSettings, device: dict = Depends(owned_camera)):
    cam = camera(device["id"])
    cam.settings = {k: int(v) for k, v in body.model_dump().items()}
    return camera_status(cam)


@app.get("/api/devices/{device_id}/frame")
async def get_frame(after: int = Query(0, ge=0), device: dict = Depends(owned_camera)):
    cam = camera(device["id"])
    cam.viewer_at = time.monotonic()
    if after > cam.seq:  # 서버 재시작으로 seq 가 초기화된 경우
        after = 0
    if not await wait_frame(cam, after, FRAME_WAIT):
        return Response(status_code=204)
    return Response(
        cam.frame, media_type="image/jpeg",
        headers={"X-Frame-Seq": str(cam.seq), "Cache-Control": "no-store"},
    )


@app.post("/api/devices/{device_id}/capture", status_code=201)
async def capture(
    body: CaptureRequest,
    device: dict = Depends(owned_camera),
    user_id: str = Depends(cached_user_id),
):
    cam = camera(device["id"])
    cam.viewer_at = time.monotonic()
    # 요청 이후에 도착한 프레임을 저장 → 연속 촬영 시 같은 사진이 중복 저장되지 않음
    if not await wait_frame(cam, cam.seq, 5):
        raise HTTPException(503, "카메라 프레임이 들어오지 않습니다 (ESP32 전원/WiFi 확인)")
    data = cam.frame
    now = datetime.now(timezone.utc)
    name = f"{body.label}.{now:%Y%m%d-%H%M%S}-{now.microsecond // 1000:03d}.jpg"
    path = f"{user_id}/{body.label}/{name}"
    await asyncio.to_thread(bucket().upload, path, data, {"content-type": "image/jpeg"})
    url = (await asyncio.to_thread(signed_urls, [path]))[0]
    return {"label": body.label, "name": name, "url": url, "size": len(data)}


def list_files(prefix: str) -> list[dict]:
    """폴더 바로 아래 항목 전체 (최신 파일명 순). 하위 폴더는 id 가 None"""
    out, offset = [], 0
    while True:
        page = bucket().list(prefix, {
            "limit": 1000, "offset": offset, "sortBy": {"column": "name", "order": "desc"},
        })
        out += page
        if len(page) < 1000:
            return out
        offset += 1000


def image_names(user_id: str, label: str) -> list[str]:
    return [f["name"] for f in list_files(f"{user_id}/{label}") if f.get("id")]


def signed_urls(paths: list[str]) -> list[str | None]:
    if not paths:
        return []
    return [r["signedURL"] for r in bucket().create_signed_urls(paths, 3600)]


@app.get("/api/dataset")
def dataset_summary(user_id: str = Depends(cached_user_id)):
    labels = sorted(f["name"] for f in list_files(user_id) if f.get("id") is None)
    with ThreadPoolExecutor(8) as ex:
        counts = list(ex.map(lambda label: len(image_names(user_id, label)), labels))
    return [{"label": label, "count": count} for label, count in zip(labels, counts)]


@app.get("/api/dataset/{label}")
def dataset_images(label: str, user_id: str = Depends(cached_user_id)):
    names = image_names(user_id, check_label(label))
    urls = signed_urls([f"{user_id}/{label}/{n}" for n in names])
    return [{"name": n, "url": u} for n, u in zip(names, urls)]


@app.post("/api/dataset/{label}/delete")
def delete_images(label: str, body: DeleteImages, user_id: str = Depends(cached_user_id)):
    check_label(label)
    paths = [f"{user_id}/{label}/{n}" for n in body.names if "/" not in n]
    bucket().remove(paths)
    return {"deleted": len(paths)}


@app.delete("/api/dataset/{label}", status_code=204)
def delete_label(label: str, user_id: str = Depends(cached_user_id)):
    paths = [f"{user_id}/{label}/{n}" for n in image_names(user_id, check_label(label))]
    for i in range(0, len(paths), 1000):
        bucket().remove(paths[i:i + 1000])


def zip_response(user_id: str, labels: list[str], filename: str) -> Response:
    paths = [f"{user_id}/{label}/{n}" for label in labels for n in image_names(user_id, label)]
    if not paths:
        raise HTTPException(404, "다운로드할 이미지가 없습니다")
    with ThreadPoolExecutor(8) as ex:
        blobs = list(ex.map(bucket().download, paths))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:  # JPEG 는 이미 압축됨
        for path, blob in zip(paths, blobs):
            z.writestr(path.split("/", 1)[1], blob)  # {label}/{파일명}
    return Response(
        buf.getvalue(), media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/dataset/{label}/zip")
def download_label(label: str, user_id: str = Depends(cached_user_id)):
    return zip_response(user_id, [check_label(label)], f"{label}.zip")


@app.get("/api/dataset-zip")
def download_all(user_id: str = Depends(cached_user_id)):
    labels = [f["name"] for f in list_files(user_id) if f.get("id") is None]
    return zip_response(user_id, labels, "dataset.zip")
