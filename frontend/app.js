const API = window.API_BASE.replace(/\/$/, "");
const $ = (id) => document.getElementById(id);

let token = localStorage.getItem("token");
let email = localStorage.getItem("email");
let devices = [];
let current = null;   // 선택된 디바이스
let chart = null;
let pollTimer = null;
let authMode = "login";

// ---------- API 호출 + 로그 ----------
function log(line) {
  const el = $("log");
  el.textContent = `[${new Date().toLocaleTimeString()}] ${line}\n` + el.textContent.slice(0, 5000);
}

async function api(method, path, body, { quiet = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    log(`${method} ${path} → 네트워크 오류 (${e.message})`);
    throw new Error("서버에 연결할 수 없습니다 (Render 무료 플랜은 첫 요청에 최대 1분 걸릴 수 있음)");
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  const ms = Math.round(performance.now() - t0);
  if (!quiet || !res.ok) log(`${method} ${path} → ${res.status} (${ms}ms)\n${JSON.stringify(data)}`);
  if (res.status === 401 && token) logout();
  if (!res.ok) {
    const d = data?.detail;
    throw new Error(Array.isArray(d) ? d.map((x) => x.msg).join(", ") : d || `오류 ${res.status}`);
  }
  return data;
}

// ---------- 인증 ----------
document.querySelectorAll(".tab").forEach((btn) =>
  btn.addEventListener("click", () => {
    authMode = btn.dataset.mode;
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    $("authSubmit").textContent = authMode === "login" ? "로그인" : "회원가입";
    setMsg("");
  })
);

function setMsg(text, kind = "err") {
  $("authMsg").textContent = text;
  $("authMsg").className = `msg ${kind}`;
}

$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  $("authSubmit").disabled = true;
  try {
    if (authMode === "signup") {
      await api("POST", "/api/auth/signup", body);
      setMsg("가입 완료! 로그인합니다…", "ok");
    }
    const r = await api("POST", "/api/auth/login", body);
    token = r.access_token;
    email = r.user.email;
    localStorage.setItem("token", token);
    localStorage.setItem("email", email);
    e.target.reset();
    setMsg("");
    showDashboard();
  } catch (err) {
    setMsg(err.message);
  } finally {
    $("authSubmit").disabled = false;
  }
});

function logout() {
  token = email = null;
  localStorage.removeItem("token");
  localStorage.removeItem("email");
  clearInterval(pollTimer);
  $("dashView").hidden = true;
  $("userBox").hidden = true;
  $("authView").hidden = false;
}
$("logoutBtn").addEventListener("click", logout);

// ---------- 대시보드 ----------
async function showDashboard() {
  $("authView").hidden = true;
  $("dashView").hidden = false;
  $("userBox").hidden = false;
  $("userEmail").textContent = email;
  await loadDevices();
}

async function loadDevices(selectId) {
  devices = await api("GET", "/api/devices");
  const sel = $("deviceSelect");
  sel.innerHTML = devices.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join("");
  if (!devices.length) {
    current = null;
    $("deviceArea").hidden = true;
    $("deviceInfo").textContent = "등록된 디바이스가 없습니다. 이름을 입력하고 추가하세요.";
    return;
  }
  sel.value = selectId || current?.id || devices[0].id;
  selectDevice(sel.value);
}

function selectDevice(id) {
  current = devices.find((d) => d.id === id);
  $("deviceArea").hidden = false;
  $("deviceInfo").textContent = `ID: ${current.id}`;
  $("firmwareCfg").textContent =
    `// firmware/xiao_iot/secrets.h\n#define API_BASE   "${API}"\n#define DEVICE_KEY "${current.device_key}"`;
  clearInterval(pollTimer);
  refresh();
  pollTimer = setInterval(refresh, 3000);
}
$("deviceSelect").addEventListener("change", (e) => selectDevice(e.target.value));

$("addDeviceForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const d = await api("POST", "/api/devices", Object.fromEntries(new FormData(e.target)));
    e.target.reset();
    await loadDevices(d.id);
  } catch (err) {
    alert(err.message);
  }
});

$("deleteDeviceBtn").addEventListener("click", async () => {
  if (!current || !confirm(`'${current.name}' 디바이스와 기록을 모두 삭제할까요?`)) return;
  await api("DELETE", `/api/devices/${current.id}`);
  current = null;
  await loadDevices();
});

async function refresh() {
  if (!current) return;
  const id = current.id;
  try {
    const [list, readings] = await Promise.all([
      api("GET", "/api/devices", null, { quiet: true }),
      api("GET", `/api/devices/${id}/readings?limit=50`, null, { quiet: true }),
    ]);
    if (current?.id !== id) return;
    devices = list;
    current = list.find((d) => d.id === id) || current;
    render(readings);
  } catch { /* 로그에 이미 기록됨 */ }
}

function render(readings) {
  const latest = readings[0];
  $("tempVal").textContent = latest?.temperature != null ? `${latest.temperature.toFixed(1)}℃` : "—";
  $("analogVal").textContent = latest?.analog ?? "—";
  renderLed(current.led_on);

  const seen = current.last_seen ? new Date(current.last_seen) : null;
  const online = seen && Date.now() - seen.getTime() < 30000;
  $("onlineVal").textContent = seen ? (online ? "🟢 온라인" : "⚪ 오프라인") : "⚪ 데이터 없음";
  $("onlineVal").title = seen ? `마지막 수신: ${seen.toLocaleString()}` : "";

  const rows = [...readings].reverse();
  const labels = rows.map((r) => new Date(r.created_at).toLocaleTimeString());
  if (!chart) {
    chart = new Chart($("chart"), {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "온도(℃)", data: [], yAxisID: "y", borderColor: "#ef4444", tension: 0.3, pointRadius: 0 },
          { label: "아날로그 A0", data: [], yAxisID: "y1", borderColor: "#2563eb", tension: 0.3, pointRadius: 0 },
        ],
      },
      options: {
        animation: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          y: { position: "left", title: { display: true, text: "℃" } },
          y1: { position: "right", min: 0, max: 4095, grid: { drawOnChartArea: false } },
        },
      },
    });
  }
  chart.data.labels = labels;
  chart.data.datasets[0].data = rows.map((r) => r.temperature);
  chart.data.datasets[1].data = rows.map((r) => r.analog);
  chart.update();
}

function renderLed(on) {
  $("ledBtn").textContent = on ? "ON 💡" : "OFF";
  $("ledBtn").classList.toggle("on", on);
}

$("ledBtn").addEventListener("click", async () => {
  if (!current) return;
  const next = !current.led_on;
  $("ledBtn").disabled = true;
  try {
    await api("PUT", `/api/devices/${current.id}/led`, { on: next });
    current.led_on = next;
    renderLed(next);
  } catch (err) {
    alert(err.message);
  } finally {
    $("ledBtn").disabled = false;
  }
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- 시작 ----------
log(`API_BASE = ${API}`);
if (token) showDashboard().catch(() => {});
