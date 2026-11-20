'use strict';

const $ = (id) => document.getElementById(id);
const photoInput = $('photo');
const canvas = $('canvas');
const emptyTip = $('emptyTip');
const submitBtn = $('submitBtn');
const locBtn = $('locBtn');
const locStatus = $('locStatus');

let gps = null;        // { lat, lng, accuracy }
let bitmap = null;     // 当前拍摄的原始图像
let roomList = [];     // 机房（含所属分组与巡检模板）
let templates = [];    // 巡检模板（含巡检项目）
let curItems = [];     // 当前机房对应的巡检项目
let me = null;         // 当前登录用户
let metaBase = '';     // 用户信息条基础文案（账号 / 工号）
let wmCfg = null;      // 默认模板配置（接口兼容字段）

function escHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escAttr(v) {
  return escHtml(v).replace(/"/g, '&quot;');
}

// ---------- 登录态 ----------
(async function init() {
  me = await ensureAuth();          // 未登录将跳转 login
  if (!me) return;
  const name = me.displayName || me.username;
  const staffId = me.staffId || '';
  // 头像取姓名末两字（中文）或首字母（英文）
  const initials = /^[A-Za-z]/.test(name) ? name.slice(0, 1).toUpperCase() : name.slice(-2);
  $('uAvatar').textContent = initials || '—';
  $('uName').textContent = name;
  metaBase = staffId ? `工号 ${staffId}` : (me.username ? `账号 ${me.username}` : '');
  $('uMeta').textContent = metaBase || '—';
  bind();
  loadConfig();
  loadTodayStats();
  loadRecent();
  getLocation();                    // 进入页面自动定位
})();
// 上次选择的机房（同设备同账号记住）
const ROOM_KEY = () => 'itck_room_' + ((me && me.id) || 'anon');
function showRoomTip(text) {
  const el = $('roomTip');
  if (!el) return;
  if (text) { el.textContent = '✓ ' + text; el.hidden = false; } else { el.hidden = true; }
}

// 最近一次打卡（时间 · 机房 · 是否异常），显示在用户信息条
async function loadRecent() {
  const el = $('uLast');
  if (!el) return;
  try {
    const r = await apiFetch('/api/checkins?page=1&pageSize=1');
    const d = (await r.json()).data || {};
    const last = (d.list || [])[0];
    if (!last) return;
    const bad = (last.inspections || []).some((i) => i.status === 'bad')
      || ['temp_status', 'env_status', 'net_status', 'ups_status'].some((k) => last[k] === 'bad');
    const dt = new Date(last.created_at);
    const p2 = (n) => String(n).padStart(2, '0');
    const today = new Date();
    const sameDay = dt.toDateString() === today.toDateString();
    const when = sameDay
      ? `今天 ${p2(dt.getHours())}:${p2(dt.getMinutes())}`
      : `${p2(dt.getMonth() + 1)}-${p2(dt.getDate())} ${p2(dt.getHours())}:${p2(dt.getMinutes())}`;
    el.className = 'userbar-last ' + (bad ? 'bad' : 'ok');
    el.innerHTML = `<i class="dot"></i>最近 ${when} · ${escHtml(last.location || '未填写机房')}`;
    el.hidden = false;
  } catch (e) { /* 无记录时静默 */ }
}

// 今日打卡次数 / 最近一次时间（普通用户仅统计本人）
async function loadTodayStats() {
  try {
    const r = await apiFetch('/api/stats');
    const s = (await r.json()).data || {};
    $('uToday').textContent = s.today ?? 0;
    if (s.lastToday) {
      const d = new Date(s.lastToday);
      const p = (n) => String(n).padStart(2, '0');
      $('uMeta').textContent = metaBase + ` · 最近 ${p(d.getHours())}:${p(d.getMinutes())} 打卡`;
    }
  } catch (e) {
    $('uToday').textContent = '0';
  }
}

// ---------- 加载机房与巡检配置 ----------
// 机房 → 分组 → 巡检模板 → 巡检项目；同组机房共用同一套项目
async function loadConfig() {
  try {
    const r = await apiFetch('/api/checkin-config');
    const d = (await r.json()).data || {};
    roomList = d.rooms || [];
    templates = d.templates || [];
    wmCfg = wmNormalize(d.watermark || {});
    wmTpls = Array.isArray(d.watermarks) ? d.watermarks : [];
    $('location').innerHTML = '<option value="">— 请选择机房 —</option>' + roomList.map((x) =>
      `<option value="${escAttr(x.name)}">${escHtml(x.name)}</option>`
    ).join('');
    if (!roomList.length) {
      $('cfgTip').style.display = 'block';
    }
    // 记住这台设备上次选的机房，减少重复选择
    let saved = '';
    try { saved = localStorage.getItem(ROOM_KEY()) || ''; } catch (e) { saved = ''; }
    if (saved && roomList.some((x) => x.name === saved)) {
      $('location').value = saved;
      showRoomTip(`已自动选好上次的机房：${saved}`);
    } else {
      showRoomTip('');
    }
    initWatermarkUI();
    renderInspect();
  } catch (e) {
    $('cfgTip').style.display = 'block';
    $('cfgTip').textContent = '⚠ 配置加载失败：' + e.message;
    initWatermarkUI();
  }
}

// ---------- 水印：模板选择（+ 可选自定义标题） ----------
const WM_KEY = () => 'itck_wm_' + ((me && me.id) || 'anon');

let wmTpls = [];       // 全部水印模板（isDefault 标记系统默认）
let wmState = {        // 本机用户的水印偏好
  tplId: null,         // 上次选择的模板
  mineId: null,        // 我设为默认的模板
  useCustom: false,    // 是否用自己的标题覆盖模板
  title: '',
  org: ''
};

function loadWmPref() {
  try {
    const raw = localStorage.getItem(WM_KEY());
    if (!raw) return;
    const p = JSON.parse(raw);
    wmState.tplId = p.tplId == null ? null : Number(p.tplId);
    wmState.mineId = p.mineId == null ? null : Number(p.mineId);
    wmState.useCustom = p.useCustom === true || p.mode === 'custom';
    wmState.title = String(p.title || '').slice(0, 20);
    wmState.org = String(p.org || '').slice(0, 24);
  } catch (e) { /* 忽略损坏的本地偏好 */ }
}
function saveWmPref() {
  try { localStorage.setItem(WM_KEY(), JSON.stringify(wmState)); } catch (e) { /* 隐私模式下忽略 */ }
}

function wmTplById(id) {
  const n = Number(id);
  return wmTpls.find((t) => Number(t.id) === n) || null;
}
function wmDefaultTpl() {
  return wmTpls.find((t) => t.isDefault) || wmTpls[0] || null;
}
function wmCurTpl() {
  return wmTplById(wmState.tplId) || wmDefaultTpl();
}
function wmTplAllowCustom() {
  const t = wmCurTpl();
  return !t || !t.config || t.config.allowCustom !== false;
}

// 当前生效的水印：所选模板配置 +（勾选时）自己的标题
function activeWmCfg() {
  const tpl = wmCurTpl();
  const cfg = wmNormalize((tpl && tpl.config) || wmCfg || {});
  if (!wmState.useCustom || cfg.allowCustom === false) return cfg;
  return wmActive(cfg, 'custom', wmState.title, wmState.org);
}

function initWatermarkUI() {
  if (!wmCfg) wmCfg = wmNormalize({});
  // 兜底：接口没下发模板时用单套配置合成一个，保证页面可用
  if (!wmTpls.length) wmTpls = [{ id: 0, name: '默认水印', config: wmCfg, isDefault: true }];
  loadWmPref();

  // 选中优先级：我的默认 → 上次选择 → 系统默认
  const pick = wmTplById(wmState.mineId) || wmTplById(wmState.tplId) || wmDefaultTpl();
  wmState.tplId = pick ? pick.id : null;

  const sel = $('wmTplSel');
  sel.innerHTML = wmTpls.map((t) =>
    `<option value="${escAttr(t.id)}">${escHtml(t.name)}${t.isDefault ? '（默认）' : ''}</option>`
  ).join('');
  sel.value = String(wmState.tplId);
  sel.onchange = () => {
    wmState.tplId = Number(sel.value);
    if (!wmTplAllowCustom()) wmState.useCustom = false;
    saveWmPref();
    syncWmUI();
  };

  $('wmUseCustom').onchange = (e) => {
    wmState.useCustom = e.target.checked;
    saveWmPref();
    syncWmUI();
  };

  $('wmTitle').value = wmState.title;
  $('wmOrg').value = wmState.org;
  ['wmTitle', 'wmOrg'].forEach((id) => {
    const el = $(id);
    el.oninput = () => {
      if (id === 'wmTitle') wmState.title = el.value.slice(0, 20);
      else wmState.org = el.value.slice(0, 24);
      saveWmPref();
      updateWmCounters();
      drawWatermark();
    };
  });

  // 设为 / 取消「我的默认」
  $('wmMineBtn').onclick = () => {
    wmState.mineId = Number(wmState.mineId) === Number(wmState.tplId) ? null : wmState.tplId;
    saveWmPref();
    syncWmUI();
  };

  updateWmCounters();
  syncWmUI();
}

function updateWmCounters() {
  const t = $('wmTitleCnt'); const o = $('wmOrgCnt');
  if (t) t.textContent = `${wmState.title.length}/20`;
  if (o) o.textContent = `${wmState.org.length}/24`;
}

function syncWmUI() {
  const tpl = wmCurTpl();
  const allow = wmTplAllowCustom();
  if (!allow) wmState.useCustom = false;

  const isSys = !!(tpl && tpl.isDefault);
  const isMine = !!(tpl && Number(wmState.mineId) === Number(tpl.id));
  $('wmDefTag').hidden = !isSys;
  $('wmMineTag').hidden = !isMine;

  $('wmMineTip').textContent = isMine
    ? '打卡时自动选中这套模板'
    : '设为我的默认，下次进来自动选中';
  $('wmMineBtn').textContent = isMine ? '取消我的默认' : '设为我的默认';

  const chk = $('wmUseCustom');
  chk.disabled = !allow;
  chk.checked = wmState.useCustom && allow;
  $('wmCustomChk').classList.toggle('off', !allow);
  $('wmCustom').classList.toggle('on', wmState.useCustom && allow);

  const tip = $('wmTip');
  const tname = tpl ? tpl.name : '默认';
  if (!allow) {
    tip.textContent = `模板「${tname}」固定标题，不能改文字，其余按模板配置显示。`;
  } else if (wmState.useCustom) {
    tip.textContent = (wmState.title.trim() || wmState.org.trim())
      ? '正在这套模板上使用你自定义的标题（其余字段仍按模板配置显示）。'
      : '已勾选自定义标题：请填写标题，留空则沿用模板原标题。';
  } else if (isSys) {
    tip.textContent = `当前使用系统默认模板「${tname}」，可切换其他模板，或勾选自定义标题。`;
  } else {
    tip.textContent = `当前使用模板「${tname}」。`;
  }
  updateWmCounters();
  drawWatermark();
}

// 小预览图（与真实照片同款版式，数据取当前填写内容）
function renderWmPreview() {
  const cv = $('wmPreview');
  if (!cv || !wmCfg) return;
  const loc = $('location').value.trim();
  const insp = curItems.map((it) => `${it.name}${itemStatus(it.id) === 'ok' ? '正常' : itemStatus(it.id) === 'bad' ? '不正常' : '—'}`);
  wmPreview(cv, activeWmCfg(), {
    time: fmtTime(new Date()),
    coord: gps ? `${gps.lat.toFixed(6)}, ${gps.lng.toFixed(6)} (±${Math.round(gps.accuracy)}m)` : '未获取定位',
    name: (me && (me.displayName || me.username)) || '',
    staffId: (me && me.staffId) || '',
    location: loc || '未选择机房',
    insp: insp.length ? insp : ['（选机房后显示）'],
    custom: ($('customText').value || '').trim(),
    note: $('note').value.trim()
  }, 360);
}


function findRoom(name) {
  return roomList.find((x) => x.name === name) || null;
}

// 按当前选中机房渲染巡检项目
function renderInspect() {
  const box = $('inspectList');
  const empty = $('inspectEmpty');
  const loading = $('inspectLoading');
  const tplTag = $('inspectTpl');
  const room = findRoom($('location').value);

  if (!room) {
    curItems = [];
    box.innerHTML = '';
    box.style.display = 'none';
    empty.style.display = 'none';
    loading.style.display = 'block';
    loading.textContent = '请先选择机房，将自动加载该机房的巡检项目。';
    tplTag.textContent = '';
    syncInspectState();
    drawWatermark();
    return;
  }

  const tpl = templates.find((t) => t.id === room.template_id) || null;
  curItems = tpl ? (tpl.items || []) : [];
  tplTag.textContent = tpl ? `· ${tpl.name}` : '';
  loading.style.display = 'none';

  if (!curItems.length) {
    box.innerHTML = '';
    box.style.display = 'none';
    empty.style.display = 'block';
    syncInspectState();
    drawWatermark();
    return;
  }

  empty.style.display = 'none';
  box.style.display = 'flex';
  box.innerHTML = curItems.map((it) => `
    <div class="inspect-item" data-item="${it.id}">
      <span class="inspect-label">${escHtml(it.name)}</span>
      <div class="seg-group">
        <label class="seg"><input type="radio" name="insp_${it.id}" value="ok"><span>正常</span></label>
        <label class="seg bad"><input type="radio" name="insp_${it.id}" value="bad"><span>不正常</span></label>
      </div>
    </div>`).join('');

  // 新渲染的项目绑定联动事件
  box.querySelectorAll('input[type="radio"]').forEach((el) => {
    el.addEventListener('change', () => { syncInspectState(); drawWatermark(); });
  });
  syncInspectState();
  drawWatermark();
}

function itemStatus(itemId) {
  const el = document.querySelector(`input[name="insp_${itemId}"]:checked`);
  return el ? el.value : '';
}

// 当前机房的巡检结论（按项目顺序）
function collectInspect() {
  return curItems.map((it) => ({ itemId: it.id, name: it.name, status: itemStatus(it.id) }));
}

function fmtTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
let toastTimer = null;
function toast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast ' + type; }, 2600);
}

