'use strict';
const $ = (id) => document.getElementById(id);
let page = 1;
const pageSize = 20;
let recCache = new Map();   // id → 记录，供详情弹窗使用

(async function init() {
  const me = await ensureAuth('admin');   // 非管理员跳登录
  if (!me) return;
  $('logoutBtn').addEventListener('click', logout);
  bindTabs();
  bindAccordion();
  bindDetail();
  bindConfig();
  bindList();
  // 月度汇总默认当前月
  const now = new Date();
  $('sumMonth').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  loadUsers();
  loadConfigAll();
  bindWatermark();
  loadWatermark();
  loadStats();
  load();
})();

// ---------- 标签页 ----------
function bindTabs() {
  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    const key = btn.getAttribute('data-tab');
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b === btn));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('on', p.id === 'panel-' + key));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// ---------- 配置区块折叠 ----------
function bindAccordion() {
  document.querySelectorAll('#panel-cfg .acc-head').forEach((h) => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('open'));
  });
}

// ---------- 记录详情弹窗 ----------
function bindDetail() {
  $('detailClose').addEventListener('click', closeDetail);
  $('detailMask').addEventListener('click', (e) => { if (e.target === $('detailMask')) closeDetail(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
}
function closeDetail() {
  $('detailMask').classList.remove('on');
  $('detailBody').innerHTML = '';
  document.querySelector('#detailMask .t').textContent = '打卡详情';
}

// 通用信息弹窗（复用详情弹窗容器）
function openMsg(title, html) {
  document.querySelector('#detailMask .t').textContent = title;
  $('detailBody').innerHTML = html;
  $('detailMask').classList.add('on');
}

// 轻提示
let toastTimer = null;
function toast(msg, type) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast show ' + (type || '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast ' + (type || ''); }, 2400);
}

// 复制文本（clipboard 在非 HTTPS 环境不可用时回退）
async function copyText(txt) {
  try {
    await navigator.clipboard.writeText(txt);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

// 密码展示块（含复制按钮）
function pwdBlock(label, pw) {
  return `<div class="kv"><span class="k">${label}</span>
      <span class="v"><code style="font-size:14px;background:#f2f5f9;border-radius:6px;padding:2px 8px;">${esc(pw)}</code></span></div>
    <button class="btn ghost sm" style="width:100%;margin-top:14px;" data-copy="${esc(pw)}">📋 复制密码</button>
    <p class="hint" style="text-align:center;">请转交用户，此密码仅本次显示；首次登录需修改。</p>`;
}

async function openDetail(id) {
  const r = recCache.get(id);
  if (!r) return;
  document.querySelector('#detailMask .t').textContent = '打卡详情';
  const kv = (k, v) => `<div class="kv"><span class="k">${k}</span><span class="v">${v || '<span class="muted">—</span>'}</span></div>`;
  const coord = (r.lat != null && r.lng != null)
    ? `${Number(r.lat).toFixed(6)}, ${Number(r.lng).toFixed(6)}`
    : '';
  const acc = r.accuracy != null ? `${Math.round(r.accuracy)} m` : '';
  const ins = (r.inspections && r.inspections.length)
    ? r.inspections.map((i) => `<span class="tag ${i.status}">${esc(i.name)}·${i.status === 'ok' ? '正常' : '异常'}</span>`).join(' ')
    : '<span class="muted">无巡检项</span>';
  // 照片体积：展示客户端压缩效果
  const photoInfo = (() => {
    const cur = Number(r.photo_bytes);
    const raw = Number(r.photo_raw_bytes);
    if (!cur) return '';
    if (!raw || raw <= cur) return fmtBytes(cur);
    return `${fmtBytes(cur)} <span class="muted">（原始 ${fmtBytes(raw)} · 省 ${Math.round((1 - cur / raw) * 100)}%）</span>`;
  })();

  $('detailBody').innerHTML = `
    <img class="big" id="dPhoto" alt="打卡照片" style="display:${r.photo ? 'block' : 'none'};" />
    ${kv('时间', fmtLocal(r.created_at))}
    ${kv('姓名', esc(r.name))}
    ${kv('工号', esc(r.staff_id))}
    ${kv('机房', esc(r.location))}
    ${kv('水印模板', esc(r.wm_template))}
    ${kv('照片体积', photoInfo)}
    ${kv('巡检', ins)}
    ${kv('说明', esc(r.custom_text))}
    ${kv('备注', esc(r.note))}
    ${kv('坐标', coord)}
    ${kv('精度', acc)}
    ${kv('记录 ID', r.id)}`;
  $('detailMask').classList.add('on');
  if (r.photo) {
    const url = await photoBlobUrl(r.photo);
    const img = $('dPhoto');
    if (url && img) img.src = url;
    else if (img) img.style.display = 'none';
  }
}

// ---------- 打卡记录列表（管理员：全部） ----------
function params() {
  const p = new URLSearchParams();
  p.set('page', page);
  p.set('pageSize', pageSize);
  const kw = $('fKw').value.trim();
  const from = $('fFrom').value;
  const to = $('fTo').value;
  if (kw) p.set('q', kw);
  if (from) p.set('from', new Date(from + 'T00:00:00').getTime());
  if (to) p.set('to', new Date(to + 'T23:59:59').getTime());
  if ($('fBad').checked) p.set('bad', '1');
  return p;
}

// 统计概览（今日/本月 打卡数与异常数）
async function loadStats() {
  try {
    const resp = await apiFetch('/api/stats');
    const s = (await resp.json()).data || {};
    const set = (id, v) => { $(id).innerHTML = `${v ?? 0}<span class="u">次</span>`; };
    set('sToday', s.today);
    set('sTodayBad', s.todayBad);
    set('sMonth', s.month);
    set('sMonthBad', s.monthBad);
    $('sTodayBad').classList.toggle('hit', (s.todayBad || 0) > 0);
    $('sMonthBad').classList.toggle('hit', (s.monthBad || 0) > 0);
    renderTrend($('trend'), s.trend);
  } catch (e) {
    console.error('加载统计失败', e);
  }
}

function fmtLocal(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function load() {
  const p = params();
  const resp = await apiFetch('/api/checkins?' + p.toString());
  const data = await resp.json();
  const list = data.data.list || [];
  const tbody = $('tbody');
  tbody.innerHTML = '';
  recCache = new Map();
  if (!list.length) {
    const kw = $('fKw').value.trim();
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">
      <div class="empty"><span class="ico">🗂️</span>
        <div class="t">${kw ? '没有匹配「' + esc(kw) + '」的记录' : '暂无打卡记录'}</div>
        <div>${kw ? '换个关键字，或点「重置」查看全部' : '用户提交打卡后会出现在这里'}</div>
      </div></td></tr>`;
  } else {
    for (const r of list) {
      recCache.set(r.id, r);
      const tr = document.createElement('tr');
      const rowBad = ((r.inspections || []).some((i) => i.status === 'bad'))
        || ['temp_status', 'env_status', 'net_status', 'ups_status'].some((k) => r[k] === 'bad');
      if (rowBad) tr.setAttribute('data-bad', '1');
      tr.innerHTML = `
        <td data-l="时间" style="white-space:nowrap;">${fmtLocal(r.created_at)}</td>
        <td data-l="姓名">${esc(r.name)}${r.staff_id ? `<div class="muted" style="font-size:11.5px;">${esc(r.staff_id)}</div>` : ''}</td>
        <td data-l="机房">${esc(r.location)}</td>
        <td data-l="巡检">${inspTags(r)}</td>
        <td data-l="说明" style="max-width:180px;">${esc(r.custom_text) || '<span class="muted">—</span>'}</td>
        <td data-l="照片">${r.photo
          ? `<img class="thumb" data-photo="${esc(r.photo)}" data-detail="${r.id}" title="点击查看大图" />`
          : '<span class="muted">—</span>'}</td>
        <td data-l="操作" class="op">
          <button class="linkbtn" data-detail="${r.id}">详情</button>
          <button class="linkbtn danger" data-del-checkin="${r.id}">删除</button>
        </td>`;
      tbody.appendChild(tr);
    }
    hydratePhotos(tbody); // 照片经 /api/photo 鉴权加载
  }
  const total = data.data.total || 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (page > pages) page = pages;
  $('count').textContent = `共 ${total} 条`;
  $('pageInfo').textContent = `${page} / ${pages}`;
  $('prev').disabled = page <= 1;
  $('next').disabled = page >= pages;
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 字节数 → 人类可读（照片体积展示用）
function fmtBytes(n) {
  const v = Number(n);
  if (!v && v !== 0) return '-';
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(0) + ' KB';
  return (v / 1024 / 1024).toFixed(2) + ' MB';
}

// 巡检结论：优先用动态项目，旧数据回退固定四列
function inspTags(r) {
  const arr = (r.inspections && r.inspections.length)
    ? r.inspections.map((i) => ({ name: i.name, status: i.status }))
    : [['机房温度', r.temp_status], ['环境', r.env_status], ['网络设备', r.net_status], ['UPS电池', r.ups_status]]
      .filter(([, v]) => v === 'ok' || v === 'bad')
      .map(([name, status]) => ({ name, status }));
  const items = arr
    .filter((i) => i.status === 'ok' || i.status === 'bad')
    .map((i) => `<span class="tag ${i.status}">${esc(i.name)}·${i.status === 'ok' ? '正常' : '不正常'}</span>`);
  return items.length ? `<div class="tags">${items.join('')}</div>` : '<span class="muted">—</span>';
}

// 导出用查询参数：沿用列表的姓名/机房/仅异常筛选，时间范围由所选周期决定
function exportParams(sel) {
  const p = new URLSearchParams();
  const kw = $('fKw').value.trim();
  if (kw) p.set('q', kw);
  if ($('fBad').checked) p.set('bad', '1');
  if (sel && sel.from) p.set('from', sel.from);
  if (sel && sel.to) p.set('to', sel.to);
  if (sel && sel.period !== 'all') p.set('period', sel.label);
  return p;
}

function bindList() {
  // 导出：弹窗里选周期（本月/上月/本周/上周/全部/自定义）+ 格式（HTML 含照片 / HTML 无照片 / CSV）
  $('exportBtn').addEventListener('click', () => {
    const lf = $('fFrom').value;
    const lt = $('fTo').value;
    openExportDialog({
      title: '📤 导出打卡明细',
      // 列表已按日期筛选时，默认沿用该区间
      defaultPeriod: (lf || lt) ? 'custom' : 'month',
      customFrom: lf,
      customTo: lt,
      count: async (r) => {
        const p = exportParams({ from: r.from, to: r.to, period: 'all', label: '' });
        p.set('page', '1'); p.set('pageSize', '1');
        const resp = await apiFetch('/api/checkins?' + p.toString());
        if (!resp.ok) return null;
        const d = await resp.json();
        return (d.data && d.data.total) || 0;
      },
      onExport: async (sel) => {
        const p = exportParams(sel);
        const d = new Date();
        const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
        const ptag = periodTag(sel);
        if (sel.format === 'csv') {
          await downloadFile('/api/export.csv?' + p.toString(), `打卡记录_${ptag}_${stamp}.csv`);
        } else if (sel.format === 'xlsx' || sel.format === 'xlsx-nophoto') {
          const light = sel.format === 'xlsx-nophoto';
          if (light) p.set('photos', '0');
          await downloadFile('/api/export.xlsx?' + p.toString(),
            `机房巡检明细_${ptag}_${stamp}${light ? '_无照片' : ''}.xlsx`);
        } else {
          if (sel.format === 'html-nophoto') p.set('photos', '0');
          const name = `机房巡检明细_${ptag}_${stamp}${sel.format === 'html-nophoto' ? '_无照片' : ''}.html`;
          await downloadFile('/api/export/detail.html?' + p.toString(), name);
        }
        toast('导出完成');
      }
    });
  });
  $('sumBtn').addEventListener('click', async () => {
    const m = $('sumMonth').value;
    if (!m) { toast('请选择汇总月份', 'err'); return; }
    await downloadFile('/api/export-summary.csv?month=' + encodeURIComponent(m), `巡检汇总_${m}.csv`);
  });
  $('searchBtn').addEventListener('click', () => { page = 1; load(); });
  $('fBad').addEventListener('change', () => { page = 1; load(); });
  const kw = $('fKw');
  kw.addEventListener('input', debounce(() => { page = 1; load(); }, 360));
  kw.addEventListener('keydown', (e) => { if (e.key === 'Enter') { page = 1; load(); } });
  $('resetBtn').addEventListener('click', () => {
    $('fKw').value = ''; $('fFrom').value = ''; $('fTo').value = '';
    $('fBad').checked = false;
    page = 1; load();
  });
  $('prev').addEventListener('click', () => { if (page > 1) { page--; load(); } });
  $('next').addEventListener('click', () => { page++; load(); });
}

// ---------- 用户管理 ----------
async function loadUsers() {
  try {
    const resp = await apiFetch('/api/users');
    const users = (await resp.json()).data || [];
    $('userCnt').textContent = `${users.length} 个账号`;
    const ub = $('userBody');
    ub.innerHTML = users.length
      ? users.map((u) => `
        <tr>
          <td>${esc(u.username)}</td>
          <td>${esc(u.display_name)}</td>
          <td>${esc(u.staff_id)}</td>
          <td><span class="tag ${u.role === 'admin' ? 'admin' : 'user'}">${u.role === 'admin' ? '管理员' : '普通用户'}</span></td>
          <td>${u.must_change_pw ? '<span class="tag must">需改密</span>' : '正常'}</td>
          <td class="op">
            <button class="linkbtn" data-reset-user="${u.id}">重置密码</button>
            <button class="linkbtn danger" data-del-user="${u.id}">删除</button>
          </td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="muted" style="text-align:center;padding:14px;">暂无用户</td></tr>';
  } catch (e) {
    console.error('加载用户失败', e);
  }
}

$('addUser').addEventListener('click', async () => {
  const username = $('uName').value.trim();
  if (!username) { toast('请输入登录账号', 'err'); return; }
  const body = {
    username,
    displayName: $('uDisp').value.trim(),
    staffId: $('uStaff').value.trim(),
    role: $('uRole').value,
    password: $('uPw').value.trim()
  };
  const resp = await apiFetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await resp.json();
  if (data.code === 0) {
    $('uName').value = ''; $('uDisp').value = ''; $('uStaff').value = ''; $('uPw').value = '';
    loadUsers();
    if (body.password) toast('用户已创建', 'ok');
    else openMsg('用户已创建', pwdBlock('初始密码', data.data.password));
  } else toast('添加失败：' + data.message, 'err');
});

$('resetAll').addEventListener('click', async () => {
  if (!confirm('确认重置全部普通用户的密码？重置后他们将无法用旧密码登录，需使用新密码并改密。')) return;
  const resp = await apiFetch('/api/users/reset-all', { method: 'POST' });
  const data = await resp.json();
  if (data.code === 0) {
    const rows = data.data.map((x) =>
      `<div class="kv"><span class="k">${esc(x.username)}</span>
        <span class="v"><code style="font-size:13.5px;background:#f2f5f9;border-radius:6px;padding:1px 7px;">${esc(x.password)}</code></span></div>`
    ).join('');
    openMsg('已重置全部普通用户密码', rows + '<p class="hint">请逐一转交用户，新密码仅本次显示；用户下次登录需改密。</p>');
    loadUsers();
  } else toast('重置失败：' + data.message, 'err');
});

// ---------- 巡检模板 / 机房分组 / 机房 ----------
let tplCache = [];
let grpCache = [];
let roomCache = [];

async function loadConfigAll() {
  try {
    const [tr, gr, rr] = await Promise.all([
      apiFetch('/api/inspect/templates'),
      apiFetch('/api/room-groups'),
      apiFetch('/api/rooms')
    ]);
    tplCache = (await tr.json()).data || [];
    grpCache = (await gr.json()).data || [];
    roomCache = (await rr.json()).data || [];
    renderTemplates();
    renderGroups();
    renderRooms();
    fillSelects();
  } catch (e) {
    console.error('加载巡检配置失败', e);
  }
}

function renderTemplates() {
  const box = $('tplList');
  $('tplCnt').textContent = `${tplCache.length} 个模板`;
  if (!tplCache.length) {
    box.innerHTML = '<div class="tpl-empty">暂无巡检模板。未绑定模板的机房打卡时无需选择巡检项目。</div>';
    return;
  }
  box.innerHTML = tplCache.map((t) => {
    const used = grpCache.filter((g) => g.template_id === t.id).length;
    const chips = (t.items || []).map((it) =>
      `<span class="chip">${esc(it.name)}<button class="chip-del" data-del-item="${it.id}" title="删除该项目">×</button></span>`
    ).join('');
    return `<div class="tpl-card">
      <div class="tpl-head">
        <span class="tpl-name">${esc(t.name)}</span>
        <span class="tpl-desc">${esc(t.description || '')}</span>
        <span class="tpl-use">${used} 个分组合用</span>
        <button class="linkbtn danger" data-del-tpl="${t.id}">删除模板</button>
      </div>
      <div class="tpl-items">
        ${chips || '<span class="muted" style="font-size:12.5px;">暂无巡检项目</span>'}
        <input class="chip-input" data-new-item="${t.id}" placeholder="+ 巡检项目名称" />
        <button class="chip-add" data-add-item="${t.id}">添加项目</button>
      </div>
    </div>`;
  }).join('');
}

function tplOptions(sel) {
  return '<option value="">— 不绑定 —</option>' + tplCache.map((t) =>
    `<option value="${t.id}"${Number(sel) === t.id ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
}
function grpOptions(sel) {
  return '<option value="">— 未分组 —</option>' + grpCache.map((g) =>
    `<option value="${g.id}"${Number(sel) === g.id ? ' selected' : ''}>${esc(g.name)}</option>`).join('');
}

function renderGroups() {
  const b = $('grpBody');
  $('grpCnt').textContent = `${grpCache.length} 个分组`;
  b.innerHTML = grpCache.length ? grpCache.map((g) => `
    <tr>
      <td>${esc(g.name)}</td>
      <td><select data-grp-tpl="${g.id}">${tplOptions(g.template_id)}</select></td>
      <td>${g.room_count || 0}</td>
      <td class="op"><button class="linkbtn danger" data-del-grp="${g.id}">删除</button></td>
    </tr>`).join('')
    : '<tr><td colspan="4" class="muted" style="text-align:center;padding:14px;">暂无分组</td></tr>';
}

function renderRooms() {
  const b = $('roomBody');
  $('roomCnt').textContent = `${roomCache.length} 个机房`;
  b.innerHTML = roomCache.length ? roomCache.map((r) => {
    const tpl = tplCache.find((t) => t.id === r.template_id);
    const cnt = tpl ? (tpl.items || []).length : 0;
    const insp = tpl
      ? `${cnt} 项 <span class="muted" style="font-size:11.5px;">（${esc(tpl.name)}）</span>`
      : '<span class="muted">未绑定模板</span>';
    return `<tr>
      <td>${esc(r.name)}</td>
      <td><select data-room-grp="${r.id}">${grpOptions(r.group_id)}</select></td>
      <td>${insp}</td>
      <td class="op"><button class="linkbtn danger" data-del-room="${r.id}">删除</button></td>
    </tr>`;
  }).join('')
    : '<tr><td colspan="4" class="muted" style="text-align:center;padding:14px;">暂无机房</td></tr>';
}

function fillSelects() {
  $('grpTpl').innerHTML = tplOptions(null);
  $('roomGrp').innerHTML = grpOptions(null);
}

async function postJSON(url, body, method) {
  const resp = await apiFetch(url, {
    method: method || 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  return resp.json();
}

$('addTpl').addEventListener('click', async () => {
  const name = $('tplName').value.trim();
  if (!name) { toast('请输入模板名称', 'err'); return; }
  const d = await postJSON('/api/inspect/templates', { name, description: $('tplDesc').value.trim() });
  if (d.code === 0) { $('tplName').value = ''; $('tplDesc').value = ''; await loadConfigAll(); toast('模板已添加', 'ok'); }
  else toast('操作失败：' + d.message, 'err');
});

$('addGrp').addEventListener('click', async () => {
  const name = $('grpName').value.trim();
  if (!name) { toast('请输入分组名称', 'err'); return; }
  const d = await postJSON('/api/room-groups', { name, templateId: $('grpTpl').value || null });
  if (d.code === 0) { $('grpName').value = ''; await loadConfigAll(); toast('分组已添加', 'ok'); }
  else toast('操作失败：' + d.message, 'err');
});

$('addRoom').addEventListener('click', async () => {
  const name = $('roomName').value.trim();
  if (!name) { toast('请输入机房/位置名称', 'err'); return; }
  const d = await postJSON('/api/rooms', { name, groupId: $('roomGrp').value || null });
  if (d.code === 0) { $('roomName').value = ''; await loadConfigAll(); toast('机房已添加', 'ok'); }
  else toast('操作失败：' + d.message, 'err');
});

function bindConfig() {}

// ---------- 统一点击：删除用户 / 重置密码 / 模板 / 分组 / 巡检项目 / 机房 / 记录 ----------
document.addEventListener('click', async (e) => {
  const cp = e.target.getAttribute('data-copy');
  const dd = e.target.getAttribute('data-detail');
  const du = e.target.getAttribute('data-del-user');
  const ru = e.target.getAttribute('data-reset-user');
  const dr = e.target.getAttribute('data-del-room');
  const dc = e.target.getAttribute('data-del-checkin');
  const dt = e.target.getAttribute('data-del-tpl');
  const dg = e.target.getAttribute('data-del-grp');
  const di = e.target.getAttribute('data-del-item');
  const ai = e.target.getAttribute('data-add-item');
  if (cp) {
    const ok = await copyText(cp);
    toast(ok ? '密码已复制' : '复制失败，请手动选择复制', ok ? 'ok' : 'err');
    return;
  }
  if (dd) {
    await openDetail(Number(dd));
  } else if (du) {
    if (!confirm('确认删除该用户？其历史打卡记录将保留但不再关联到账号。')) return;
    const resp = await apiFetch('/api/users/' + du, { method: 'DELETE' });
    const data = await resp.json();
    if (data.code === 0) loadUsers();
    else toast('删除失败：' + (data.message || '未知错误'), 'err');
  } else if (ru) {
    if (!confirm('确认重置该用户密码？重置后用户需用新密码登录并改密。')) return;
    const resp = await apiFetch('/api/users/' + ru + './reset', { method: 'POST' });
    const data = await resp.json();
    if (data.code === 0) {
      openMsg('密码已重置', pwdBlock('新密码', data.data.password));
      loadUsers();
    } else toast('重置失败：' + (data.message || '未知错误'), 'err');
  } else if (dt) {
    if (!confirm('确认删除该巡检模板？其下所有巡检项目将一并删除，引用它的分组会变为未绑定。')) return;
    const d = await postJSON('/api/inspect/templates/' + dt, null, 'DELETE');
    if (d.code === 0) loadConfigAll(); else toast('删除失败：' + d.message, 'err');
  } else if (dg) {
    if (!confirm('确认删除该分组？组内机房将变为未分组（打卡时不再需要巡检项）。')) return;
    const d = await postJSON('/api/room-groups/' + dg, null, 'DELETE');
    if (d.code === 0) loadConfigAll(); else toast('删除失败：' + d.message, 'err');
  } else if (di) {
    if (!confirm('确认删除该巡检项目？已提交的历史记录不受影响。')) return;
    const d = await postJSON('/api/inspect/items/' + di, null, 'DELETE');
    if (d.code === 0) loadConfigAll(); else toast('删除失败：' + d.message, 'err');
  } else if (ai) {
    const input = document.querySelector(`[data-new-item="${ai}"]`);
    const name = (input && input.value || '').trim();
    if (!name) { toast('请输入巡检项目名称', 'err'); return; }
    const d = await postJSON('/api/inspect/templates/' + ai + './items', { name });
    if (d.code === 0) loadConfigAll(); else toast('操作失败：' + d.message, 'err');
  } else if (dr) {
    if (!confirm('确认删除该机房？历史打卡记录不受影响。')) return;
    const d = await postJSON('/api/rooms/' + dr, null, 'DELETE');
    if (d.code === 0) loadConfigAll(); else toast('删除失败：' + d.message, 'err');
  } else if (dc) {
    if (!confirm('确认删除该打卡记录？此操作不可恢复，照片也会一并删除。')) return;
    const resp = await apiFetch('/api/checkins/' + dc, { method: 'DELETE' });
    const data = await resp.json();
    if (data.code === 0) { load(); loadStats(); }
    else toast('删除失败：' + (data.message || '未知错误'), 'err');
  }
});

// ---------- 下拉联动：分组的模板 / 机房的所属分组 ----------
document.addEventListener('change', async (e) => {
  const gt = e.target.getAttribute('data-grp-tpl');
  const rg = e.target.getAttribute('data-room-grp');
  if (gt) {
    const d = await postJSON('/api/room-groups/' + gt, { templateId: e.target.value || null }, 'PUT');
    if (d.code === 0) loadConfigAll(); else toast('保存失败：' + d.message, 'err');
  } else if (rg) {
    const d = await postJSON('/api/rooms/' + rg, { groupId: e.target.value || null }, 'PUT');
    if (d.code === 0) loadConfigAll(); else toast('保存失败：' + d.message, 'err');
  }
});

// 巡检项目输入框回车即添加
document.addEventListener('keydown', (e) => {
  const tplId = e.target.getAttribute && e.target.getAttribute('data-new-item');
  if (tplId && e.key === 'Enter') {
    e.preventDefault();
    const btn = document.querySelector(`[data-add-item="${tplId}"]`);
    if (btn) btn.click();
  }
});

// ---------- 水印模板 ----------
let wmTpls = [];           // 服务端模板列表
let wmCurId = null;        // 当前编辑的模板 id（null = 新建草稿）
let wmAccentPick = '';     // 当前选中的主题色

function wmCurTpl() {
  return wmTpls.find((t) => Number(t.id) === Number(wmCurId)) || null;
}

async function loadWatermark(keepId) {
  try {
    const r = await apiFetch('/api/watermark/templates');
    const d = await r.json();
    wmTpls = d.code === 0 && Array.isArray(d.data) ? d.data : [];
  } catch (e) { wmTpls = []; }
  // 兜底：老接口（单套配置）
  if (!wmTpls.length) {
    let cfg = wmNormalize({});
    try {
      const r2 = await apiFetch('/api/watermark');
      const d2 = await r2.json();
      if (d2.code === 0) cfg = wmNormalize(d2.data || {});
    } catch (e) { /* 用默认值 */ }
    wmTpls = [{ id: 0, name: '标准打卡水印', config: cfg, isDefault: true }];
  }
  const want = keepId != null ? Number(keepId) : Number(wmCurId);
  const hit = wmTpls.find((t) => Number(t.id) === want);
  wmCurId = hit ? hit.id : wmTpls[0].id;
  paintWmSelect();
  paintWmForm();
}

function paintWmSelect() {
  const sel = $('wmTplSel');
  if (!sel) return;
  const def = wmTpls.find((t) => t.isDefault);
  sel.innerHTML = wmTpls.map((t) =>
    `<option value="${t.id}">${esc(t.name)}${t.isDefault ? '（默认）' : ''}</option>`
  ).join('') + (wmCurId == null ? '<option value="">新模板（未保存）</option>' : '');
  sel.value = wmCurId != null ? String(wmCurId) : '';
  const n = $('wmTplCnt');
  if (n) n.textContent = `${wmTpls.length} 套 · 默认：${def ? def.name : '—'}`;
}

// 把当前模板配置写回表单
function paintWmForm() {
  const t = wmCurTpl();
  const c = wmNormalize(t ? t.config : {});
  wmAccentPick = c.accent;
  $('setWmName').value = t ? t.name : '新水印模板';
  $('setWmTitle').value = c.title;
  $('setWmOrg').value = c.org;
  $('wmShowTime').checked = c.showTime;
  $('wmShowCoord').checked = c.showCoord;
  $('wmShowStaff').checked = c.showStaff;
  $('wmShowLocation').checked = c.showLocation;
  $('wmShowInspect').checked = c.showInspect;
  $('wmShowCustom').checked = c.showCustom;
  $('wmShowNote').checked = c.showNote;
  $('wmAllowCustom').checked = c.allowCustom;
  paintWmColors();
  syncWmForm();
}

function paintWmColors() {
  const list = WM_ACCENTS.includes(wmAccentPick) ? WM_ACCENTS : WM_ACCENTS.concat([wmAccentPick]);
  $('wmColors').innerHTML = list.map((col) =>
    `<button class="wm-color${col === wmAccentPick ? ' on' : ''}" type="button"
       data-color="${col}" style="background:${col}" title="${col}"></button>`
  ).join('');
}

// 表单 → 配置草稿（未保存也能实时预览）
function wmDraft() {
  return wmNormalize({
    title: $('setWmTitle').value,
    org: $('setWmOrg').value,
    accent: wmAccentPick || WM_FALLBACK.accent,
    showTime: $('wmShowTime').checked,
    showCoord: $('wmShowCoord').checked,
    showStaff: $('wmShowStaff').checked,
    showLocation: $('wmShowLocation').checked,
    showInspect: $('wmShowInspect').checked,
    showCustom: $('wmShowCustom').checked,
    showNote: $('wmShowNote').checked,
    allowCustom: $('wmAllowCustom').checked
  });
}

// 字数统计 + 预览 + 头部状态
function syncWmForm() {
  const name = $('setWmName').value;
  const t = $('setWmTitle').value;
  const o = $('setWmOrg').value;
  $('setWmNameCnt').textContent = `${name.length}/24`;
  $('setWmTitleCnt').textContent = `${t.length}/20`;
  $('setWmOrgCnt').textContent = `${o.length}/24`;

  const cur = wmCurTpl();
  const isDef = !!(cur && cur.isDefault);
  const note = $('wmTplNote');
  if (note) {
    note.innerHTML = cur
      ? `正在编辑 <b>${esc(cur.name)}</b>${isDef ? '（系统默认，打卡页默认选中）' : ''}`
        + ` · ${wmDraft().allowCustom ? '允许现场改标题' : '标题固定'}`
      : '正在新建模板，填好后点「保存模板」创建。';
  }
  const head = $('wmHead');
  if (head) head.textContent = `${wmTpls.length} 套模板`;
  if ($('wmTplDefault')) $('wmTplDefault').textContent = isDef ? '已是默认' : '设为默认';
  if ($('wmTplDefault')) $('wmTplDefault').disabled = isDef || !cur;
  if ($('wmTplDel')) $('wmTplDel').disabled = !cur || wmTpls.length <= 1;

  renderAdmPreview();
}

function renderAdmPreview() {
  const cv = $('admWmPreview');
  if (cv) wmPreview(cv, wmDraft(), null, 480);
}

function bindWatermark() {
  ['setWmName', 'setWmTitle', 'setWmOrg'].forEach((id) => {
    $(id).addEventListener('input', syncWmForm);
  });
  ['wmShowTime', 'wmShowCoord', 'wmShowStaff', 'wmShowLocation', 'wmShowInspect', 'wmShowCustom', 'wmShowNote', 'wmAllowCustom']
    .forEach((id) => $(id).addEventListener('change', syncWmForm));

  $('wmColors').addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    wmAccentPick = b.getAttribute('data-color');
    paintWmColors();
    renderAdmPreview();
  });

  $('wmTplSel').addEventListener('change', (e) => {
    wmCurId = Number(e.target.value);
    paintWmForm();
  });

  // 新建：先出一份未保存的草稿（默认沿用当前模板的字段开关，标题清空）
  $('wmTplNew').addEventListener('click', () => {
    wmCurId = null;
    const base = wmNormalize(wmDraft());
    paintWmSelect();
    $('setWmName').value = '新水印模板';
    $('setWmTitle').value = base.title;
    $('setWmOrg').value = '';
    wmAccentPick = base.accent;
    paintWmColors();
    syncWmForm();
    $('setWmName').focus();
    $('setWmName').select();
  });

  $('saveWm').addEventListener('click', async () => {
    const btn = $('saveWm');
    const body = { name: $('setWmName').value.trim() || '未命名水印', config: wmDraft() };
    btn.disabled = true;
    try {
      const url = wmCurId ? '/api/watermark/templates/' + wmCurId : '/api/watermark/templates';
      const d = await postJSON(url, body, wmCurId ? 'PUT' : 'POST');
      if (d.code === 0) {
        const savedId = d.data && d.data.id;
        toast(wmCurId ? '模板已保存' : '模板已创建', 'ok');
        await loadWatermark(savedId || wmCurId);
      } else {
        toast('保存失败：' + d.message, 'err');
      }
    } finally {
      btn.disabled = false;
    }
  });

  $('wmTplDefault').addEventListener('click', async () => {
    if (!wmCurId) return toast('请先保存模板', 'err');
    const d = await postJSON('/api/watermark/templates/' + wmCurId + './default', null, 'POST');
    if (d.code === 0) {
      toast('已设为系统默认模板', 'ok');
      await loadWatermark(wmCurId);
    } else {
      toast('设置失败：' + d.message, 'err');
    }
  });

  $('wmTplDel').addEventListener('click', async () => {
    const cur = wmCurTpl();
    if (!cur) return toast('当前是未保存的草稿', 'err');
    if (!confirm(`删除模板「${cur.name}」？打卡页将不再出现该选项（历史记录不受影响）。`)) return;
    const d = await postJSON('/api/watermark/templates/' + cur.id, null, 'DELETE');
    if (d.code === 0) {
      toast('模板已删除', 'ok');
      await loadWatermark(d.data && d.data.defaultId);
    } else {
      toast('删除失败：' + d.message, 'err');
    }
  });

  $('resetWm').addEventListener('click', () => {
    const c = wmNormalize({});
    $('setWmTitle').value = c.title;
    $('setWmOrg').value = c.org;
    wmAccentPick = c.accent;
    paintWmColors();
    syncWmForm();
    toast('已恢复为默认值，记得点「保存模板」', 'ok');
  });
}
