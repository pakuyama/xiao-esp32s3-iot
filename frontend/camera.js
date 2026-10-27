const API = window.API_BASE.replace(/\/$/, "");
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LABEL_RE = /^[A-Za-z0-9_-]{1,40}$/;

let token = localStorage.getItem("token");
let devices = [];
let current = null;        // 선택된 디바이스
let streamGen = 0;         // 바뀌면 이전 영상 루프 종료
let lastFrameAt = 0;
let labels = [];           // [{label, count}]
let activeLabel = localStorage.getItem("camActiveLabel");
let images = [];           // 현재 클래스 이미지 [{name, url}]
let selected = new Set();
let lastClicked = null;    // Shift+클릭 범위 선택 기준
let burst = null;          // 진행 중인 연속 촬영 {stop}

// ---------- API 호출 + 로그 ----------
function log(line) {
  const el = $("log");
  el.textContent = `[${new Date().toLocaleTimeString()}] ${line}\n` + el.textContent.slice(0, 5000);
}

async function request(method, path, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    log(`${method} ${path} → 네트워크 오류 (${e.message})`);
    throw new Error("서버에 연결할 수 없습니다 (Render 무료 플랜은 첫 요청에 최대 1분 걸릴 수 있음)");
  }
  if (res.status === 401) logout();
  return res;
}

async function api(method, path, body, { quiet = false } = {}) {
  const t0 = performance.now();
  const res = await request(method, path, body);
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!quiet || !res.ok) log(`${method} ${path} → ${res.status} (${Math.round(performance.now() - t0)}ms)`);
  if (!res.ok) {
    const d = data?.detail;
    throw new Error(Array.isArray(d) ? d.map((x) => x.msg).join(", ") : d || `오류 ${res.status}`);
  }
  return data;
}

function setMsg(text, kind = "err") {
  $("capMsg").textContent = text;
  $("capMsg").className = `msg ${kind}`;
}

function logout() {
  token = null;
  localStorage.removeItem("token");
  localStorage.removeItem("email");
  location.href = "index.html";
}
$("logoutBtn").addEventListener("click", logout);

// ---------- 디바이스 ----------
async function loadDevices(selectId) {
  devices = await api("GET", "/api/devices");
  const sel = $("deviceSelect");
  sel.innerHTML = devices.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join("");
  if (!devices.length) {
    current = null;
    streamGen++;
    showOverlay("디바이스가 없습니다. 위에서 카메라 디바이스를 추가하세요.");
    $("firmwareCfg").textContent = "";
    return;
  }
  sel.value = selectId || localStorage.getItem("camDevice") || current?.id || devices[0].id;
  if (!sel.value) sel.value = devices[0].id;
  selectDevice(sel.value);
}

async function selectDevice(id) {
  current = devices.find((d) => d.id === id);
  localStorage.setItem("camDevice", id);
  $("firmwareCfg").textContent =
    `#define API_BASE   "${API}"\n#define DEVICE_KEY "${current.device_key}"`;
  showOverlay("카메라 연결 대기 중… (ESP32 전원/WiFi 확인)");
  try {
    renderSettings((await api("GET", `/api/devices/${id}/camera`)).settings);
  } catch { /* 로그에 기록됨 */ }
  startStream();
}
$("deviceSelect").addEventListener("change", (e) => selectDevice(e.target.value));

$("addDeviceForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const d = await api("POST", "/api/devices", Object.fromEntries(new FormData(e.target)));
    e.target.reset();
    await loadDevices(d.id);
    $("firmwareCfg").parentElement.open = true;
  } catch (err) {
    alert(err.message);
  }
});

// ---------- 카메라 설정 ----------
function renderSettings(s) {
  $("framesize").value = s.framesize;
  $("quality").value = s.quality;
  $("qualityVal").textContent = `${s.quality} (낮을수록 고화질)`;
  $("vflip").checked = !!s.vflip;
  $("hmirror").checked = !!s.hmirror;
}

async function saveSettings() {
  if (!current) return;
  const body = {
    framesize: +$("framesize").value,
    quality: +$("quality").value,
    vflip: $("vflip").checked,
    hmirror: $("hmirror").checked,
  };
  $("qualityVal").textContent = `${body.quality} (낮을수록 고화질)`;
  try {
    renderSettings((await api("PUT", `/api/devices/${current.id}/camera`, body)).settings);
  } catch (err) {
    setMsg(err.message);
  }
}
["framesize", "quality", "vflip", "hmirror"].forEach((id) => $(id).addEventListener("change", saveSettings));
$("quality").addEventListener("input", () => ($("qualityVal").textContent = `${$("quality").value} (낮을수록 고화질)`));

