'use strict';
/**
 * Excel(.xlsx) 明细导出 —— 照片以图片对象锚定在单元格内（不依赖任何第三方库）
 *
 * 实现要点：
 *  1) 手写极简 ZIP（deflate / store），只保留 XLSX 必需部件；
 *  2) 手工解析 JPEG/PNG 文件头取原始宽高，按 160x120 的框等比缩放，行高随图自适应；
 *  3) 照片超过上限（张数 / 总体积）时自动降级为"文件已存在但未内嵌"，避免生成超大文件。
 *
 * 注意：CSV 是纯文本，无法携带图片，需要照片请用本模块的 xlsx 导出。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ============================ 极简 ZIP ============================
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * @param {Array<{name:string,data:Buffer,store?:boolean}>} files
 * @returns {Buffer}
 */
function zip(files) {
  const now = new Date();
  const { time, date } = dosTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = f.data;
    const crc = crc32(raw);
    // 图片本身已压缩，用 store 省 CPU；XML 用 deflate
    const useStore = !!f.store;
    const body = useStore ? raw : zlib.deflateRawSync(raw, { level: 6 });
    const method = useStore ? 0 : 8;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(0x0800, 6);      // UTF-8 文件名
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);          // version made by
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);          // extra
    ch.writeUInt16LE(0, 32);          // comment
    ch.writeUInt16LE(0, 34);          // disk
    ch.writeUInt16LE(0, 36);          // internal attr
    ch.writeUInt32LE(0, 38);          // external attr
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

// ============================ 工具 ============================
const p2 = (n) => String(n).padStart(2, '0');

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function tsOf(r) {
  if (r.created_ts) return Number(r.created_ts);
  const t = Date.parse(r.created_at || '');
  return Number.isFinite(t) ? t : 0;
}
function fmtDT(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
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

// ============================ 图片处理 ============================
// 1px = 9525 EMU；单元格内留 6px 内边距
const EMU = 9525;
const BOX_W = 180;   // 显示框宽（px）
const BOX_H = 135;   // 显示框高（px）
// Excel 列宽(字符) → 像素：约 width*8.6+5（微软雅黑 10.5 默认字体实测）
const COL_PX = (w) => Math.round(w * 8.6 + 5);
const MAX_IMAGES = 600;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;

function imgSize(buf, ext) {
  try {
    if (ext === '.png') {
      if (buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) {
        return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
      }
      return null;
    }
    if (ext === '.jpg' || ext === '.jpeg') {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        if (m === 0xd8 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) return null;
        i += 2 + len;
      }
      return null;
    }
  } catch (e) { /* 坏图按默认比例 */ }
  return null;
}

function readPhoto(uploadDir, name) {
  try {
    const base = path.basename(String(name || ''));
    if (!/^ck_[A-Za-z0-9._-]+\.(jpe?g|png)$/i.test(base)) return null;
    const fp = path.join(uploadDir, base);
    if (!fp.startsWith(uploadDir)) return null;
    const buf = fs.readFileSync(fp);
    if (!buf.length) return null;
    const ext = path.extname(base).toLowerCase();
    const dim = imgSize(buf, ext) || { w: BOX_W, h: BOX_H };
    return { buf, ext, w: dim.w, h: dim.h, bytes: buf.length };
  } catch (e) { return null; }
}

/** 等比缩放到 BOX 内，返回显示尺寸（px） */
function fitBox(w, h) {
  if (!w || !h) return { w: BOX_W, h: BOX_H };
  const k = Math.min(BOX_W / w, BOX_H / h);
  return { w: Math.max(24, Math.round(w * k)), h: Math.max(18, Math.round(h * k)) };
}

