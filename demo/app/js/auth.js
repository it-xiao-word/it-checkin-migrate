'use strict';
// 会话由服务端 httpOnly Cookie 承载，前端 JS 不再持有令牌（降低 XSS 窃取风险）。
// 旧版本曾把 token 存 localStorage，这里保留同名函数做兼容并主动清理残留。
const TOKEN_KEY = 'itck_token';

function getToken() { return null; }
function setToken() { try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* 忽略 */ } }
function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* 忽略 */ } }
setToken(); // 清理历史残留令牌

async function apiFetch(url, opts) {
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers);
  opts.credentials = 'same-origin'; // 携带 httpOnly 会话 Cookie
  const resp = await fetch(url, opts);
  if (resp.status === 401) clearToken();
  return resp;
}

// 校验登录态；未登录/非目标角色则跳转登录页。返回 me 或 null（已跳转）。
async function ensureAuth(role) {
  let me;
  try {
    const resp = await apiFetch('/api/me');
    if (resp.status !== 200) { clearToken(); location.href = './login.html'; return null; }
    me = (await resp.json()).data;
  } catch (e) {
    location.href = './login.html';
    return null;
  }
  if (role && me.role !== role) {
    location.href = (role === 'admin') ? './login.html' : './';
    return null;
  }
  // 管理员只做管理、不参与现场打卡：误入打卡页/记录页时转回管理端
  if (!role && me.role === 'admin') {
    location.href = './admin.html';
    return null;
  }
  return me;
}

async function logout() {
  if (!confirm('确认退出登录？退出后当前账号的其他设备也将被下线。')) return;
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (e) { /* 网络异常也照常清理本地并跳转 */ }
  clearToken();
  location.href = './login.html';
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 带鉴权下载文件：window.location 不会携带 Authorization 头（会 401），
// 故用 fetch 取 blob 再触发本地下载。
async function downloadFile(url, filename) {
  try {
    const resp = await apiFetch(url);
    if (!resp.ok) {
      let msg = '下载失败（' + resp.status + '）';
      try { msg = (await resp.json()).message || msg; } catch (e) { /* 非 JSON */ }
      alert(msg);
      return false;
    }
    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    return true;
  } catch (e) {
    alert('下载失败：' + e.message);
    return false;
  }
}

// 带 loading 态的导出按钮：报告含照片时需要读取并编码，耗时数秒
async function downloadVia(btn, url, filename, busyText) {
  const oldText = btn ? btn.textContent : '';
  const oldDis = btn ? btn.disabled : false;
  if (btn) { btn.disabled = true; btn.textContent = busyText || '生成中…'; }
  try {
    return await downloadFile(url, filename);
  } finally {
    if (btn) { btn.disabled = oldDis; btn.textContent = oldText; }
  }
}

// 轻量提示：页面自带 toast 时优先用页面的，否则用内置降级实现
if (typeof window !== 'undefined' && typeof window.toast !== 'function') {
  window.toast = function (msg, type) {
    let box = document.getElementById('__toastBox');
    if (!box) {
      box = document.createElement('div');
      box.id = '__toastBox';
      box.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:999;'
        + 'display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'max-width:80vw;padding:10px 16px;border-radius:12px;font-size:13.5px;color:#fff;'
      + 'box-shadow:0 8px 22px rgba(16,26,38,.28);background:' + (type === 'err' ? '#c0392b' : '#1F3B5A')
      + ';opacity:0;transform:translateY(8px);transition:all .2s';
    box.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'none'; });
    setTimeout(() => {
      el.style.opacity = '0'; el.style.transform = 'translateY(8px)';
      setTimeout(() => el.remove(), 240);
    }, 2400);
  };
}

// ---------- 导出周期选择（本月 / 上月 / 本周 / 上周 / 全部 / 自定义） ----------
const PERIOD_LABEL = {
  month: '本月', lastMonth: '上月', week: '本周', lastWeek: '上周', all: '全部', custom: '自定义'
};

