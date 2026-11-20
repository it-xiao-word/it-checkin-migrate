'use strict';

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// 后端 created_at 是 ISO 字符串，created_ts 是毫秒时间戳，两者都支持
function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return new Date(Number(v));
  const d = new Date(String(v).replace(/-/g, '/').replace('T', ' ').replace(/\.\d+Z?$/, ''));
  return isNaN(d.getTime()) ? null : d;
}

function fmtTime(v) {
  const d = toDate(v);
  if (!d) return '-';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function fmtDateShort(v) {
  const d = toDate(v);
  if (!d) return '-';
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function fmtBytes(n) {
  if (n === null || n === undefined || n === '') return '-';
  const v = Number(n);
  if (!isFinite(v)) return '-';
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(0) + ' KB';
  return (v / 1024 / 1024).toFixed(2) + ' MB';
}

function fmtRel(v) {
  const d = toDate(v);
  if (!d) return '-';
  const diff = Date.now() - d.getTime();
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + ' 天前';
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 本地日期 YYYY-MM-DD
function dayKey(d) {
  const dt = d instanceof Date ? d : new Date();
  return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
}

// 坐标展示：6 位小数 + 精度
function fmtCoord(lat, lng, accuracy) {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return '';
  const a = Number(lat);
  const b = Number(lng);
  if (!isFinite(a) || !isFinite(b)) return '';
  const acc = (accuracy === null || accuracy === undefined || accuracy === '')
    ? '' : ' (±' + Math.round(Number(accuracy)) + 'm)';
  return a.toFixed(6) + ', ' + b.toFixed(6) + acc;
}

module.exports = { pad2, toDate, fmtTime, fmtDateShort, fmtBytes, fmtRel, dayKey, fmtCoord };