// ============================ 样式 ============================
const STYLE_JSON = `
<cellXfs count="15">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
  <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
  <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>
  <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
  <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
  <xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
  <xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
  <xf numFmtId="0" fontId="5" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
  <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
  <xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
  <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
  <xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
  <xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>
  <xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
  <xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
</cellXfs>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="6">
<font><sz val="10.5"/><color rgb="FF16202B"/><name val="微软雅黑"/><charset val="134"/></font>
<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="微软雅黑"/><charset val="134"/></font>
<font><b/><sz val="10"/><color rgb="FFC0392B"/><name val="微软雅黑"/><charset val="134"/></font>
<font><b/><sz val="15"/><color rgb="FF1F3B5A"/><name val="微软雅黑"/><charset val="134"/></font>
<font><sz val="9.5"/><color rgb="FF6B7B8C"/><name val="微软雅黑"/><charset val="134"/></font>
<font><u/><sz val="9.5"/><color rgb="FF1A5FB4"/><name val="微软雅黑"/><charset val="134"/></font>
</fonts>
<fills count="5">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F3B5A"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFCEFED"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEFF4F8"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFD8E0E8"/></left><right style="thin"><color rgb="FFD8E0E8"/></right><top style="thin"><color rgb="FFD8E0E8"/></top><bottom style="thin"><color rgb="FFD8E0E8"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
${STYLE_JSON}
<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/>
<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;

// 样式索引
const S = {
  DEFAULT: 0, HEAD: 1, BODY: 2, CENTER: 3, BAD: 4, TITLE: 5, MUTED: 6, LINK: 7,
  STXT: 8,      // 统计表：文本（左对齐 + 垂直居中）
  STXT_Z: 9,    // 统计表：文本 + 斑马纹
  SNUM: 10,     // 统计表：数字（居中）
  SNUM_Z: 11,   // 统计表：数字 + 斑马纹
  BAD_LW: 12,   // 异常行：左对齐 + 自动换行（浅红底）
  BAD_LC: 13,   // 异常行：左对齐 + 垂直居中
  BAD_CC: 14    // 异常行：居中
};

// ============================ 单元格辅助 ============================
const colName = (n) => {
  let s = '';
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
};
const refOf = (row, col) => colName(col) + row;

function cStr(ref, style, value) {
  const v = value == null ? '' : String(value);
  if (!v) return `<c r="${ref}" s="${style}"/>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}
function cNum(ref, style, value) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) {
    return `<c r="${ref}" s="${style}"/>`;
  }
  return `<c r="${ref}" s="${style}"><v>${Number(value)}</v></c>`;
}

// ============================ 工作表构建 ============================
const DETAIL_COLS = [
  { key: 'idx', title: '序号', width: 5.5, align: 'center' },
  { key: 'time', title: '打卡时间', width: 16.5, align: 'center' },
  { key: 'name', title: '姓名', width: 10, align: 'center' },
  { key: 'staff', title: '工号', width: 11, align: 'center' },
  { key: 'loc', title: '机房/位置', width: 22 },
  { key: 'insp', title: '巡检明细', width: 30 },
  { key: 'bad', title: '异常项', width: 16 },
  { key: 'text', title: '巡检说明', width: 26 },
  { key: 'note', title: '备注', width: 20 },
  { key: 'lat', title: '纬度', width: 11, align: 'center' },
  { key: 'lng', title: '经度', width: 11, align: 'center' },
  { key: 'acc', title: '精度(m)', width: 8, align: 'center' },
  { key: 'map', title: '定位（点开看地图）', width: 16, align: 'center' },
  { key: 'wm', title: '水印模板', width: 18, align: 'center' },
  { key: 'photo', title: '现场照片', width: 26, align: 'center' },
  { key: 'file', title: '照片文件', width: 26 },
  { key: 'id', title: '记录ID', width: 7, align: 'center' }
];
const PHOTO_COL = DETAIL_COLS.findIndex((c) => c.key === 'photo') + 1;
const MAP_COL = DETAIL_COLS.findIndex((c) => c.key === 'map') + 1;
const PHOTO_COL_PX = COL_PX(26);      // 现场照片列的近似像素宽度（用于图片水平居中）

/**
 * 生成"打卡明细"工作表
 * @returns {{xml:string, rels:string, drawing:string, drawingRels:string, media:Array}}
 */
