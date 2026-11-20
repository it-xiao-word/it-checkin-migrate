'use strict';
const $ = (id) => document.getElementById(id);
let page = 1;
const pageSize = 20;
let photoUrls = {};   // 照片名 → blob URL（用于弹窗大图）

(async function init() {
  const me = await ensureAuth();
  if (!me) return;

  $('logoutBtn').addEventListener('click', logout);

  // 筛选面板展开 / 收起
  const acc = $('filterToggle').parentElement;
  $('filterToggle').addEventListener('click', () => acc.classList.toggle('open'));

  $('searchBtn').addEventListener('click', () => { page = 1; load(); });
  $('fBad').addEventListener('change', () => { page = 1; load(); });
  // 关键字搜索：输入防抖，300ms 后自动查询；回车立即查
  const kw = $('fKw');
  const runKw = () => {
    $('fKwClear').hidden = !kw.value.trim();
    page = 1; load();
  };
  kw.addEventListener('input', debounce(() => { if (kw.value.trim().length >= 1) runKw(); else if (!kw.value) runKw(); }, 340));
  kw.addEventListener('keydown', (e) => { if (e.key === 'Enter') runKw(); });
  $('fKwClear').addEventListener('click', () => { kw.value = ''; runKw(); kw.focus(); });
  $('resetBtn').addEventListener('click', () => {
    $('fFrom').value = ''; $('fTo').value = ''; $('fLoc').value = ''; $('fBad').checked = false;
    kw.value = ''; $('fKwClear').hidden = true;
    document.querySelectorAll('#presets .chip-btn').forEach((x) => x.classList.remove('on'));
    page = 1; load();
  });
  // 快捷日期区间
  const fmtD = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  $('presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]');
    if (!b) return;
    const now = new Date();
    const range = b.getAttribute('data-range');
    const from = range === 'today' ? now
      : range === '7' ? new Date(Date.now() - 6 * 864e5)
      : new Date(now.getFullYear(), now.getMonth(), 1);
    $('fFrom').value = fmtD(from);
    $('fTo').value = fmtD(now);
    document.querySelectorAll('#presets .chip-btn').forEach((x) => x.classList.toggle('on', x === b));
    page = 1; load();
  });
  $('prev').addEventListener('click', () => { if (page > 1) { page--; load(); } });
  $('next').addEventListener('click', () => { page++; load(); });
  const dateTag = () => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  };
  // 导出：周期（本月/上月/本周/上周/全部/自定义）+ 格式（HTML 含照片 / HTML 无照片 / CSV）
  $('exportBtn').addEventListener('click', () => {
    const lf = $('fFrom').value;
    const lt = $('fTo').value;
    openExportDialog({
      title: '📤 导出我的打卡明细',
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
        const ptag = periodTag(sel);
        if (sel.format === 'csv') {
          await downloadFile('/api/export.csv?' + p.toString(), `我的打卡记录_${ptag}_${dateTag()}.csv`);
        } else if (sel.format === 'xlsx' || sel.format === 'xlsx-nophoto') {
          const light = sel.format === 'xlsx-nophoto';
          if (light) p.set('photos', '0');
          await downloadFile('/api/export.xlsx?' + p.toString(),
            `我的巡检明细_${ptag}_${dateTag()}${light ? '_无照片' : ''}.xlsx`);
        } else {
          if (sel.format === 'html-nophoto') p.set('photos', '0');
          const name = `我的巡检明细_${ptag}_${dateTag()}${sel.format === 'html-nophoto' ? '_无照片' : ''}.html`;
          await downloadFile('/api/export/detail.html?' + p.toString(), name);
        }
        toast('导出完成');
      }
    });
  });

  // 照片大图弹窗
  $('photoClose').addEventListener('click', closePhoto);
  $('photoMask').addEventListener('click', (e) => { if (e.target === $('photoMask')) closePhoto(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePhoto(); });

  loadStats();
  loadRooms();
  load();
})();

function openPhoto(name) {
  const url = photoUrls[name];
  if (!url) return;
  $('photoBig').src = url;
  $('photoMask').classList.add('on');
}
function closePhoto() {
  $('photoMask').classList.remove('on');
  $('photoBig').removeAttribute('src');
}

// 本月统计（普通用户仅本人）+ 近 7 日趋势
async function loadStats() {
  try {
    const resp = await apiFetch('/api/stats');
    const s = (await resp.json()).data || {};
    $('sMonth').innerHTML = `${s.month ?? 0}<span class="u">次</span>`;
    $('sMonthBad').innerHTML = `${s.monthBad ?? 0}<span class="u">次</span>`;
    $('sMonthBad').classList.toggle('hit', (s.monthBad || 0) > 0);
    renderTrend($('trend'), s.trend);
  } catch (e) { /* 忽略 */ }
}

// 机房下拉（取自管理端配置）
async function loadRooms() {
  try {
    const resp = await apiFetch('/api/rooms');
    const rooms = (await resp.json()).data || [];
    $('fLoc').innerHTML = '<option value="">全部</option>' + rooms.map((x) =>
      `<option value="${esc(x.name)}">${esc(x.name)}</option>`).join('');
  } catch (e) { /* 忽略，保留"全部" */ }
}

function params() {
  const p = new URLSearchParams();
  p.set('page', page);
  p.set('pageSize', pageSize);
  const from = $('fFrom').value;
  const to = $('fTo').value;
  if (from) p.set('from', new Date(from + 'T00:00:00').getTime());
  if (to) p.set('to', new Date(to + 'T23:59:59').getTime());
  const loc = $('fLoc').value.trim();
  if (loc) p.set('location', loc);
  const kwv = $('fKw').value.trim();
  if (kwv) p.set('q', kwv);
  if ($('fBad').checked) p.set('bad', '1');
  return p;
}