// ---------- 실시간 영상 (롱폴링) ----------
function showOverlay(text) {
  $("liveOverlay").textContent = text;
  $("liveOverlay").hidden = !text;
}

async function startStream() {
  const gen = ++streamGen;
  const id = current.id;
  let seq = 0, frames = 0, fpsAt = performance.now();
  while (gen === streamGen && !document.hidden) {
    try {
      const res = await request("GET", `/api/devices/${id}/frame?after=${seq}`);
      if (gen !== streamGen) return;
      if (res.status === 200) {
        seq = +res.headers.get("X-Frame-Seq");
        const url = URL.createObjectURL(await res.blob());
        const img = $("liveImg");
        const old = img.src;
        img.src = url;
        if (old.startsWith("blob:")) URL.revokeObjectURL(old);
        lastFrameAt = Date.now();
        frames++;
        showOverlay("");
      } else if (res.status !== 204) {
        log(`GET frame → ${res.status}`);
        await sleep(2000);
      }
    } catch {
      await sleep(2000);
    }
    const now = performance.now();
    if (now - fpsAt >= 1000) {
      const online = Date.now() - lastFrameAt < 10000;
      $("liveBadge").textContent = online ? `🟢 ${(frames * 1000 / (now - fpsAt)).toFixed(1)} fps` : "⚪ 오프라인";
      if (!online && lastFrameAt) showOverlay("카메라 신호 없음 (ESP32 전원/WiFi 확인)");
      frames = 0;
      fpsAt = now;
    }
  }
}

// 탭이 안 보이면 영상 요청을 멈춤 → ESP32 도 저속 모드로 전환
document.addEventListener("visibilitychange", () => {
  if (document.hidden) streamGen++;
  else if (current) startStream();
});

// ---------- 클래스 ----------
function localLabels() {
  try { return JSON.parse(localStorage.getItem("camLabels")) || []; } catch { return []; }
}

async function loadLabels() {
  const server = await api("GET", "/api/dataset", null, { quiet: true });
  const names = new Set(server.map((l) => l.label));
  // 아직 사진이 없는 클래스는 브라우저에만 저장
  labels = [...server, ...localLabels().filter((l) => !names.has(l)).map((label) => ({ label, count: 0 }))];
  labels.sort((a, b) => a.label.localeCompare(b.label));
  if (!labels.some((l) => l.label === activeLabel)) activeLabel = labels[0]?.label || null;
  renderLabels();
  await loadImages();
}

function renderLabels() {
  $("labelList").innerHTML = labels.length
    ? labels.map((l, i) => `
      <li data-label="${l.label}" class="${l.label === activeLabel ? "active" : ""}">
        ${i < 9 ? `<kbd>${i + 1}</kbd>` : ""}
        <span class="name">${l.label}</span>
        <span class="count">${l.count}장</span>
      </li>`).join("")
    : `<li class="empty">클래스를 추가하세요 (예: cat, dog, background)</li>`;
  $("currentLabel").textContent = activeLabel || "—";
  $("galleryTitle").textContent = activeLabel ? `${activeLabel} — ${countOf(activeLabel)}장` : "이미지";
  $("shotBtn").disabled = $("burstBtn").disabled = !activeLabel && !burst;
}

const countOf = (label) => labels.find((l) => l.label === label)?.count ?? 0;

function setCount(label, delta) {
  const l = labels.find((x) => x.label === label);
  if (l) l.count = Math.max(0, l.count + delta);
  renderLabels();
}

async function selectLabel(label) {
  if (label === activeLabel) return;
  activeLabel = label;
  localStorage.setItem("camActiveLabel", label);
  renderLabels();
  await loadImages();
}

$("labelList").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-label]");
  if (li) selectLabel(li.dataset.label);
});

