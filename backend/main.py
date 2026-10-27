"""XIAO ESP32S3 IoT 백엔드 (FastAPI + Supabase)

- 사용자: Supabase Auth 로 회원가입/로그인, Bearer 토큰으로 API 호출
- 디바이스(ESP32): X-Device-Key 헤더로 센서값 업로드 / LED 상태 폴링
  → ESP32 가 클라우드로 먼저 요청을 보내는 구조라 같은 WiFi 가 아니어도 제어 가능
"""
import os
import secrets
from datetime import datetime, timezone

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Query
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
