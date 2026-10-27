-- Supabase 대시보드 → SQL Editor 에 붙여넣고 실행

create table if not exists public.devices (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  device_key  text not null unique,
  led_on      boolean not null default false,
  last_seen   timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists public.sensor_readings (
  id          bigint generated always as identity primary key,
  device_id   uuid not null references public.devices(id) on delete cascade,
  temperature real,
  analog      integer,
  created_at  timestamptz not null default now()
);

create index if not exists sensor_readings_device_time_idx
  on public.sensor_readings (device_id, created_at desc);

-- 백엔드는 service_role 키로만 접근 → RLS 켜고 정책은 두지 않음 (anon 키로는 직접 접근 불가)
alter table public.devices enable row level security;
alter table public.sensor_readings enable row level security;