function dstr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
const dayEnd = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x.getTime(); };

// 周期 → { from, to }（毫秒时间戳）；全部时间返回 {from:null,to:null}；自定义未填返回 null
function periodRange(period, customFrom, customTo) {
  const now = new Date();
  const wd = (now.getDay() + 6) % 7;                 // 周一 = 0
  switch (period) {
    case 'month':
      return { from: dayStart(new Date(now.getFullYear(), now.getMonth(), 1)), to: dayEnd(now) };
    case 'lastMonth':
      return {
        from: dayStart(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        to: dayEnd(new Date(now.getFullYear(), now.getMonth(), 0))
      };
    case 'week':
      return { from: dayStart(new Date(now.getFullYear(), now.getMonth(), now.getDate() - wd)), to: dayEnd(now) };
    case 'lastWeek': {
      const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - wd - 7);
      const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
      return { from: dayStart(mon), to: dayEnd(sun) };
    }
    case 'all':
      return { from: null, to: null };
    case 'custom': {
      if (!customFrom || !customTo) return null;
      return {
        from: dayStart(new Date(customFrom + 'T00:00:00')),
        to: dayEnd(new Date(customTo + 'T00:00:00'))
      };
    }
  }
  return null;
}

// 导出弹窗只注入一次，页面里不需要额外 HTML
let __expOpts = null;
let __expClose = null;
function ensureExportDialog() {
  if (document.getElementById('expMask')) return;
  const host = document.createElement('div');
  host.innerHTML = `
  <div class="modal-mask" id="expMask">
    <div class="modal exp-modal">
      <div class="modal-head">
        <div class="t" id="expTitle">📤 导出明细</div>
        <button class="modal-close" id="expClose" type="button" aria-label="关闭">×</button>
      </div>
      <div class="modal-body">
        <div class="exp-cap">统计周期</div>
        <div class="exp-chips" id="expChips">
          <button class="chip-btn" type="button" data-p="month">本月</button>
          <button class="chip-btn" type="button" data-p="lastMonth">上月</button>
          <button class="chip-btn" type="button" data-p="week">本周</button>
          <button class="chip-btn" type="button" data-p="lastWeek">上周</button>
          <button class="chip-btn" type="button" data-p="all">全部</button>
          <button class="chip-btn" type="button" data-p="custom">自定义</button>
        </div>
        <div class="exp-custom" id="expCustom">
          <label class="field"><span>开始日期</span><input type="date" id="expFrom" /></label>
          <label class="field"><span>结束日期</span><input type="date" id="expTo" /></label>
        </div>
        <div class="exp-tip" id="expTip">正在统计…</div>

        <div class="exp-cap">导出格式</div>
        <div class="exp-fmts" id="expFmts">
          <label class="exp-fmt on">
            <input type="radio" name="expFmt" value="xlsx" checked />
            <span class="tx"><b>Excel 表格（照片嵌入）</b><em>照片直接显示在「现场照片」列，适合归档 / 汇报</em></span>
          </label>
          <label class="exp-fmt">
            <input type="radio" name="expFmt" value="xlsx-nophoto" />
            <span class="tx"><b>Excel 表格（不含照片）</b><em>只有文字明细，体积小、打开快</em></span>
          </label>
          <label class="exp-fmt">
            <input type="radio" name="expFmt" value="html" />
            <span class="tx"><b>HTML 报告（含照片）</b><em>单文件、照片内嵌，可离线查看 / 打印 / 存 PDF</em></span>
          </label>
          <label class="exp-fmt">
            <input type="radio" name="expFmt" value="html-nophoto" />
            <span class="tx"><b>HTML 报告（不含照片）</b><em>体积小，只有文字明细与统计附录</em></span>
          </label>
          <label class="exp-fmt">
            <input type="radio" name="expFmt" value="csv" />
            <span class="tx"><b>CSV 表格（纯文本）</b><em>CSV 无法存图片，只给照片直链，便于导入其他系统</em></span>
          </label>
        </div>

        <div class="exp-foot">
          <button class="btn ghost" id="expCancel" type="button">取消</button>
          <button class="btn primary" id="expGo" type="button">开始导出</button>
        </div>
      </div>
    </div>
  </div>`;
  document.body.appendChild(host.firstElementChild);
  // Esc 关闭（只注册一次，避免重复打开时叠加监听）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && __expClose) __expClose();
  });
}