// ---------- 定位 ----------
function setLocBadge(text, cls) {
  const b = $('locBadge');
  b.textContent = text;
  b.className = 'tail badge dot' + (cls ? ' ' + cls : '');
}

function getLocation() {
  if (!('geolocation' in navigator)) {
    locStatus.textContent = '当前环境不支持定位（需 HTTPS）';
    locStatus.className = 'status err';
    setLocBadge('不支持', 'bad');
    return;
  }
  locStatus.textContent = '正在获取定位…';
  locStatus.className = 'status';
  setLocBadge('定位中', 'warn');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      gps = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
      locStatus.textContent = `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)} · ±${Math.round(pos.coords.accuracy)}m`;
      locStatus.className = 'status ok';
      setLocBadge('已定位', 'ok');
      drawWatermark();
    },
    (err) => {
      locStatus.textContent = '定位失败：' + err.message;
      locStatus.className = 'status err';
      setLocBadge('未定位', 'bad');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

// ---------- 拍照 + 水印 ----------
// 压缩参数（实测标定，见 README「照片压缩」）：
// 长边 1280 时 q≥0.72 水印文字仍清晰；画布再小水印字号会跟着变小，故 960 为下限。
const PHOTO_MAX_W = 1280;
const PHOTO_MIN_W = 960;
const PHOTO_TARGET_BYTES = 200 * 1024;   // 单张目标体积上限
const PHOTO_Q_HI = 0.88;                 // 细节少时的首选质量
const PHOTO_Q_START = 0.82;              // 常规首选质量
const PHOTO_Q_LOW = 0.72;                // 质量下限

let rawBytes = 0;   // 原始照片体积（压缩前），随打卡提交供服务端统计压缩率

function fmtBytes(n) {
  if (!n && n !== 0) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

async function onPhoto(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    rawBytes = file.size || 0;
    canvas.style.display = 'block';
    emptyTip.style.display = 'none';
    $('retakeBtn').classList.add('show');
    drawWatermark();
  } catch (err) {
    toast('图片读取失败：' + err.message, 'err');
  }
}

// 照片水印数据（预览与压缩共用，避免两处逻辑漂移）
function wmData() {
  const name = (me && (me.displayName || me.username)) || '';
  const staffId = (me && me.staffId) || '';
  const location = $('location').value.trim();
  const note = $('note').value.trim();
  const coord = gps
    ? `${gps.lat.toFixed(6)}, ${gps.lng.toFixed(6)} (±${Math.round(gps.accuracy)}m)`
    : '未获取定位';
  const z = (v) => (v === 'ok' ? '正常' : v === 'bad' ? '不正常' : '—');
  return {
    time: fmtTime(new Date()),
    coord, name, staffId,
    location: location || '未选择',
    insp: curItems.map((it) => `${it.name}${z(itemStatus(it.id))}`),
    inspEmpty: curItems.length === 0 && location ? '未配置巡检项' : '—',
    custom: ($('customText').value || '').trim(),
    note
  };
}

// 把原图按指定长边缩放后连同水印画进画布（预览画布与压缩画布共用）
function paintPhoto(cv, maxW) {
  const scale = Math.min(1, maxW / bitmap.width);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  wmPaint(ctx, w, h, activeWmCfg(), wmData());
  return { w, h };
}

function drawWatermark() {
  if (!bitmap) { renderWmPreview(); syncSubmitState(); return; }
  paintPhoto(canvas, PHOTO_MAX_W);   // 屏幕上看到的就是最终画质基准
  renderWmPreview();
  syncSubmitState();
}

function canvasToJpeg(cv, q) {
  return new Promise((resolve, reject) => {
    cv.toBlob((b) => (b ? resolve(b) : reject(new Error('照片编码失败'))), 'image/jpeg', q);
  });
}

/*
 * 自适应压缩：在视觉无损的前提下把单张照片压到目标体积内。
 * 策略（逐步降级，命中即返回）：
 *   1) 1280 宽 + q0.82 先试；体积很富余（<50%）则试 q0.88，优先保清晰度
 *   2) 仍超目标 → 依次降质量到 0.78 / 0.74 / 0.72（水印文字仍清晰的下限）
 *   3) 还超 → 缩到 1080 / 960 宽再压（同等质量下体积随像素面积下降）
 * 整个过程只在前端发生一次编码，服务端不再二次有损压缩，避免累积失真。
 */
async function encodePhoto() {
  const off = document.createElement('canvas');

  const dim = paintPhoto(off, PHOTO_MAX_W);
  let blob = await canvasToJpeg(off, PHOTO_Q_START);

  if (blob.size < PHOTO_TARGET_BYTES * 0.5) {
    const hi = await canvasToJpeg(off, PHOTO_Q_HI);
    if (hi.size <= PHOTO_TARGET_BYTES) return { blob: hi, q: PHOTO_Q_HI, ...dim };
  }
  if (blob.size <= PHOTO_TARGET_BYTES) return { blob, q: PHOTO_Q_START, ...dim };

  for (const q of [0.76, PHOTO_Q_LOW]) {
    blob = await canvasToJpeg(off, q);
    if (blob.size <= PHOTO_TARGET_BYTES) return { blob, q, ...dim };
  }

  // 1280 到质量下限仍超目标 → 缩尺寸重绘（水印按新宽度重新排版，文字不会糊）
  let last = { blob, q: PHOTO_Q_LOW, ...dim };
  for (const maxW of [1080, PHOTO_MIN_W]) {
    const d2 = paintPhoto(off, maxW);
    for (const q of [0.80, 0.74]) {
      const b = await canvasToJpeg(off, q);
      last = { blob: b, q, ...d2 };
      if (b.size <= PHOTO_TARGET_BYTES || maxW === PHOTO_MIN_W) return last;
    }
  }
  return last;
}

// 机房变化 → 重新加载该机房的巡检项目；备注/说明变化 → 刷新预览水印
$('location').addEventListener('change', renderInspect);
['note', 'customText'].forEach((id) => {
  const el = $(id); if (!el) return;
  el.addEventListener('input', drawWatermark);
  el.addEventListener('change', drawWatermark);
});

// ---------- 巡检项状态联动（异常高亮 + 说明必填提示） ----------
function badItems() {
  return curItems.filter((it) => itemStatus(it.id) === 'bad').map((it) => it.name);
}
function missingItems() {
  return curItems.filter((it) => !itemStatus(it.id)).map((it) => it.name);
}

function syncInspectState() {
  document.querySelectorAll('#inspectList .inspect-item').forEach((el) => {
    const id = el.getAttribute('data-item');
    el.classList.toggle('has-bad', itemStatus(id) === 'bad');
  });

  // 巡检完成进度
  const total = curItems.length;
  const done = total - missingItems().length;
  const cnt = $('inspectCount');
  const bar = $('inspectProgress');
  if (cnt) {
    cnt.textContent = total ? `${done} / ${total}` : '';
    cnt.className = 'inspect-count' + (total && done === total ? ' done' : '');
  }
  if (bar) {
    bar.style.display = total ? 'block' : 'none';
    bar.firstElementChild.style.width = total ? Math.round((done / total) * 100) + '%' : '0%';
    bar.classList.toggle('done', !!total && done === total);
  }

  const bads = badItems();
  const req = $('customReq');
  const box = $('customText');
  if (req) req.style.display = bads.length ? 'inline' : 'none';
  if (box) {
    box.placeholder = bads.length
      ? `必填：请说明「${bads.join('、')}」的异常情况与处理措施`
      : '选填：异常描述、处理措施等';
    box.classList.toggle('need', bads.length > 0 && !String(box.value || '').trim());
  }
  syncSubmitState();
}

// 提交按钮状态 + 底栏提示：把"为什么不能提交"直接说清楚
function syncSubmitState() {
  const hint = $('submitHint');
  const loc = $('location').value.trim();
  const miss = missingItems();
  const bads = badItems();
  const hasText = String($('customText').value || '').trim().length > 0;

  let msg = '';
  let ready = false;
  if (!bitmap) msg = '请先拍照，照片会自动叠加水印';
  else if (!loc) msg = '还差一步：选择机房 / 位置';
  else if (miss.length) msg = `还有 ${miss.length} 项巡检未选择：${miss.slice(0, 2).join('、')}${miss.length > 2 ? '…' : ''}`;
  else if (bads.length && !hasText) msg = '有异常项，请填写巡检说明';
  else { msg = '信息已完整，可以提交'; ready = true; }

  if (hint) {
    hint.textContent = msg;
    hint.className = 'ab-hint' + (ready ? ' ready' : '');
  }
  submitBtn.disabled = !ready;
}

// ---------- 提交 ----------
async function submit() {
  if (!bitmap) { toast('请先拍照', 'err'); return; }
  if (!$('location').value) { toast('请选择机房/位置', 'err'); return; }
  // 巡检项目由机房决定，未全部选择不允许提交
  const miss = missingItems();
  if (miss.length) { toast('请完成巡检项「' + miss.join('、') + '」', 'err'); return; }
  // 有异常项时必须填写巡检说明
  const bads = badItems();
  if (bads.length && !($('customText').value || '').trim()) {
    syncInspectState();
    toast('「' + bads.join('、') + '」不正常，请填写巡检说明', 'err');
    $('customText').focus();
    return;
  }
  submitBtn.disabled = true;
  submitBtn.textContent = '提交中…';
  try {
    // 压缩在 encodePhoto 内部完成，对用户透明，不单独提示
    const enc = await encodePhoto();
    const fd = new FormData();
    fd.append('photo', enc.blob, 'checkin.jpg');
    if (rawBytes) fd.append('rawBytes', String(rawBytes));
    fd.append('location', $('location').value.trim());
    fd.append('note', $('note').value.trim());
    // 巡检结果按项目 id 提交，服务端按机房模板校验并取库内项目名
    fd.append('inspect', JSON.stringify(collectInspect().map((x) => ({ itemId: x.itemId, status: x.status }))));
    fd.append('customText', ($('customText').value || '').trim());
    // 记录本次使用的水印模板（服务端按 id 校验后存模板名）
    const curTpl = wmCurTpl();
    if (curTpl && curTpl.id) fd.append('wmTemplateId', curTpl.id);
    if (gps) {
      fd.append('lat', gps.lat);
      fd.append('lng', gps.lng);
      fd.append('accuracy', gps.accuracy);
    }
    const resp = await apiFetch('/api/checkin', { method: 'POST', body: fd });
    const data = await resp.json();
    if (data.code === 0) {
      toast('上传成功，打卡完成 ✓', 'ok');
      loadTodayStats();
      setTimeout(resetForm, 1400);
    } else if (data.code === 401) {
      clearToken();
      location.href = '/login.html';
    } else {
      toast('提交失败：' + data.message, 'err');
      submitBtn.disabled = false;
    }
  } catch (err) {
    toast('网络错误：' + err.message, 'err');
    submitBtn.disabled = false;
  } finally {
    submitBtn.textContent = '提交打卡';
  }
}

function resetForm() {
  photoInput.value = '';
  bitmap = null;
  rawBytes = 0;
  canvas.style.display = 'none';
  canvas.width = canvas.height = 0;
  emptyTip.style.display = 'block';
  $('retakeBtn').classList.remove('show');
  document.querySelectorAll('#inspectList input[type="radio"]').forEach((el) => { el.checked = false; });
  $('customText').value = '';
  syncInspectState();
  syncSubmitState();
}

function bind() {
  locBtn.addEventListener('click', getLocation);
  photoInput.addEventListener('change', onPhoto);
  $('retakeBtn').addEventListener('click', () => photoInput.click());
  submitBtn.addEventListener('click', submit);
  // 换机房时记住选择，下次进页面自动带出
  $('location').addEventListener('change', () => {
    const v = $('location').value.trim();
    try { if (v) localStorage.setItem(ROOM_KEY(), v); } catch (e) { /* 隐私模式忽略 */ }
    showRoomTip('');
    syncSubmitState();
  });
  $('myRecordsBtn').addEventListener('click', () => { location.href = '/records.html'; });
  $('logoutBtn').addEventListener('click', logout);
}
