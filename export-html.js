'use strict';
// 单文件 HTML 明细报告导出（照片以 base64 内嵌，离线可看、可直接打印/存 PDF）
const fs = require('fs');
const path = require('path');

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
const p2 = (n) => String(n).padStart(2, '0');

function tsOf(r) {
  if (r.created_ts) return Number(r.created_ts);
  const t = Date.parse(r.created_at || '');
  return Number.isFinite(t) ? t : 0;
}
function fmtDT(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
function fmtHM(ts) {
  const d = new Date(ts);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
function dayLabel(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${WEEK[d.getDay()]}`;
}

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
function mimeOf(name) { return MIME[path.extname(String(name || '')).toLowerCase()] || 'image/jpeg'; }

// 读取照片并转成 data URI；文件不存在时返回 null（报告里显示占位）
function photoDataUri(uploadDir, name) {
  try {
    const base = path.basename(String(name || ''));
    if (!/^ck_[A-Za-z0-9._-]+\.(jpe?g|png|webp|gif)$/i.test(base)) return null;
    const fp = path.join(uploadDir, base);
    if (!fp.startsWith(uploadDir)) return null;
    const buf = fs.readFileSync(fp);
    return { uri: `data:${mimeOf(base)};base64,${buf.toString('base64')}`, bytes: buf.length };
  } catch (e) { return null; }
}

// 巡检项：优先动态项目，旧数据回退固定四列
function inspOf(r) {
  const arr = (r.inspections && r.inspections.length)
    ? r.inspections.map((i) => ({ name: i.name, status: i.status }))
    : [['机房温度', r.temp_status], ['环境', r.env_status], ['网络设备', r.net_status], ['UPS电池', r.ups_status]]
      .map(([name, status]) => ({ name, status }));
  return arr.filter((i) => i.status === 'ok' || i.status === 'bad');
}
const isBad = (r) => inspOf(r).some((i) => i.status === 'bad');

function inspChips(r) {
  const items = inspOf(r);
  if (!items.length) return '<span class="muted">无巡检项</span>';
  return items.map((i) => `<span class="chip ${i.status}">${esc(i.name)}<b>${i.status === 'ok' ? '正常' : '不正常'}</b></span>`).join('');
}

function fmtMB(bytes) {
  if (!bytes) return '0 KB';
  const mb = bytes / 1048576;
  return mb >= 1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

// 筛选范围说明
function scopeText(query, isAdmin) {
  const parts = [];
  if (query.period) parts.push('周期：' + query.period);
  if (query.from || query.to) {
    const f = query.from ? fmtDT(Number(query.from)).slice(0, 10) : '最早';
    const t = query.to ? fmtDT(Number(query.to)).slice(0, 10) : '至今';
    parts.push(`${f} ~ ${t}`);
  }
  if (query.location) parts.push('机房：' + query.location);
  if (query.name) parts.push('姓名：' + query.name);
  if (query.bad) parts.push('仅异常记录');
  const scope = isAdmin ? '全站记录' : '仅本人记录';
  return scope + (parts.length ? ' · ' + parts.join(' · ') : ' · 全部时间');
}

const CSS = `
*{box-sizing:border-box}
:root{
  --ink:#16202b;--ink2:#33465a;--muted:#6b7b8c;--line:#e4eaf1;--bg:#f4f7fa;
  --brand:#1F3B5A;--brand2:#2f5d86;--ok:#0f8a5f;--okbg:#e8f6ef;--bad:#c0392b;--badbg:#fdecea;
}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);
  font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:26px 18px 60px}

/* 顶部报告头 */
.cover{position:relative;overflow:hidden;background:#fff;border:1px solid var(--line);border-radius:16px;
  padding:24px 26px 20px;box-shadow:0 2px 14px rgba(24,45,68,.06)}
.cover::before{content:"";position:absolute;left:0;top:0;bottom:0;width:5px;
  background:linear-gradient(180deg,var(--brand),#4a7fb3)}
.eyebrow{font-size:12px;letter-spacing:.16em;color:var(--brand2);font-weight:700;text-transform:uppercase}
h1{margin:8px 0 6px;font-size:25px;line-height:1.3;letter-spacing:.5px}
.sub{color:var(--muted);font-size:13px}
.sub b{color:var(--ink2);font-weight:600}
.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-top:20px}
.kpi{background:var(--bg);border:1px solid var(--line);border-radius:11px;padding:11px 12px}
.kpi i{display:block;font-size:11.5px;color:var(--muted);font-style:normal;margin-bottom:2px;white-space:nowrap}
.kpi b{display:block;font-size:20px;font-weight:700;letter-spacing:.3px;white-space:nowrap}
.kpi b em{font-size:11.5px;font-style:normal;color:var(--muted);font-weight:500;margin-left:2px}
.kpi.alert{background:var(--badbg);border-color:#f6cfca}
.kpi.alert b{color:var(--bad)}

/* 日期分组 */
.day{margin-top:24px}
.day-h{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:700;color:var(--brand);
  margin:0 0 10px;padding-bottom:7px;border-bottom:2px solid #dfe7ef}
.day-h .cnt{margin-left:auto;font-size:12px;font-weight:500;color:var(--muted)}
.day-h .dot{width:8px;height:8px;border-radius:50%;background:var(--brand);flex:none}

/* 记录卡 */
.rec{display:grid;grid-template-columns:232px 1fr;gap:18px;background:#fff;border:1px solid var(--line);
  border-radius:14px;padding:14px;margin-bottom:12px;box-shadow:0 1px 6px rgba(24,45,68,.04);
  break-inside:avoid;page-break-inside:avoid}
.rec.bad{border-left:4px solid var(--bad)}
.ph{position:relative;border-radius:10px;overflow:hidden;background:#eef2f6;aspect-ratio:4/3}
.ph img{display:block;width:100%;height:100%;object-fit:cover;cursor:zoom-in;transition:transform .25s}
.ph:hover img{transform:scale(1.03)}
.ph .noimg{display:flex;align-items:center;justify-content:center;height:100%;color:#9aa9b8;font-size:12px}
.ph .idx{position:absolute;left:8px;top:8px;background:rgba(22,32,43,.62);color:#fff;font-size:11px;
  padding:1px 7px;border-radius:20px;letter-spacing:.4px}
.ph .zoom{position:absolute;right:8px;bottom:8px;background:rgba(255,255,255,.9);color:var(--ink2);
  font-size:11px;padding:1px 7px;border-radius:20px}
.meta{min-width:0}
.meta-top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.time{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums}
.room{font-size:13.5px;color:var(--brand);background:#eef4fa;border:1px solid #dbe7f3;
  padding:1px 9px;border-radius:20px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{margin-left:auto;font-size:11.5px;padding:2px 9px;border-radius:20px;font-weight:600;white-space:nowrap}
.badge.ok{background:var(--okbg);color:var(--ok)}
.badge.bad{background:var(--badbg);color:var(--bad)}
.who{margin-top:7px;font-size:13px;color:var(--ink2)}
.who .sep{color:#c3cfdb;margin:0 7px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.chip{display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:2px 9px;border-radius:7px;
  border:1px solid transparent}
.chip b{font-weight:600;font-size:11.5px}
.chip.ok{background:var(--okbg);color:#0b6d4b;border-color:#cfeade}
.chip.bad{background:var(--badbg);color:var(--bad);border-color:#f6cfca}
.muted{color:var(--muted);font-size:12.5px}
.txt{margin-top:9px;font-size:13px;color:var(--ink2);background:var(--bg);border:1px solid var(--line);
  border-left:3px solid #c9d7e4;border-radius:0 8px 8px 0;padding:7px 11px;white-space:pre-wrap;word-break:break-word}
.txt.warn{background:#fff8f0;border-color:#f7e0c4;border-left-color:#e08c34;color:#8a4f12}
.txt .lbl{display:inline-block;font-size:11px;font-weight:700;color:var(--muted);margin-right:7px;letter-spacing:.5px}
.foot{margin-top:10px;display:flex;gap:14px;flex-wrap:wrap;font-size:11.5px;color:var(--muted)}
.foot a{color:var(--brand2);text-decoration:none;border-bottom:1px dashed #b9cde0}
.foot .id{margin-left:auto;font-variant-numeric:tabular-nums}

/* 附录统计 */
.sec{margin-top:34px}
.sec-h{font-size:15px;font-weight:700;color:var(--brand);margin:0 0 10px;display:flex;align-items:center;gap:8px}
.sec-h::before{content:"";width:3px;height:15px;background:var(--brand);border-radius:2px}
.tables{display:grid;grid-template-columns:1fr 1fr;gap:16px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:12px;
  overflow:hidden;font-size:12.5px}
th,td{padding:7px 10px;text-align:left;border-bottom:1px solid #eef2f7}
th{background:#f2f6fa;color:var(--brand);font-weight:600;white-space:nowrap}
tr:last-child td{border-bottom:none}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td.bad{color:var(--bad);font-weight:600}

.final{margin-top:34px;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);
  font-size:11.5px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}

/* 悬浮工具条 */
.toolbar{position:fixed;right:18px;bottom:18px;display:flex;gap:8px;z-index:40}
.toolbar button{appearance:none;border:1px solid rgba(255,255,255,.16);border-radius:24px;cursor:pointer;
  background:rgba(31,59,90,.94);color:#fff;font-size:13px;padding:9px 16px;font-weight:600;
  box-shadow:0 6px 20px rgba(20,40,65,.28);backdrop-filter:blur(6px)}
.toolbar button:hover{background:#27496e}
.toolbar button.ghost{background:rgba(255,255,255,.94);color:var(--brand)}

/* 大图预览 */
.lb{position:fixed;inset:0;background:rgba(12,20,29,.9);display:none;align-items:center;justify-content:center;z-index:60}
.lb.on{display:flex}
.lb img{max-width:92vw;max-height:82vh;border-radius:8px;box-shadow:0 12px 50px rgba(0,0,0,.5)}
.lb-cap{position:absolute;bottom:22px;left:0;right:0;text-align:center;color:#dbe6f0;font-size:13px}
.lb button{position:absolute;appearance:none;border:none;cursor:pointer;background:rgba(255,255,255,.14);
  color:#fff;border-radius:50%;width:42px;height:42px;font-size:20px;line-height:1;display:flex;
  align-items:center;justify-content:center}
.lb button:hover{background:rgba(255,255,255,.26)}
.lb .prev{left:14px}.lb .next{right:14px}.lb .close{right:14px;top:14px;width:36px;height:36px;font-size:16px}

@media (max-width:820px){
  .wrap{padding:16px 12px 70px}
  .cover{padding:18px 16px}
  h1{font-size:20px}
  .kpis{grid-template-columns:repeat(3,1fr)}
  .rec{grid-template-columns:1fr;gap:12px}
  .ph{aspect-ratio:16/9}
  .tables{grid-template-columns:1fr}
}
@media print{
  .toolbar,.lb{display:none!important}
  body{background:#fff}
  .wrap{max-width:none;padding:0}
  .cover,.rec,table{box-shadow:none}
  .cover{border-radius:0}
  .rec{margin-bottom:10px}
  a{color:inherit;text-decoration:none;border:none}
  @page{size:A4;margin:12mm}
}
`;

function headerHtml(meta) {
  const k = meta.kpi;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="IT机房巡检打卡系统" />
<title>${esc(meta.title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="cover">
    <div class="eyebrow">IT 机房运维 · 现场打卡留档</div>
    <h1>机房巡检打卡明细报告</h1>
    <div class="sub">
      统计范围：<b>${esc(meta.scope)}</b><br />
      导出时间：<b>${esc(meta.generated)}</b> · 导出人：<b>${esc(meta.operator)}</b>
    </div>
    <div class="kpis">
      <div class="kpi"><i>打卡记录</i><b>${k.total}<em>条</em></b></div>
      <div class="kpi${k.bad ? ' alert' : ''}"><i>异常记录</i><b>${k.bad}<em>条</em></b></div>
      <div class="kpi"><i>异常率</i><b>${k.rate}<em>%</em></b></div>
      <div class="kpi"><i>覆盖机房</i><b>${k.rooms}<em>个</em></b></div>
      <div class="kpi"><i>参与人员</i><b>${k.people}<em>人</em></b></div>
      <div class="kpi"><i>内嵌照片</i><b>${k.photos}<em>张</em></b></div>
    </div>
    <div class="foot" style="margin-top:14px;">
      <span>文件体积约 ${esc(meta.sizeHint)}（照片已内嵌，可离线查看与打印）</span>
      <span>时间跨度 ${esc(meta.range)}</span>
    </div>
  </header>
  <main>
`;
}

function recordHtml(r, idx, photo) {
  const bad = isBad(r);
  const ts = tsOf(r);
  const coord = (r.lat != null && r.lng != null && (r.lat || r.lng))
    ? `${Number(r.lat).toFixed(6)}, ${Number(r.lng).toFixed(6)}`
    : '';
  const amap = coord
    ? `https://uri.amap.com/marker?position=${Number(r.lng)},${Number(r.lat)}&name=${encodeURIComponent(r.location || '打卡点')}&src=it-checkin&coordinate=gaode&callnative=0`
    : '';
  const cap = `${fmtDT(ts)} · ${r.name || ''} · ${r.location || ''}`;
  return `<article class="rec${bad ? ' bad' : ''}">
    <div class="ph">
      ${photo
        ? `<img src="${photo.uri}" alt="${esc(cap)}" loading="lazy" data-cap="${esc(cap)}" /><span class="idx">${idx}</span><span class="zoom">点击放大</span>`
        : `<div class="noimg">照片缺失</div><span class="idx">${idx}</span>`}
    </div>
    <div class="meta">
      <div class="meta-top">
        <span class="time">${fmtHM(ts)}</span>
        <span class="room" title="${esc(r.location)}">${esc(r.location) || '未填写机房'}</span>
        <span class="badge ${bad ? 'bad' : 'ok'}">${bad ? '存在异常' : '全部正常'}</span>
      </div>
      <div class="who">${esc(r.name) || '—'}${r.staff_id ? `<span class="sep">|</span>工号 ${esc(r.staff_id)}` : ''}</div>
      <div class="chips">${inspChips(r)}</div>
      ${r.custom_text ? `<div class="txt${bad ? ' warn' : ''}"><span class="lbl">巡检说明</span>${esc(r.custom_text)}</div>` : ''}
      ${r.note ? `<div class="txt"><span class="lbl">备注</span>${esc(r.note)}</div>` : ''}
      <div class="foot">
        ${coord ? `<span>经纬度 ${esc(coord)}${r.accuracy != null ? ` · 精度 ${Math.round(r.accuracy)} m` : ''}${amap ? ` · <a href="${esc(amap)}" target="_blank" rel="noopener">地图查看</a>` : ''}</span>` : '<span>无定位信息</span>'}
        <span class="id">${r.wm_template ? `水印：${esc(r.wm_template)} · ` : ''}#${esc(r.id)}</span>
      </div>
    </div>
  </article>`;
}

function statTables(rows) {
  const roomMap = new Map();
  const personMap = new Map();
  for (const r of rows) {
    const bad = isBad(r);
    const rk = String(r.location || '未填写');
    const pk = String(r.name || '未知') + '\u0001' + String(r.staff_id || '');
    if (!roomMap.has(rk)) roomMap.set(rk, { total: 0, bad: 0, people: new Set() });
    const rm = roomMap.get(rk);
    rm.total++; if (bad) rm.bad++; rm.people.add(String(r.name || ''));
    if (!personMap.has(pk)) personMap.set(pk, { name: r.name || '未知', staff: r.staff_id || '', total: 0, bad: 0, rooms: new Set() });
    const pm = personMap.get(pk);
    pm.total++; if (bad) pm.bad++; pm.rooms.add(rk);
  }
  const rate = (b, t) => (t ? ((b / t) * 100).toFixed(1) + '%' : '0%');
  const byRoom = [...roomMap.entries()].sort((a, b) => b[1].total - a[1].total);
  const byPerson = [...personMap.values()].sort((a, b) => b.total - a.total);

  const roomRows = byRoom.map(([loc, v]) => `<tr>
      <td>${esc(loc)}</td>
      <td class="num">${v.total}</td>
      <td class="num${v.bad ? ' bad' : ''}">${v.bad}</td>
      <td class="num">${rate(v.bad, v.total)}</td>
      <td class="num">${[...v.people].filter(Boolean).length}</td>
    </tr>`).join('');
  const personRows = byPerson.map((v) => `<tr>
      <td>${esc(v.name)}${v.staff ? `<span class="muted" style="font-size:11px;"> · ${esc(v.staff)}</span>` : ''}</td>
      <td class="num">${v.total}</td>
      <td class="num${v.bad ? ' bad' : ''}">${v.bad}</td>
      <td class="num">${rate(v.bad, v.total)}</td>
      <td class="num">${v.rooms.size}</td>
    </tr>`).join('');

  return `<section class="sec">
    <h2 class="sec-h">附录 A · 机房维度统计</h2>
    <table>
      <thead><tr><th>机房 / 位置</th><th class="num">打卡次数</th><th class="num">异常次数</th><th class="num">异常率</th><th class="num">人员数</th></tr></thead>
      <tbody>${roomRows || '<tr><td colspan="5" class="muted">无数据</td></tr>'}</tbody>
    </table>
  </section>
  <section class="sec">
    <h2 class="sec-h">附录 B · 人员维度统计</h2>
    <table>
      <thead><tr><th>姓名</th><th class="num">打卡次数</th><th class="num">异常次数</th><th class="num">异常率</th><th class="num">涉及机房</th></tr></thead>
      <tbody>${personRows || '<tr><td colspan="5" class="muted">无数据</td></tr>'}</tbody>
    </table>
  </section>`;
}

const SCRIPT = `
(function(){
  var imgs = Array.prototype.slice.call(document.querySelectorAll('.ph img'));
  var lb = document.getElementById('lb');
  var big = document.getElementById('lbImg');
  var cap = document.getElementById('lbCap');
  var idx = -1;
  function open(i){
    if (i < 0 || i >= imgs.length) return;
    idx = i;
    big.src = imgs[i].src;
    cap.textContent = (i + 1) + ' / ' + imgs.length + ' · ' + (imgs[i].getAttribute('data-cap') || '');
    lb.classList.add('on');
    document.body.style.overflow = 'hidden';
  }
  function close(){
    idx = -1;
    lb.classList.remove('on');
    big.removeAttribute('src');
    document.body.style.overflow = '';
  }
  imgs.forEach(function(im, i){ im.addEventListener('click', function(){ open(i); }); });
  document.getElementById('lbClose').addEventListener('click', close);
  lb.addEventListener('click', function(e){ if (e.target === lb) close(); });
  document.getElementById('lbPrev').addEventListener('click', function(e){ e.stopPropagation(); open(idx - 1); });
  document.getElementById('lbNext').addEventListener('click', function(e){ e.stopPropagation(); open(idx + 1); });
  document.addEventListener('keydown', function(e){
    if (!lb.classList.contains('on')) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') open(idx - 1);
    if (e.key === 'ArrowRight') open(idx + 1);
  });
  var pb = document.getElementById('printBtn');
  if (pb) pb.addEventListener('click', function(){ window.print(); });
  var tb = document.getElementById('topBtn');
  if (tb) tb.addEventListener('click', function(){ window.scrollTo({ top: 0, behavior: 'smooth' }); });
})();
`;

/**
 * 流式输出单文件 HTML 明细报告
 * @param {import('http').ServerResponse} res
 * @param {object} opt { rows, query, user, withPhotos, uploadDir, totalBytes }
 */
function writeDetailHtml(res, opt) {
  const rows = opt.rows || [];
  const uploadDir = opt.uploadDir || path.join(__dirname, 'uploads');
  const withPhotos = opt.withPhotos !== false;
  const now = new Date();

  const badCount = rows.filter(isBad).length;
  const rooms = new Set(rows.map((r) => String(r.location || '')).filter(Boolean));
  const people = new Set(rows.map((r) => String(r.name || '')).filter(Boolean));
  const tsList = rows.map(tsOf).filter(Boolean);
  const minTs = tsList.length ? Math.min(...tsList) : 0;
  const maxTs = tsList.length ? Math.max(...tsList) : 0;
  let photoCount = 0;
  let photoBytes = 0;

  const meta = {
    title: `机房巡检打卡明细 ${fmtDT(now.getTime()).slice(0, 10)}`,
    scope: scopeText(opt.query || {}, !!opt.isAdmin),
    generated: fmtDT(now.getTime()),
    operator: (opt.user && (opt.user.displayName || opt.user.username)) || '—',
    range: tsList.length ? `${fmtDT(minTs)} ~ ${fmtDT(maxTs)}` : '—',
    sizeHint: '',
    kpi: {
      total: rows.length,
      bad: badCount,
      rate: rows.length ? ((badCount / rows.length) * 100).toFixed(1) : '0.0',
      rooms: rooms.size,
      people: people.size,
      photos: 0
    }
  };

  // 头信息需要照片数，先按行渲染到数组（记录本身也需要读照片，只读一次）
  const parts = [];
  let idx = 0;
  let lastDay = '';
  // 按日预聚合，避免逐日重复扫描
  const dayAgg = new Map();
  for (const r of rows) {
    const dk = dayKey(tsOf(r));
    if (!dayAgg.has(dk)) dayAgg.set(dk, { total: 0, bad: 0 });
    const a = dayAgg.get(dk);
    a.total++;
    if (isBad(r)) a.bad++;
  }
  for (const r of rows) {
    const ts = tsOf(r);
    const dk = dayKey(ts);
    if (dk !== lastDay) {
      if (lastDay) parts.push('</section>');
      lastDay = dk;
      const a = dayAgg.get(dk) || { total: 0, bad: 0 };
      parts.push(`<section class="day"><h2 class="day-h"><span class="dot"></span>${esc(dayLabel(ts))}
        <span class="cnt">${a.total} 条${a.bad ? ` · 异常 ${a.bad} 条` : ''}</span></h2>`);
    }
    idx++;
    let photo = null;
    if (withPhotos && r.photo) {
      photo = photoDataUri(uploadDir, r.photo);
      if (photo) { photoCount++; photoBytes += photo.bytes; }
    }
    parts.push(recordHtml(r, idx, photo));
  }
  if (lastDay) parts.push('</section>');
  if (!rows.length) {
    parts.push('<section class="day"><div style="background:#fff;border:1px dashed #d6e0ea;border-radius:14px;'
      + 'padding:40px 20px;text-align:center;color:#6b7b8c;font-size:13.5px;">当前筛选条件下没有打卡记录</div></section>');
  }

  meta.kpi.photos = photoCount;
  const estBytes = photoBytes * 1.36 + 200 * 1024;
  meta.sizeHint = fmtMB(estBytes);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.write(headerHtml(meta));
  for (const p of parts) res.write(p);
  res.write(statTables(rows));
  res.write(`</main>
  <div class="final">
    <span>本报告由「IT 机房运维现场打卡系统」自动生成，共 ${rows.length} 条记录 / ${photoCount} 张照片。</span>
    <span>生成时间 ${esc(fmtDT(now.getTime()))}</span>
  </div>
</div>

<div class="toolbar">
  <button id="topBtn" class="ghost" type="button">↑ 回到顶部</button>
  <button id="printBtn" type="button">🖨 打印 / 存为 PDF</button>
</div>

<div class="lb" id="lb">
  <button class="close" id="lbClose" type="button">✕</button>
  <button class="prev" id="lbPrev" type="button">‹</button>
  <img id="lbImg" alt="打卡照片" />
  <button class="next" id="lbNext" type="button">›</button>
  <div class="lb-cap" id="lbCap"></div>
</div>
<script>${SCRIPT}</script>
</body>
</html>`);
  res.end();
}

module.exports = { writeDetailHtml, scopeText, fmtDT };