function buildDetailSheet(rows, opt) {
  const uploadDir = opt.uploadDir;
  const withPhotos = opt.withPhotos !== false;
  const now = new Date();

  const media = [];          // { name, buf, ext, store }
  const anchors = [];        // 图片锚点
  const hyperlinks = [];     // { ref, rid }
  let photoUsed = 0;
  let photoBytes = 0;
  let photoSkipped = 0;

  const nCol = DETAIL_COLS.length;
  const lastCol = colName(nCol);
  const headRow = 5;                  // 第 1 行标题、2-3 行说明、4 行空、5 行表头
  const firstDataRow = headRow + 1;

  const xmlRows = [];
  const rowHeights = [];              // { row, ht }

  // —— 标题区 ——
  const scope = opt.scope || '';
  const sub = `统计范围：${scope}　|　生成时间：${fmtDT(now.getTime())}　|　导出人：${opt.operator || '—'}`
    + `　|　共 ${rows.length} 条记录${withPhotos ? '，照片内嵌在「现场照片」列' : '（未含照片）'}`;

  xmlRows.push(`<row r="1" ht="30" customHeight="1">${cStr('A1', S.TITLE, '机房巡检打卡明细')}</row>`);
  xmlRows.push(`<row r="2" ht="18" customHeight="1">${cStr('A2', S.MUTED, sub)}</row>`);
  xmlRows.push(`<row r="3" ht="18" customHeight="1">${cStr('A3', S.MUTED,
    '说明：异常项标红的记录表示巡检存在"不正常"项目；经纬度为手机上报的现场定位，点「定位」可查看地图。')}</row>`);
  xmlRows.push('<row r="4" ht="8" customHeight="1"/>');

  // —— 表头 ——
  xmlRows.push(`<row r="${headRow}" ht="34" customHeight="1">`
    + DETAIL_COLS.map((c, i) => cStr(refOf(headRow, i + 1), S.HEAD, c.title)).join('')
    + '</row>');

  // —— 数据行 ——
  let r = headRow;
  rows.forEach((row, i) => {
    r++;
    const bad = isBad(row);
    const insp = inspOf(row);
    const inspText = insp.map((x) => `${x.name}:${x.status === 'ok' ? '正常' : '不正常'}`).join('\n');
    const badText = insp.filter((x) => x.status === 'bad').map((x) => x.name).join('、');
    const ts = tsOf(row);
    const bodyStyle = bad ? S.BAD_LW : S.BODY;
    // 异常行：整行浅红底 + 保持列对齐；只有「异常项」列用红字强调
    const cellStyle = (colIdx, def) => {
      const c = DETAIL_COLS[colIdx];
      const center = !!(c && c.align === 'center');
      if (bad) return center ? S.BAD_CC : S.BAD_LW;
      return center ? S.CENTER : def;
    };

    const cells = [];
    cells.push(cNum(refOf(r, 1), bad ? S.BAD_CC : S.CENTER, i + 1));
    cells.push(cStr(refOf(r, 2), cellStyle(1, S.BODY), fmtDT(ts)));
    cells.push(cStr(refOf(r, 3), cellStyle(2, S.BODY), row.name || ''));
    cells.push(cStr(refOf(r, 4), cellStyle(3, S.BODY), row.staff_id || ''));
    cells.push(cStr(refOf(r, 5), bad ? S.BAD_LC : S.STXT, row.location || ''));
    cells.push(cStr(refOf(r, 6), bodyStyle, inspText));
    cells.push(cStr(refOf(r, 7), bad ? S.BAD : S.CENTER, badText || '—'));
    cells.push(cStr(refOf(r, 8), cellStyle(7, S.BODY), row.custom_text || ''));
    cells.push(cStr(refOf(r, 9), cellStyle(8, S.BODY), row.note || ''));
    cells.push(cNum(refOf(r, 10), cellStyle(9, S.CENTER), row.lat));
    cells.push(cNum(refOf(r, 11), cellStyle(10, S.CENTER), row.lng));
    cells.push(cNum(refOf(r, 12), cellStyle(11, S.CENTER), row.accuracy));

    // 定位：高德地图（公开可点，无需登录）
    const hasGPS = Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lng))
      && Number(row.lat) !== 0 && Number(row.lng) !== 0;
    if (hasGPS) {
      const url = `https://uri.amap.com/marker?position=${Number(row.lng)},${Number(row.lat)}`
        + `&name=${encodeURIComponent((row.location || '巡检点') + ' ' + fmtDT(ts))}&src=itcheckin&coordinate=gaode&callnative=0`;
      const rid = `rIdH${r}`;
      hyperlinks.push({ ref: refOf(r, MAP_COL), rid, url });
      cells.push(cStr(refOf(r, MAP_COL), S.LINK, '查看地图'));
    } else {
      cells.push(cStr(refOf(r, MAP_COL), S.CENTER, '—'));
    }

    cells.push(cStr(refOf(r, 14), cellStyle(13, S.BODY), row.wm_template || ''));
    // 照片：内嵌图片（单元格留空，图片锚定其上）
    let photoH = 0;
    let photoInfo = null;
    if (withPhotos && row.photo) {
      if (photoUsed >= MAX_IMAGES || photoBytes >= MAX_TOTAL_BYTES) {
        photoSkipped++;
      } else {
        photoInfo = readPhoto(uploadDir, row.photo);
        if (photoInfo) {
          photoUsed++;
          photoBytes += photoInfo.bytes;
        } else {
          photoSkipped++;
        }
      }
    } else if (row.photo) {
      photoSkipped++;
    }

    if (photoInfo) {
      const size = fitBox(photoInfo.w, photoInfo.h);
      const ext = photoInfo.ext === '.png' ? '.png' : '.jpeg';
      const imgName = `image${media.length + 1}${ext}`;
      media.push({ name: `xl/media/${imgName}`, buf: photoInfo.buf, store: true });
      anchors.push({
        id: anchors.length + 2,          // 1 被 sheet 保留
        col: PHOTO_COL - 1,
        row: r - 1,
        ox: Math.max(6, Math.round((PHOTO_COL_PX - size.w) / 2)),
        oy: 9,                            // 行高按 (图高 + 18) 计算，上下各留 9px
        cx: size.w * EMU,
        cy: size.h * EMU,
        rid: `rIdImg${media.length}`,
        desc: `${row.name || ''} ${fmtDT(ts)}`
      });
      photoH = size.h;
      cells.push(`<c r="${refOf(r, PHOTO_COL)}" s="${bad ? S.BAD_CC : S.CENTER}"/>`);
    } else if (row.photo) {
      cells.push(cStr(refOf(r, PHOTO_COL), bad ? S.BAD_CC : S.CENTER, '照片未内嵌'));
    } else {
      cells.push(cStr(refOf(r, PHOTO_COL), bad ? S.BAD_CC : S.CENTER, '无照片'));
    }

    cells.push(cStr(refOf(r, 16), bad ? S.BAD_LC : S.STXT, row.photo || ''));
    cells.push(cNum(refOf(r, 17), bad ? S.BAD_CC : S.CENTER, row.id));

    // 行高：有图按图高 + 上下留白（1px = 0.75pt）；无图按巡检项行数与说明长度估算
    let ht;
    if (photoH) {
      ht = Math.max(40, Math.round((photoH + 18) * 0.75));
    } else {
      const lines = Math.max(insp.length, 2);
      const extra = Math.ceil(Math.max(String(row.custom_text || '').length / 12,
        String(row.note || '').length / 9));
      ht = Math.max(24, Math.min(150, Math.max(lines, extra + 1) * 15 + 9));
    }
    rowHeights.push({ row: r, ht });
    xmlRows.push(`<row r="${r}" ht="${ht}" customHeight="1">${cells.join('')}</row>`);
  });

  const lastRow = Math.max(r, headRow);

  if (!rows.length) {
    xmlRows.push(`<row r="${headRow + 1}" ht="26" customHeight="1">`
      + cStr(refOf(headRow + 1, 1), S.CENTER, '当前筛选条件下没有打卡记录') + '</row>');
  }

  // —— 列宽 ——
  const cols = DETAIL_COLS.map((c, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join('');

  // —— 合并单元格（标题 / 说明行跨列） ——
  const merges = `<mergeCells count="3"><mergeCell ref="A1:${lastCol}1"/><mergeCell ref="A2:${lastCol}2"/><mergeCell ref="A3:${lastCol}3"/></mergeCells>`;

  // —— 超链接 ——
  const links = hyperlinks.length
    ? `<hyperlinks>${hyperlinks.map((h) => `<hyperlink ref="${h.ref}" r:id="${h.rid}"/>`).join('')}</hyperlinks>`
    : '';
  const linkRels = hyperlinks.map((h) =>
    `<Relationship Id="${h.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(h.url)}" TargetMode="External"/>`
  ).join('');

  const drawingPart = anchors.length
    ? '<drawing r:id="rIdD1"/>'
    : '';

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<dimension ref="A1:${lastCol}${Math.max(lastRow, 2)}"/>
<sheetViews><sheetView tabSelected="1" workbookViewId="0" zoomScale="90"><pane ySplit="${headRow}" topLeftCell="A${firstDataRow}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${firstDataRow}" sqref="A${firstDataRow}"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="18"/>
<cols>${cols}</cols>
<sheetData>${xmlRows.join('')}</sheetData>
${merges}
${links}
<printOptions horizontalCentered="1"/>
<pageMargins left="0.25" right="0.25" top="0.4" bottom="0.4" header="0.2" footer="0.2"/>
<pageSetup paperSize="8" orientation="landscape" fitToWidth="1" fitToHeight="0"/>
<headerFooter><oddFooter>&amp;L机房巡检打卡明细&amp;R第 &amp;P / &amp;N 页</oddFooter></headerFooter>
${drawingPart}
</worksheet>`;

  const sheetRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + (anchors.length
      ? '<Relationship Id="rIdD1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>'
      : '')
    + linkRels
    + '</Relationships>';

  // —— 绘图（图片锚定） ——
  const anchorsXml = anchors.map((a) => `<xdr:oneCellAnchor>
<xdr:from><xdr:col>${a.col}</xdr:col><xdr:colOff>${a.ox * EMU}</xdr:colOff><xdr:row>${a.row}</xdr:row><xdr:rowOff>${a.oy * EMU}</xdr:rowOff></xdr:from>
<xdr:ext cx="${a.cx}" cy="${a.cy}"/>
<xdr:pic>
<xdr:nvPicPr><xdr:cNvPr id="${a.id}" name="照片${a.id - 1}" descr="${esc(a.desc)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1" noChangeArrowheads="1"/></xdr:cNvPicPr></xdr:nvPicPr>
<xdr:blipFill><a:blip r:embed="${a.rid}"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${a.cx}" cy="${a.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
</xdr:pic>
<xdr:clientData/>
</xdr:oneCellAnchor>`).join('\n');

  const drawingXml = anchors.length
    ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${anchorsXml}
</xdr:wsDr>`
    : null;

  const drawingRels = anchors.length
    ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${anchors.map((a, i) => `<Relationship Id="${a.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${i + 1}${media[i].name.endsWith('.png') ? '.png' : '.jpeg'}"/>`).join('')}
</Relationships>`
    : null;

  return {
    xml: sheetXml,
    rels: sheetRels,
    drawing: drawingXml,
    drawingRels,
    media,
    stats: { photoUsed, photoBytes, photoSkipped, lastRow }
  };
}

/** 统计汇总工作表 */
function buildStatSheet(rows) {
  const rowXml = [];
  let r = 1;

  const rooms = new Map();
  const people = new Map();
  const days = new Map();

  for (const row of rows) {
    const bad = isBad(row);
    const loc = String(row.location || '未填机房');
    const nm = String(row.name || '未填姓名') + '\u0000' + String(row.staff_id || '');
    const dk = dayKey(tsOf(row));
    const ts = tsOf(row);

    if (!rooms.has(loc)) rooms.set(loc, { total: 0, bad: 0, people: new Set(), photos: 0 });
    const a = rooms.get(loc);
    a.total++; if (bad) a.bad++;
    if (row.name) a.people.add(row.name);
    if (row.photo) a.photos++;

    if (!people.has(nm)) people.set(nm, { total: 0, bad: 0, rooms: new Set(), first: 0, last: 0 });
    const b = people.get(nm);
    b.total++; if (bad) b.bad++;
    b.rooms.add(loc);
    if (!b.first || ts < b.first) b.first = ts;
    if (!b.last || ts > b.last) b.last = ts;

    if (!days.has(dk)) days.set(dk, { total: 0, bad: 0 });
    const c = days.get(dk);
    c.total++; if (bad) c.bad++;
  }

  const rate = (bad, total) => (total ? Math.round((bad / total) * 1000) / 10 + '%' : '0%');

  function block(title, headers, list) {
    rowXml.push(`<row r="${r}" ht="28" customHeight="1">${cStr(`A${r}`, S.TITLE, title)}</row>`);
    r++;
    rowXml.push(`<row r="${r}" ht="24" customHeight="1">`
      + headers.map((h, i) => cStr(refOf(r, i + 1), S.HEAD, h)).join('') + '</row>');
    r++;
    let k = 0;
    for (const cells of list) {
      const even = k % 2 === 0;
      rowXml.push(`<row r="${r}" ht="21" customHeight="1">`
        + cells.map((v, i) => (typeof v === 'number'
          ? cNum(refOf(r, i + 1), even ? S.SNUM : S.SNUM_Z, v)
          : cStr(refOf(r, i + 1), even ? S.STXT : S.STXT_Z, v))).join('') + '</row>');
      r++;
      k++;
    }
    r++; // 空行
  }

  block('附录 A · 机房维度统计', ['机房/位置', '打卡次数', '异常次数', '异常率', '涉及人数', '含照片数'],
    [...rooms.entries()].sort((a, b) => b[1].total - a[1].total)
      .map(([loc, v]) => [loc, v.total, v.bad, rate(v.bad, v.total), v.people.size, v.photos]));

  block('附录 B · 人员维度统计', ['姓名', '工号', '打卡次数', '异常次数', '异常率', '机房数', '首次打卡', '最后打卡'],
    [...people.entries()].sort((a, b) => b[1].total - a[1].total).map(([k, v]) => {
      const [nm, sid] = k.split('\u0000');
      return [nm, sid, v.total, v.bad, rate(v.bad, v.total), v.rooms.size, fmtDT(v.first), fmtDT(v.last)];
    }));

  block('附录 C · 按日统计', ['日期', '打卡次数', '异常次数', '异常率'],
    [...days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([d, v]) => [d, v.total, v.bad, rate(v.bad, v.total)]));

  const cols = `<col min="1" max="1" width="26" customWidth="1"/>`
    + `<col min="2" max="6" width="13" customWidth="1"/>`
    + `<col min="7" max="8" width="18" customWidth="1"/>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<dimension ref="A1:H${Math.max(r, 2)}"/>
<sheetViews><sheetView workbookViewId="0"/></sheetViews>
<sheetFormatPr defaultRowHeight="18"/>
<cols>${cols}</cols>
<sheetData>${rowXml.join('')}</sheetData>
<pageMargins left="0.5" right="0.5" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
}

// ============================ 主入口 ============================
/**
 * 生成 xlsx 并写入响应
 * @param {import('http').ServerResponse} res
 * @param {object} opt { rows, query, isAdmin, user, uploadDir, withPhotos, scope }
 */
function writeDetailXlsx(res, opt) {
  const rows = opt.rows || [];
  const uploadDir = opt.uploadDir || path.join(__dirname, 'uploads');
  const detail = buildDetailSheet(rows, {
    uploadDir,
    withPhotos: opt.withPhotos !== false,
    scope: opt.scope || '',
    operator: opt.operator || ''
  });
  const statXml = buildStatSheet(rows);

  const files = [];
  const now = new Date();
  const created = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}T${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}Z`;

  files.push({
    name: '[Content_Types].xml',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
<Default Extension="jpg" ContentType="image/jpeg"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${detail.drawing ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ''}
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`, 'utf8')
  });

  files.push({
    name: '_rels/.rels',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`, 'utf8')
  });

  files.push({
    name: 'docProps/core.xml',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>机房巡检打卡明细</dc:title>
<dc:creator>IT机房运维现场打卡系统</dc:creator>
<cp:lastModifiedBy>IT机房运维现场打卡系统</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>
</cp:coreProperties>`, 'utf8')
  });

  files.push({
    name: 'docProps/app.xml',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>it-checkin</Application>
</Properties>`, 'utf8')
  });

  files.push({
    name: 'xl/workbook.xml',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<workbookPr/>
<sheets>
<sheet name="打卡明细" sheetId="1" r:id="rId1"/>
<sheet name="统计汇总" sheetId="2" r:id="rId2"/>
</sheets>
<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">'打卡明细'!$5:$5</definedName></definedNames>
</workbook>`, 'utf8')
  });

  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`, 'utf8')
  });

  files.push({ name: 'xl/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') });
  files.push({ name: 'xl/worksheets/sheet1.xml', data: Buffer.from(detail.xml, 'utf8') });
  files.push({ name: 'xl/worksheets/sheet2.xml', data: Buffer.from(statXml, 'utf8') });
  files.push({ name: 'xl/worksheets/_rels/sheet1.xml.rels', data: Buffer.from(detail.rels, 'utf8') });

  if (detail.drawing) {
    files.push({ name: 'xl/drawings/drawing1.xml', data: Buffer.from(detail.drawing, 'utf8') });
    files.push({ name: 'xl/drawings/_rels/drawing1.xml.rels', data: Buffer.from(detail.drawingRels, 'utf8') });
    for (const m of detail.media) files.push({ name: m.name, data: m.buf, store: true });
  }

  const buf = zip(files);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Cache-Control', 'no-store');
  res.end(buf);

  return { ...detail.stats, bytes: buf.length };
}

module.exports = { writeDetailXlsx };