// 导出用参数：沿用机房/仅异常/关键字筛选，时间范围由所选周期决定
function exportParams(sel) {
  const p = new URLSearchParams();
  const loc = $('fLoc').value.trim();
  if (loc) p.set('location', loc);
  const kwv = $('fKw').value.trim();
  if (kwv) p.set('q', kwv);
  if ($('fBad').checked) p.set('bad', '1');
  if (sel && sel.from) p.set('from', sel.from);
  if (sel && sel.to) p.set('to', sel.to);
  if (sel && sel.period !== 'all') p.set('period', sel.label);
  return p;
}

function fmtLocal(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function dayKey(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso).slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const y = new Date(today.getTime() - 86400000);
  const isYest = d.toDateString() === y.toDateString();
  const base = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}`;
  return isToday ? `今天 · ${base}` : isYest ? `昨天 · ${base}` : base;
}
function hhmm(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 巡检结论：优先用动态项目，旧数据回退固定四列
function inspItems(r) {
  return (r.inspections && r.inspections.length)
    ? r.inspections.map((i) => ({ name: i.name, status: i.status }))
    : [['机房温度', r.temp_status], ['环境', r.env_status], ['网络设备', r.net_status], ['UPS电池', r.ups_status]]
      .map(([name, status]) => ({ name, status }));
}
function inspTags(r) {
  const items = inspItems(r)
    .filter((i) => i.status === 'ok' || i.status === 'bad')
    .map((i) => `<span class="tag ${i.status}">${esc(i.name)}·${i.status === 'ok' ? '正常' : '异常'}</span>`);
  return items.length ? items.join('') : '<span class="muted" style="font-size:12px;">无巡检项</span>';
}

async function load() {
  const box = $('recList');
  box.innerHTML = '<div class="rec-item skel" style="height:92px;"></div>';
  try {
    const resp = await apiFetch('/api/checkins?' + params().toString());
    const data = await resp.json();
    const list = (data.data && data.data.list) || [];
    box.innerHTML = '';
    if (!list.length) {
      const kwv = $('fKw').value.trim();
      box.innerHTML = `<div class="empty"><span class="ico">🗂️</span>
        <div class="t">${kwv ? '没有匹配「' + esc(kwv) + '」的记录' : '暂无打卡记录'}</div>
        <div>${kwv ? '换个关键字，或清空搜索查看全部' : '换个筛选条件试试，或去打卡页提交一条'}</div></div>`;
    } else {
      let lastDay = '';
      list.forEach((r) => {
        const key = dayKey(r.created_at);
        if (key !== lastDay) {
          lastDay = key;
          const d = document.createElement('div');
          d.className = 'rec-day';
          d.innerHTML = `<span class="rec-day-t">${dayLabel(r.created_at)}</span>`;
          box.appendChild(d);
        }
        const bad = inspItems(r).some((i) => i.status === 'bad');
        const el = document.createElement('article');
        el.className = `rec-item ${bad ? 'is-bad' : 'is-ok'}`;
        el.innerHTML = `
          <div class="rec-main">
            <div class="rec-top">
              <span class="rec-loc">${esc(r.location) || '未填写机房'}</span>
              <span class="rec-time">${hhmm(r.created_at)}</span>
              <span class="badge dot ${bad ? 'bad' : 'ok'}">${bad ? '有异常' : '正常'}</span>
            </div>
            <div class="rec-tags">${inspTags(r)}</div>
            ${r.custom_text ? `<div class="rec-note"><span class="lb">说明</span>${esc(r.custom_text)}</div>` : ''}
            ${r.note ? `<div class="rec-note"><span class="lb">备注</span>${esc(r.note)}</div>` : ''}
            ${r.wm_template ? `<div class="rec-foot"><span class="rec-wm"><i class="rec-wm-dot"></i>水印 · ${esc(r.wm_template)}</span></div>` : ''}
          </div>
          ${r.photo ? `<div class="rec-photo"><img class="thumb" data-photo="${esc(r.photo)}" title="点击查看大图" /></div>` : ''}`;
        box.appendChild(el);
      });
      // 照片经 /api/photo 鉴权加载，并记录 blob 地址供弹窗复用
      const imgs = box.querySelectorAll('img[data-photo]');
      for (const img of imgs) {
        const name = img.getAttribute('data-photo');
        const url = await photoBlobUrl(name);
        if (url) { img.src = url; photoUrls[name] = url; img.addEventListener('click', () => openPhoto(name)); }
      }
    }
    const total = (data.data && data.data.total) || 0;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (page > pages) page = pages;
    $('count').textContent = `共 ${total} 条`;
    $('pageInfo').textContent = `${page} / ${pages}`;
    $('prev').disabled = page <= 1;
    $('next').disabled = page >= pages;
    updateFilterInfo(total);
  } catch (e) {
    box.innerHTML = `<div class="empty"><span class="ico">⚠️</span><div class="t">加载失败</div><div>${esc(e.message)}</div></div>`;
  }
}

function updateFilterInfo(total) {
  const parts = [];
  const kwv = $('fKw').value.trim();
  if (kwv) parts.push('「' + kwv + '」');
  if ($('fFrom').value) parts.push('从 ' + $('fFrom').value);
  if ($('fTo').value) parts.push('到 ' + $('fTo').value);
  if ($('fLoc').value) parts.push($('fLoc').value);
  if ($('fBad').checked) parts.push('只看异常');
  $('filterInfo').textContent = parts.length ? `${parts.join(' · ')}（${total} 条）` : `全部记录（${total} 条）`;
}