$("addLabelForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const label = e.target.label.value.trim();
  if (!LABEL_RE.test(label)) return;
  const saved = localLabels();
  if (!saved.includes(label)) localStorage.setItem("camLabels", JSON.stringify([...saved, label]));
  if (!labels.some((l) => l.label === label)) {
    labels.push({ label, count: 0 });
    labels.sort((a, b) => a.label.localeCompare(b.label));
  }
  e.target.reset();
  selectLabel(label);
});

// ---------- 갤러리 ----------
async function loadImages() {
  selected.clear();
  lastClicked = null;
  if (!activeLabel) {
    images = [];
    return renderGallery();
  }
  const label = activeLabel;
  const list = countOf(label) ? await api("GET", `/api/dataset/${label}`, null, { quiet: true }) : [];
  if (label !== activeLabel) return;
  images = list;
  renderGallery();
}

function thumbHtml(img, isNew = false) {
  return `<div class="thumb${selected.has(img.name) ? " sel" : ""}${isNew ? " new" : ""}" data-name="${img.name}" title="${img.name}">
    <img src="${img.url}" loading="lazy" alt="" /><button class="del" title="삭제">×</button></div>`;
}

function renderGallery() {
  $("gallery").innerHTML = images.length
    ? images.map((img) => thumbHtml(img)).join("")
    : `<div class="empty">${activeLabel ? "아직 사진이 없습니다. Space 로 촬영하세요." : "클래스를 선택하세요."}</div>`;
  renderSelection();
}

function renderSelection() {
  document.querySelectorAll(".thumb").forEach((el) => el.classList.toggle("sel", selected.has(el.dataset.name)));
  $("deleteSelBtn").textContent = `선택 삭제 (${selected.size})`;
  $("deleteSelBtn").disabled = !selected.size;
  $("selectAllBtn").textContent = selected.size && selected.size === images.length ? "선택 해제" : "전체 선택";
  ["zipLabelBtn", "deleteLabelBtn"].forEach((id) => ($(id).disabled = !activeLabel));
}

$("gallery").addEventListener("click", (e) => {
  const el = e.target.closest(".thumb");
  if (!el) return;
  const name = el.dataset.name;
  if (e.target.classList.contains("del")) return deleteImages([name]);
  if (e.shiftKey && lastClicked) {
    const names = images.map((i) => i.name);
    const [a, b] = [names.indexOf(lastClicked), names.indexOf(name)].sort((x, y) => x - y);
    names.slice(a, b + 1).forEach((n) => selected.add(n));
  } else {
    selected.has(name) ? selected.delete(name) : selected.add(name);
    lastClicked = name;
  }
  renderSelection();
});

$("gallery").addEventListener("dblclick", (e) => {
  const el = e.target.closest(".thumb");
  if (el) window.open(images.find((i) => i.name === el.dataset.name)?.url, "_blank");
});

$("selectAllBtn").addEventListener("click", () => {
  selected = selected.size === images.length ? new Set() : new Set(images.map((i) => i.name));
  renderSelection();
});

$("deleteSelBtn").addEventListener("click", () => deleteImages([...selected]));

async function deleteImages(names) {
  if (!names.length || !activeLabel) return;
  const label = activeLabel;
  try {
    await api("POST", `/api/dataset/${label}/delete`, { names });
    const gone = new Set(names);
    images = images.filter((i) => !gone.has(i.name));
    names.forEach((n) => selected.delete(n));
    setCount(label, -names.length);
    renderGallery();
    setMsg(`${names.length}장 삭제했습니다`, "ok");
  } catch (err) {
    setMsg(err.message);
  }
}

$("deleteLabelBtn").addEventListener("click", async () => {
  const label = activeLabel;
  if (!label || !confirm(`'${label}' 클래스와 사진 ${countOf(label)}장을 모두 삭제할까요?`)) return;
  try {
    if (countOf(label)) await api("DELETE", `/api/dataset/${label}`);
    localStorage.setItem("camLabels", JSON.stringify(localLabels().filter((l) => l !== label)));
    activeLabel = null;
    await loadLabels();
  } catch (err) {
    setMsg(err.message);
  }
});

// ---------- ZIP 다운로드 ----------
async function downloadZip(path, filename, btn) {
  const text = btn.textContent;
  btn.disabled = true;
  btn.textContent = "압축 중…";
  try {
    const res = await request("GET", path);
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail || `오류 ${res.status}`);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await res.blob());
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    log(`GET ${path} → ${res.status}`);
  } catch (err) {
    setMsg(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = text;
  }
}
$("zipLabelBtn").addEventListener("click", (e) => activeLabel && downloadZip(`/api/dataset/${activeLabel}/zip`, `${activeLabel}.zip`, e.currentTarget));
$("zipAllBtn").addEventListener("click", (e) => downloadZip("/api/dataset-zip", "dataset.zip", e.currentTarget));

