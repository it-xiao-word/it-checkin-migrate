'use strict';
/*
 * 水印绘制引擎：与 H5 端 public/js/watermark.js 同一套字段与排版规则，
 * 只把 Canvas API 换成小程序 Canvas 2D（drawImage / fillText / measureText 同名）。
 * 服务端配置里存的是同一份 config JSON，两端渲染结果一致。
 */

const WM_FALLBACK = {
  title: 'IT机房运维 · 现场打卡',
  org: '',
  accent: '#1F3B5A',
  showTime: true,
  showCoord: true,
  showStaff: true,
  showLocation: true,
  showInspect: true,
  showCustom: true,
  showNote: true,
  allowCustom: true
};

const WM_ACCENTS = ['#1F3B5A', '#0F8A5F', '#C0392B', '#2C2C2C', '#7A4FB5'];
// 小程序 Canvas 的 font 只保证识别 family 名，用系统无衬线族最稳
const WM_FONT = 'sans-serif';

function wmNormalize(cfg) {
  const c = Object.assign({}, WM_FALLBACK, cfg || {});
  const str = (v, n) => String(v == null ? '' : v).replace(/[\r\n\t]/g, ' ').trim().slice(0, n);
  return {
    title: str(c.title, 24) || WM_FALLBACK.title,
    org: str(c.org, 28),
    accent: /^#[0-9a-fA-F]{6}$/.test(String(c.accent)) ? String(c.accent) : WM_FALLBACK.accent,
    showTime: c.showTime !== false,
    showCoord: c.showCoord !== false,
    showStaff: c.showStaff !== false,
    showLocation: c.showLocation !== false,
    showInspect: c.showInspect !== false,
    showCustom: c.showCustom !== false,
    showNote: c.showNote !== false,
    allowCustom: c.allowCustom !== false
  };
}

// 用户自定义只覆盖标题 / 副标题，其余字段仍跟随默认配置
function wmActive(cfg, mode, customTitle, customOrg) {
  const c = wmNormalize(cfg);
  if (mode !== 'custom' || !c.allowCustom) return c;
  const t = String(customTitle || '').trim().slice(0, 24);
  const o = String(customOrg || '').trim().slice(0, 28);
  if (!t && !o) return c;
  return Object.assign({}, c, { title: t || c.title, org: o });
}

/*
 * 底部信息条文本，按开关拼接。
 * d = { time, coord, name, staffId, location, insp: ['温度正常', ...], inspEmpty, custom, note }
 * 不使用 emoji：Canvas 上的 emoji 依赖系统字体，安卓与 iOS 渲染差异大，会撑破行宽。
 */
function wmLines(cfg, d) {
  const lines = [];
  lines.push(cfg.showTime && d.time ? '打卡时间: ' + d.time : '现场巡检打卡');
  if (cfg.showCoord) lines.push('坐标: ' + (d.coord || '未获取定位'));

  const l3 = [];
  if (cfg.showStaff) {
    l3.push('人员: ' + (d.name || '-'));
    if (d.staffId) l3.push('工号: ' + d.staffId);
  }
  if (cfg.showLocation) l3.push('位置: ' + (d.location || '未选择'));
  if (l3.length) lines.push(l3.join('  '));

  if (cfg.showInspect) {
    const arr = (d.insp || []).filter(Boolean);
    if (arr.length) {
      for (let i = 0; i < arr.length; i += 3) {
        lines.push((i === 0 ? '巡检: ' : '      ') + arr.slice(i, i + 3).join('  '));
      }
    } else {
      lines.push('巡检: ' + (d.inspEmpty || '—'));
    }
  }
  if (cfg.showCustom && d.custom) lines.push('说明: ' + String(d.custom).slice(0, 60));
  if (cfg.showNote && d.note) lines.push('备注: ' + String(d.note).slice(0, 60));
  return lines;
}

// 逐级缩小字号直到宽度合适
function fitFont(ctx, text, maxWidth, size, weight) {
  let s = size;
  while (s > 11) {
    ctx.font = weight + ' ' + s + 'px ' + WM_FONT;
    if (ctx.measureText(text).width <= maxWidth) break;
    s -= 1;
  }
  return s;
}

// ctx 已绘制好底图；w/h 为画布像素尺寸
function wmPaint(ctx, w, h, cfg, d) {
  const c = wmNormalize(cfg);
  const pad = Math.max(10, Math.round(w * 0.014));
  const padY = Math.max(6, Math.round(Math.max(15, h * 0.028) * 0.45));

  // ---- 顶部标题条（标题 + 可选副标题两行） ----
  const titleSize = Math.max(15, Math.round(h * 0.028));
  const orgSize = Math.max(11, Math.round(h * 0.018));
  const titleMaxW = w - pad * 2;
  const tSize = fitFont(ctx, c.title, titleMaxW, titleSize, '700');
  ctx.font = '700 ' + tSize + 'px ' + WM_FONT;
  let barW = Math.round(ctx.measureText(c.title).width) + pad * 2;
  let orgSizeFit = orgSize;
  if (c.org) {
    orgSizeFit = fitFont(ctx, c.org, titleMaxW, orgSize, '500');
    ctx.font = '500 ' + orgSizeFit + 'px ' + WM_FONT;
    barW = Math.max(barW, Math.round(ctx.measureText(c.org).width) + pad * 2);
  }
  barW = Math.min(w, Math.max(barW, Math.round(w * 0.34)));
  const orgGap = c.org ? Math.max(3, Math.round(tSize * 0.3)) : 0;
  const barH = padY * 2 + tSize + (c.org ? orgGap + orgSizeFit : 0);

  ctx.save();
  ctx.fillStyle = c.accent;
  ctx.globalAlpha = 0.92;
  ctx.fillRect(0, 0, barW, barH);
  ctx.globalAlpha = 1;
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 ' + tSize + 'px ' + WM_FONT;
  ctx.fillText(c.title, pad, padY);
  if (c.org) {
    ctx.globalAlpha = 0.88;
    ctx.font = '500 ' + orgSizeFit + 'px ' + WM_FONT;
    ctx.fillText(c.org, pad, padY + tSize + orgGap);
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // ---- 底部信息条 ----
  const lines = wmLines(c, d);
  const fs = Math.max(13, Math.round(h * 0.023));
  const lineH = fs * 1.5;
  const textPad = Math.max(10, Math.round(w * 0.011));
  const barH2 = Math.min(Math.round(h * 0.55), Math.round(12 + lines.length * lineH));
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.58)';
  ctx.fillRect(0, h - barH2, w, barH2);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'top';
  ctx.font = '600 ' + fs + 'px ' + WM_FONT;
  let y = h - barH2 + 8;
  for (const ln of lines) {
    fitFont(ctx, ln, w - textPad * 2, fs, '600');
    ctx.fillText(ln, textPad, y);
    y += lineH;
  }
  ctx.restore();
  return { lines: lines.length };
}

module.exports = { WM_FALLBACK, WM_ACCENTS, wmNormalize, wmActive, wmLines, WM_FONT, wmPaint };