// 打开导出弹窗：opts = { title, defaultPeriod, count(range), onExport(sel, btn) }
function openExportDialog(opts) {
  ensureExportDialog();
  const $id = (x) => document.getElementById(x);
  const mask = $id('expMask');
  const st = { period: opts.defaultPeriod || 'month' };

  $id('expTitle').textContent = opts.title || '📤 导出明细';

  // 自定义区间：优先沿用列表当前筛选的日期；否则默认本月
  const now0 = new Date();
  let cf = opts.customFrom || '';
  let ct = opts.customTo || '';
  if (cf && !ct) ct = cf;
  if (ct && !cf) cf = ct;
  if (!cf && !ct) { cf = dstr(new Date(now0.getFullYear(), now0.getMonth(), 1)); ct = dstr(now0); }
  $id('expFrom').value = cf;
  $id('expTo').value = ct;

  function render() {
    document.querySelectorAll('#expChips .chip-btn').forEach((b) => {
      b.classList.toggle('on', b.getAttribute('data-p') === st.period);
    });
    $id('expCustom').classList.toggle('on', st.period === 'custom');
    refreshTip();
  }

  let seq = 0;
  async function refreshTip() {
    const tip = $id('expTip');
    const range = periodRange(st.period, $id('expFrom').value, $id('expTo').value);
    if (!range) { tip.textContent = '请选择开始与结束日期'; tip.className = 'exp-tip warn'; return; }
    const span = range.from
      ? `${dstr(new Date(range.from))} ~ ${dstr(new Date(range.to))}`
      : '不限时间（全部记录）';
    if (!opts.count) { tip.textContent = '统计范围：' + span; tip.className = 'exp-tip'; return; }
    const my = ++seq;
    tip.textContent = '正在统计…';
    tip.className = 'exp-tip';
    let n = null;
    try { n = await opts.count(range); } catch (e) { n = null; }
    if (my !== seq) return;
    tip.className = 'exp-tip' + (n === 0 ? ' warn' : '');
    tip.innerHTML = `<span class="l">统计范围：<b>${esc(span)}</b></span>`
      + `<span class="l">匹配记录：<b>${n == null ? '?' : n}</b> 条`
      + (n === 0 ? '<em class="no">该周期没有记录，换个周期试试</em>' : '') + '</span>';
  }

  function close() { mask.classList.remove('on'); __expOpts = null; __expClose = null; }

  // 事件（每次重新绑定前先覆盖，避免叠加）
  const chips = $id('expChips');
  chips.onclick = (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    st.period = b.getAttribute('data-p');
    render();
  };
  $id('expFrom').onchange = refreshTip;
  $id('expTo').onchange = refreshTip;
  $id('expFmts').onclick = (e) => {
    if (!e.target.closest('.exp-fmt')) return;
    setTimeout(() => {
      document.querySelectorAll('#expFmts .exp-fmt').forEach((x) => {
        x.classList.toggle('on', !!x.querySelector('input').checked);
      });
    }, 0);
  };
  $id('expClose').onclick = close;
  $id('expCancel').onclick = close;
  mask.onclick = (e) => { if (e.target === mask) close(); };

  $id('expGo').onclick = async () => {
    const btn = $id('expGo');
    const range = periodRange(st.period, $id('expFrom').value, $id('expTo').value);
    if (!range) { toast('请选择开始与结束日期', 'err'); return; }
    if (range.from && range.to && range.from > range.to) { toast('开始日期不能晚于结束日期', 'err'); return; }
    const fmtEl = document.querySelector('#expFmts input[name="expFmt"]:checked');
    const sel = {
      period: st.period,
      label: PERIOD_LABEL[st.period] || '自定义',
      from: range.from,
      to: range.to,
      format: fmtEl ? fmtEl.value : 'html'
    };
    btn.disabled = true;
    btn.classList.add('loading');
    try {
      await opts.onExport(sel, btn);
      close();
    } catch (e) {
      toast('导出失败：' + (e && e.message ? e.message : e), 'err');
    } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  };

  __expOpts = opts;
  __expClose = close;
  render();
  mask.classList.add('on');
}