// ---------- 촬영 ----------
async function shoot(label) {
  const r = await api("POST", `/api/devices/${current.id}/capture`, { label }, { quiet: true });
  $("flash").classList.add("on");
  requestAnimationFrame(() => requestAnimationFrame(() => $("flash").classList.remove("on")));
  if (!labels.some((l) => l.label === label)) labels.push({ label, count: 0 });
  setCount(label, +1);
  if (label === activeLabel) {
    images.unshift({ name: r.name, url: r.url });
    $("gallery").querySelector(".empty")?.remove();
    $("gallery").insertAdjacentHTML("afterbegin", thumbHtml(images[0], true));
  }
  return r;
}

let shooting = false;
async function shootOnce() {
  if (!current || !activeLabel || shooting || burst) return;
  shooting = true;
  $("shotBtn").disabled = true;
  try {
    const r = await shoot(activeLabel);
    setMsg(`저장: ${r.name} (${(r.size / 1024).toFixed(1)}KB)`, "ok");
  } catch (err) {
    setMsg(err.message);
  } finally {
    shooting = false;
    $("shotBtn").disabled = false;
  }
}
$("shotBtn").addEventListener("click", shootOnce);

async function toggleBurst() {
  if (burst) return (burst.stop = true);
  if (!current || !activeLabel || shooting) return;
  const total = Math.min(500, Math.max(1, +$("burstCount").value || 1));
  const interval = Math.max(200, +$("burstInterval").value || 500);
  const label = activeLabel;
  burst = { stop: false };
  $("burstBtn").innerHTML = "■ 중지 <kbd>B</kbd>";
  $("burstBtn").classList.add("stop");
  $("shotBtn").disabled = true;
  const bar = $("burstProgress");
  bar.hidden = false;
  let done = 0, failed = 0;
  const update = () => {
    bar.firstElementChild.style.width = `${(done / total) * 100}%`;
    bar.lastElementChild.textContent = `${label}: ${done} / ${total}${failed ? ` (실패 ${failed})` : ""}`;
  };
  update();
  while (done < total && !burst.stop) {
    const t0 = performance.now();
    try {
      await shoot(label);
      done++;
    } catch (err) {
      setMsg(err.message);
      if (++failed >= 3) break;   // 카메라가 끊긴 경우 계속 시도하지 않음
    }
    update();
    const wait = interval - (performance.now() - t0);
    if (done < total && wait > 0 && !burst.stop) await sleep(wait);
  }
  setMsg(`연속 촬영 ${burst.stop ? "중지" : "완료"}: ${done}장 저장`, failed >= 3 ? "err" : "ok");
  burst = null;
  $("burstBtn").innerHTML = "▶ 연속 촬영 <kbd>B</kbd>";
  $("burstBtn").classList.remove("stop");
  $("shotBtn").disabled = false;
  setTimeout(() => !burst && (bar.hidden = true), 3000);
}
$("burstBtn").addEventListener("click", toggleBurst);

// ---------- 단축키 ----------
document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, select, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === "Space") {
    e.preventDefault();
    shootOnce();
  } else if (e.key === "b" || e.key === "B") {
    toggleBurst();
  } else if (/^[1-9]$/.test(e.key) && labels[+e.key - 1]) {
    selectLabel(labels[+e.key - 1].label);
  } else if (e.key === "Delete" || e.key === "Backspace") {
    if (selected.size) {
      e.preventDefault();
      deleteImages([...selected]);
    }
  } else if (e.key === "Escape") {
    if (burst) burst.stop = true;
    selected.clear();
    renderSelection();
  }
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- 시작 ----------
log(`API_BASE = ${API}`);
if (!token) {
  $("loginNotice").hidden = false;
  $("userBox").hidden = true;
} else {
  $("camView").hidden = false;
  $("userEmail").textContent = localStorage.getItem("email") || "";
  Promise.all([loadDevices(), loadLabels()]).catch((err) => setMsg(err.message));
}