// 导出文件名用的周期片段（自定义用日期区间，避免文件名重复）
function periodTag(sel) {
  if (sel.period === 'custom' && sel.from && sel.to) {
    return `${dstr(new Date(sel.from)).replace(/-/g, '')}-${dstr(new Date(sel.to)).replace(/-/g, '')}`;
  }
  return sel.label;
}

// ---------- 照片（需登录，走 /api/photo/:name 鉴权） ----------
const __photoCache = new Map();

async function photoBlobUrl(name) {
  if (!name) return '';
  if (__photoCache.has(name)) return __photoCache.get(name);
  let url = '';
  try {
    const resp = await apiFetch('/api/photo/' + encodeURIComponent(name));
    if (resp.ok) url = URL.createObjectURL(await resp.blob());
  } catch (e) { url = ''; }
  __photoCache.set(name, url);
  return url;
}

// 把带 data-photo 的 <img>/<a> 替换为鉴权后的 blob 地址
async function hydratePhotos(root) {
  const els = (root || document).querySelectorAll('[data-photo]');
  for (const el of els) {
    const name = el.getAttribute('data-photo');
    if (!name) continue;
    const url = await photoBlobUrl(name);
    if (!url) {
      if (el.tagName === 'IMG') el.classList.add('ph-fail');
      continue;
    }
    if (el.tagName === 'IMG') el.src = url;
    else if (el.tagName === 'A') el.href = url;
  }
}

// ---------- 通用：近 7 日趋势迷你柱 ----------
// trend: [{date:'2026-10-28', total:3, bad:1}, ...] 由 /api/stats 返回
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

function renderTrend(el, trend) {
  if (!el) return;
  const list = Array.isArray(trend) ? trend : [];
  if (!list.length) { el.innerHTML = '<div class="spark-empty">暂无趋势数据</div>'; return; }

  const max = Math.max(1, ...list.map((d) => Number(d.total) || 0));
  const sum = list.reduce((a, d) => a + (Number(d.total) || 0), 0);
  const todayKey = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();

  const cols = list.map((d) => {
    const total = Number(d.total) || 0;
    const bad = Math.min(Number(d.bad) || 0, total);
    const ok = total - bad;
    const h = (v) => (total ? Math.round((v / max) * 100) : 0);
    const dt = new Date(d.date + 'T00:00:00');
    const isToday = d.date === todayKey;
    const label = isToday ? '今天' : `${dt.getMonth() + 1}/${dt.getDate()}`;
    const wd = isToday ? '' : `周${WEEKDAY[dt.getDay()]}`;
    return `<div class="spark-col${isToday ? ' today' : ''}" title="${d.date} · 打卡 ${total} 次${bad ? ` · 异常 ${bad} 次` : ''}">
      <div class="spark-v">${total || ''}</div>
      <div class="spark-bar">
        <i class="ok" style="height:${h(ok)}%"></i>
        <i class="bad" style="height:${h(bad)}%"></i>
      </div>
      <div class="spark-x">${label}</div>
      <div class="spark-w">${wd}</div>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="spark">${cols}</div>
    <div class="spark-foot"><span>近 7 日共 <b>${sum}</b> 次</span>
      <span class="lg"><i class="dot ok"></i>正常<i class="dot bad"></i>异常</span></div>`;
}

// 输入防抖（搜索框用，避免每敲一个字都打请求）
function debounce(fn, wait) {
  let t = null;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait == null ? 320 : wait);
  };
}
