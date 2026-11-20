'use strict';
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const db = require('./db');
const { writeDetailHtml, scopeText, fmtDT } = require('./export-html');
const { writeDetailXlsx } = require('./export-xlsx');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const SSL_PORT = parseInt(process.env.SSL_PORT, 10) || 3443;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- JWT 密钥（持久化，重启后令牌仍有效） ----------
const SECRET_FILE = path.join(DATA_DIR, '.jwt_secret');
let JWT_SECRET;
try { JWT_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) { /* 不存在则生成 */ }
if (!JWT_SECRET || JWT_SECRET.length < 16) {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, JWT_SECRET, { mode: 0o600 });
}
const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000; // 7 天

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function signJWT(payload) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + p).digest());
  return `${h}.${p}.${sig}`;
}
function verifyJWT(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = b64u(crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + p).digest());
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch (e) { return null; }
}

const app = express();
// 机柜拓扑整份数据走 JSON 提交，单份可达数 MB，默认 100kb 不够
app.use(express.json({ limit: '12mb' }));
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));
// 注：打卡照片不再公开静态托管，改为 /api/photo/:name 经登录校验后返回

// ---------- 会话 Cookie（httpOnly，前端 JS 读不到令牌） ----------
const SESSION_COOKIE = 'itck_sess';
function isSecureReq(req) {
  return !!(req.secure || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https');
}
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) {
      const k = p.slice(0, i).trim();
      const v = p.slice(i + 1).trim();
      if (k) { try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; } }
    }
  });
  return out;
}
function sessionCookie(token, req) {
  const secure = isSecureReq(req) ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(TOKEN_TTL / 1000)}${secure}`;
}
function clearSessionCookie(req) {
  const secure = isSecureReq(req) ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

// ---------- 鉴权中间件 ----------
function auth(req, res, next) {
  const ah = req.headers['authorization'] || '';
  const m = ah.match(/^Bearer\s+(.+)$/i);
  // 优先级：Authorization 头（脚本/旧客户端）> httpOnly Cookie（浏览器）> 查询参数
  const token = (m ? m[1] : '') || parseCookies(req)[SESSION_COOKIE] || req.query.token || '';
  const payload = token ? verifyJWT(token) : null;
  if (!payload) return res.status(401).json({ code: 401, message: '未登录或登录已过期' });
  const user = db.getUserById(payload.uid);
  if (!user) return res.status(401).json({ code: 401, message: '账号不存在' });
  // 令牌版本校验：改密 / 登出 / 管理员重置密码会使旧令牌全部失效
  if (typeof payload.ver === 'number' && payload.ver !== user.token_version) {
    return res.status(401).json({ code: 401, message: '登录已失效，请重新登录' });
  }
  req.user = {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.display_name,
    staffId: user.staff_id,
    mustChangePw: !!user.must_change_pw
  };
  next();
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ code: 403, message: '需要管理员权限' });
  next();
}

// ---------- 上传配置 ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
    const name = `ck_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('仅支持上传图片文件'));
  }
});

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// ---------- API ----------
app.get('/healthz', (req, res) => res.json({ code: 0, message: 'ok' }));

// 登录
app.post('/api/login', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  if (!username || !password) return res.status(400).json({ code: 4001, message: '请输入账号和密码' });
  const user = db.getUserByUsername(username);
  if (!user || !db.verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ code: 4011, message: '账号或密码错误' });
  }
  const token = signJWT({ uid: user.id, role: user.role, ver: user.token_version, exp: Date.now() + TOKEN_TTL });
  // 会话写入 httpOnly Cookie，前端 JS 不再持有令牌
  res.setHeader('Set-Cookie', sessionCookie(token, req));
  res.json({
    code: 0, message: 'ok',
    data: {
      // token 同时下发给非浏览器客户端（微信小程序、脚本）：Cookie 对它们不可靠
      token,
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      staffId: user.staff_id,
      role: user.role,
      mustChangePw: !!user.must_change_pw
    }
  });
});

// 登出：使当前账号的全部令牌失效（服务端作废会话）并清除 Cookie
app.post('/api/logout', auth, (req, res) => {
  db.bumpTokenVersion(req.user.id);
  res.setHeader('Set-Cookie', clearSessionCookie(req));
  res.json({ code: 0, message: 'ok' });
});

// 当前用户信息
app.get('/api/me', auth, (req, res) => res.json({ code: 0, message: 'ok', data: req.user }));

// 打卡照片（需登录）：只允许打卡上传产生的文件名，防止路径穿越
app.get('/api/photo/:name', auth, (req, res) => {
  const name = path.basename(String(req.params.name || ''));
  if (!/^ck_[A-Za-z0-9._-]+\.(jpe?g|png|webp|gif)$/i.test(name)) {
    return res.status(400).json({ code: 4009, message: '文件名不合法' });
  }
  const fp = path.join(UPLOAD_DIR, name);
  if (!fp.startsWith(UPLOAD_DIR) || !fs.existsSync(fp)) {
    return res.status(404).json({ code: 4043, message: '照片不存在' });
  }
  // 普通用户只能查看自己记录的写真；管理员不受限
  if (req.user.role !== 'admin') {
    const owner = db.getPhotoOwner(name);
    if (owner.found && owner.userId != null && owner.userId !== req.user.id) {
      return res.status(403).json({ code: 403, message: '无权查看该照片' });
    }
  }
  // 文件名含时间戳+随机串，永不复用 → 可长缓存（照片压缩后体积更小，命中缓存更划算）
  res.setHeader('Cache-Control', 'private, max-age=2592000, immutable');
  res.sendFile(fp);
});

// 修改密码（首次登录强制；需原密码）
app.post('/api/change-password', auth, (req, res) => {
  const oldP = req.body.oldPassword || '';
  const newP = req.body.newPassword || '';
  if (!newP || newP.length < 6) return res.status(400).json({ code: 4002, message: '新密码至少 6 位' });
  const user = db.getUserById(req.user.id);
  if (!db.verifyPassword(oldP, user.password_hash)) return res.status(400).json({ code: 4003, message: '原密码错误' });
  db.changeOwnPassword(req.user.id, newP);
  const u2 = db.getUserById(req.user.id);
  const token = signJWT({ uid: u2.id, role: u2.role, ver: u2.token_version, exp: Date.now() + TOKEN_TTL });
  res.setHeader('Set-Cookie', sessionCookie(token, req));
  res.json({ code: 0, message: 'ok', data: { mustChangePw: false, token } });
});

// 打卡提交（登录后；姓名/工号取自登录账号，不可篡改）
app.post('/api/checkin', auth, upload.single('photo'), (req, res) => {
  // 校验失败时清掉已落盘的照片，避免产生孤儿文件
  const dropUpload = () => {
    if (req.file && req.file.filename) {
      fs.unlink(path.join(UPLOAD_DIR, req.file.filename), () => {});
    }
  };
  try {
    // 管理员账号只做管理，不参与现场打卡
    if (req.user.role === 'admin') {
      dropUpload();
      return res.status(403).json({ code: 4031, message: '管理员账号不需要现场打卡，请使用普通账号打卡' });
    }
    if (!req.file) return res.status(400).json({ code: 4001, message: '缺少打卡照片' });
    const location = (req.body.location || '').trim();
    if (!location) { dropUpload(); return res.status(400).json({ code: 4004, message: '请选择机房/位置' }); }

    // 机房决定巡检项目：机房 → 分组 → 巡检模板 → 项目
    const room = db.getRoomByName(location);
    if (!room) {
      dropUpload();
      return res.status(400).json({ code: 4010, message: '该机房未在管理端配置，请刷新页面后重新选择' });
    }
    const templateItems = room.template_id ? db.getTemplateItems(room.template_id) : [];

    // 前端提交 [{itemId, status}]，以服务端模板为准校验（名称取库内值，防篡改）
    let submitted = [];
    try { submitted = JSON.parse(req.body.inspect || '[]'); } catch (e) { submitted = []; }
    if (!Array.isArray(submitted)) submitted = [];
    const statusMap = new Map();
    for (const it of submitted) {
      const iid = Number(it && it.itemId);
      const st = it && it.status;
      if (!Number.isFinite(iid) || (st !== 'ok' && st !== 'bad')) continue;
      statusMap.set(iid, st);
    }
    const missing = [];
    const results = [];
    for (const it of templateItems) {
      const st = statusMap.get(it.id);
      if (!st) { missing.push(it.name); continue; }
      results.push({ itemId: it.id, name: it.name, status: st });
    }
    if (missing.length) {
      dropUpload();
      return res.status(400).json({ code: 4011, message: `请完成巡检项「${missing.join('、')}」` });
    }
    const badNames = results.filter((x) => x.status === 'bad').map((x) => x.name);
    const customText = (req.body.customText || '').trim();

    // 本次使用的水印模板（不存在则忽略，不影响打卡）
    let wmTplName = null;
    if (req.body.wmTemplateId) {
      const t = db.getWmTemplate(req.body.wmTemplateId);
      if (t) wmTplName = t.name;
    }
    // 兜底校验：任一巡检项「不正常」时必须填写巡检说明
    if (badNames.length && !customText) {
      dropUpload();
      return res.status(400).json({
        code: 4008,
        message: `「${badNames.join('、')}」标记为不正常，请填写巡检说明`
      });
    }

    // 照片体积：落盘字节来自 multer；原始字节由前端上报（客户端压缩前的大小）
    const photoBytes = req.file.size || null;
    const rawReported = num(req.body.rawBytes);
    const photoRawBytes = (rawReported != null && rawReported >= (photoBytes || 0) && rawReported <= 60 * 1024 * 1024)
      ? rawReported : null;

    const id = db.insert({
      userId: req.user.id,
      name: req.user.displayName || req.user.username,
      staffId: req.user.staffId || '',
      lat: num(req.body.lat),
      lng: num(req.body.lng),
      accuracy: num(req.body.accuracy),
      location,
      note: req.body.note,
      photo: req.file.filename,
      customText,
      wmTemplate: wmTplName,
      photoBytes,
      photoRawBytes
    });
    db.insertInspections(id, results);
    res.json({ code: 0, message: 'ok', data: { id, photoBytes, photoRawBytes } });
  } catch (e) {
    dropUpload();
    res.status(500).json({ code: 5001, message: e.message });
  }
});

// 打卡页配置：机房（含分组与模板）+ 各模板的巡检项目，一次下发供前端本地映射
app.get('/api/checkin-config', auth, (req, res) => {
  res.json({
    code: 0, message: 'ok',
    data: {
      rooms: db.listRooms(),
      templates: db.listTemplates(),
      groups: db.listGroups(),
      watermark: db.getWatermark(),
      watermarks: db.listWmTemplates()
    }
  });
});

// 水印模板：所有登录用户可读（打卡页要选），仅管理员可增删改
app.get('/api/watermark/templates', auth, (req, res) => {
  res.json({ code: 0, message: 'ok', data: db.listWmTemplates() });
});
app.post('/api/watermark/templates', auth, adminOnly, (req, res) => {
  try {
    const b = req.body || {};
    const tpl = db.addWmTemplate({ name: b.name, config: b.config, isDefault: b.isDefault === true });
    res.json({ code: 0, message: 'ok', data: tpl });
  } catch (e) {
    res.status(500).json({ code: 5005, message: '新建模板失败：' + e.message });
  }
});
app.put('/api/watermark/templates/:id', auth, adminOnly, (req, res) => {
  const tpl = db.updateWmTemplate(req.params.id, {
    name: req.body && req.body.name,
    config: req.body && req.body.config,
    isDefault: req.body && req.body.isDefault === true ? true : undefined
  });
  if (!tpl) return res.status(404).json({ code: 4044, message: '模板不存在' });
  res.json({ code: 0, message: 'ok', data: tpl });
});
app.delete('/api/watermark/templates/:id', auth, adminOnly, (req, res) => {
  const r = db.deleteWmTemplate(req.params.id);
  if (!r.ok) {
    const msg = r.reason === 'last' ? '至少要保留一套水印模板' : '模板不存在';
    return res.status(r.reason === 'last' ? 400 : 404).json({ code: 4050, message: msg });
  }
  res.json({ code: 0, message: 'ok', data: { defaultId: r.defaultId, templates: db.listWmTemplates() } });
});
app.post('/api/watermark/templates/:id/default', auth, adminOnly, (req, res) => {
  const tpl = db.setDefaultWmTemplate(req.params.id);
  if (!tpl) return res.status(404).json({ code: 4044, message: '模板不存在' });
  res.json({ code: 0, message: 'ok', data: { templates: db.listWmTemplates() } });
});

// 水印配置：所有登录用户可读（打卡页要用），仅管理员可改
app.get('/api/watermark', auth, (req, res) => {
  res.json({ code: 0, message: 'ok', data: db.getWatermark() });
});
app.put('/api/watermark', auth, adminOnly, (req, res) => {
  try {
    const b = req.body || {};
    const saved = db.setWatermark({
      title: b.title,
      org: b.org,
      accent: b.accent,
      showTime: b.showTime,
      showCoord: b.showCoord,
      showStaff: b.showStaff,
      showLocation: b.showLocation,
      showInspect: b.showInspect,
      showCustom: b.showCustom,
      showNote: b.showNote,
      allowCustom: b.allowCustom
    });
    res.json({ code: 0, message: 'ok', data: saved });
  } catch (e) {
    res.status(500).json({ code: 5004, message: '保存失败：' + e.message });
  }
});

// ---------- 机柜连线拓扑 ----------
// 所有登录用户均可查看与编辑（内网团队协作）；并发写入靠 rev 乐观锁拦截互相覆盖
function topoErrMsg(code) {
  return {
    EMPTY_DATA: '拓扑数据为空',
    TOO_LARGE: '拓扑数据超过 8MB 上限',
    BAD_JSON: '拓扑数据格式不合法'
  }[code] || '';
}

app.get('/api/topologies', auth, (req, res) => {
  res.json({ code: 0, message: 'ok', data: { list: db.listTopologies() } });
});

app.get('/api/topologies/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ code: 4001, message: '拓扑 ID 不合法' });
  const row = db.getTopology(id);
  if (!row) return res.status(404).json({ code: 4041, message: '拓扑不存在或已被删除' });
  res.json({ code: 0, message: 'ok', data: row });
});

app.post('/api/topologies', auth, (req, res) => {
  try {
    const b = req.body || {};
    const row = db.createTopology({ name: b.name, data: b.data, user: req.user });
    res.json({ code: 0, message: 'ok', data: row });
  } catch (e) {
    const msg = topoErrMsg(e.code);
    if (msg) return res.status(400).json({ code: 4003, message: msg });
    res.status(500).json({ code: 5004, message: '新建失败：' + e.message });
  }
});

app.put('/api/topologies/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ code: 4001, message: '拓扑 ID 不合法' });
  try {
    const b = req.body || {};
    const r = db.saveTopology(id, { data: b.data, name: b.name, rev: b.rev, user: req.user });
    if (r.code === 'NOT_FOUND') return res.status(404).json({ code: 4041, message: '拓扑不存在或已被删除' });
    if (r.code === 'CONFLICT') {
      return res.status(409).json({
        code: 4090,
        message: '他人已更新此拓扑，请刷新后再改',
        data: { rev: r.rev, updatedByName: r.updatedByName, updatedTs: r.updatedTs }
      });
    }
    res.json({ code: 0, message: 'ok', data: { rev: r.rev, name: r.name, updatedTs: r.updatedTs } });
  } catch (e) {
    const msg = topoErrMsg(e.code);
    if (msg) return res.status(400).json({ code: 4003, message: msg });
    res.status(500).json({ code: 5004, message: '保存失败：' + e.message });
  }
});

app.delete('/api/topologies/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ code: 4001, message: '拓扑 ID 不合法' });
  const ok = db.deleteTopology(id);
  if (!ok) return res.status(404).json({ code: 4041, message: '拓扑不存在或已被删除' });
  res.json({ code: 0, message: 'ok', data: { id } });
});

// 打卡记录列表（普通用户仅自己的；管理员全部 + 筛选）
app.get('/api/checkins', auth, (req, res) => {
  const userId = req.user.role === 'admin' ? null : req.user.id;
  const data = db.list({
    page: req.query.page,
    pageSize: req.query.pageSize,
    name: req.query.name || '',
    location: req.query.location || '',
    q: req.query.q || '',
    from: req.query.from || '',
    to: req.query.to || '',
    bad: req.query.bad === '1' || req.query.bad === 'true'
  }, userId);
  res.json({ code: 0, message: 'ok', data });
});

// 单条记录详情（小程序详情页使用）：普通用户只能看自己的，管理员不受限
app.get('/api/checkins/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ code: 4001, message: '记录 ID 不合法' });
  const row = db.getCheckinById(id);
  if (!row) return res.status(404).json({ code: 4042, message: '记录不存在' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) {
    return res.status(403).json({ code: 403, message: '无权查看该记录' });
  }
  res.json({ code: 0, message: 'ok', data: row });
});

// 统计概览：今日 / 本月 打卡数与异常数（管理员看全站，普通用户看自己）
app.get('/api/stats', auth, (req, res) => {
  const userId = req.user.role === 'admin' ? null : req.user.id;
  res.json({ code: 0, message: 'ok', data: db.stats(userId) });
});

// 删除单条打卡记录（同时清理照片文件）
// 普通用户只能删除自己的记录；管理员可删除任意
app.delete('/api/checkins/:id', auth, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (req.user.role !== 'admin') {
      const r = db.getCheckinOwner(id);
      if (!r) return res.status(404).json({ code: 4042, message: '记录不存在' });
      if (r.user_id !== req.user.id) {
        return res.status(403).json({ code: 403, message: '只能删除自己的打卡记录' });
      }
    }
    const photo = db.deleteCheckin(id);
    if (photo === null) return res.status(404).json({ code: 4042, message: '记录不存在' });
    if (photo) {
      const fp = path.join(UPLOAD_DIR, photo);
      fs.unlink(fp, () => {});
    }
    res.json({ code: 0, message: 'ok' });
  } catch (e) {
    res.status(500).json({ code: 5002, message: e.message });
  }
});

// 反代/CDN 场景下取真实协议与域名（导出内的绝对地址用）
function reqOrigin(req) {
  const pick = (v) => String(v || '').split(',')[0].trim();
  const proto = pick(req.headers['x-forwarded-proto']) || req.protocol || 'http';
  const host = pick(req.headers['x-forwarded-host']) || req.get('host') || 'localhost';
  return `${proto}://${host}`;
}

// CSV 导出（与列表同样的作用域）
app.get('/api/export.csv', auth, (req, res) => {
  const userId = req.user.role === 'admin' ? null : req.user.id;
  const rows = db.allFiltered({
    name: req.query.name || '',
    location: req.query.location || '',
    q: req.query.q || '',
    from: req.query.from || '',
    to: req.query.to || '',
    bad: req.query.bad === '1' || req.query.bad === 'true'
  }, userId);
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  // 巡检明细：优先用动态项目；旧数据回退到固定四列
  const stText = (v) => (v === 'ok' ? '正常' : v === 'bad' ? '不正常' : '');
  const inspOf = (r) => (r.inspections || []).map((i) => ({ name: i.name, status: i.status }));
  const inspAll = (r) => {
    const arr = inspOf(r);
    if (arr.length) return arr;
    return [['机房温度', r.temp_status], ['环境', r.env_status], ['网络设备', r.net_status], ['UPS电池', r.ups_status]]
      .filter(([, v]) => v === 'ok' || v === 'bad')
      .map(([name, status]) => ({ name, status }));
  };
  const inspDetail = (r) => inspAll(r).map((i) => `${i.name}:${stText(i.status)}`).join('；');
  const inspBad = (r) => inspAll(r).filter((i) => i.status === 'bad').map((i) => i.name).join('、');
  const header = ['ID', '时间', '姓名', '工号', '纬度', '经度', '精度(m)', '机房/位置', '巡检明细', '异常项', '巡检说明', '备注', '照片', '照片链接（需登录）'];
  const lines = [header.join(',')];
  // 照片直链（CSV 是纯文本，无法存图；给绝对地址便于在浏览器里打开，需登录后可见）
  const origin = reqOrigin(req);
  for (const r of rows) {
    lines.push([
      r.id, r.created_at, r.name, r.staff_id, r.lat, r.lng, r.accuracy, r.location,
      inspDetail(r), inspBad(r), r.custom_text, r.note,
      r.photo || '',
      r.photo ? `${origin}/api/photo/${encodeURIComponent(r.photo)}` : ''
    ].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="checkins.csv"');
  res.send('﻿' + lines.join('\r\n'));
});

// 单文件 HTML 明细报告（照片 base64 内嵌，可离线查看 / 打印 / 存 PDF）
// 筛选参数与 CSV 一致；photos=0 可导出不含照片的轻量版
app.get('/api/export/detail.html', auth, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const userId = isAdmin ? null : req.user.id;
    // period 仅用于报告封面与文件名的周期说明（本月/上月/本周/上周/全部/自定义），需白名单校验
    const period = ['本月', '上月', '本周', '上周', '全部', '自定义'].includes(req.query.period)
      ? req.query.period : '';
    const query = {
      name: req.query.name || '',
      location: req.query.location || '',
      q: req.query.q || '',
      from: req.query.from || '',
      to: req.query.to || '',
      period,
      bad: req.query.bad === '1' || req.query.bad === 'true'
    };
    const rows = db.allFiltered(query, userId);
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
    const fname = `机房巡检明细_${period ? period + '_' : ''}${stamp}_${rows.length}条.html`;
    res.setHeader('Content-Disposition',
      `attachment; filename="checkin_detail_${stamp}.html"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    writeDetailHtml(res, {
      rows,
      query,
      isAdmin,
      user: req.user,
      uploadDir: UPLOAD_DIR,
      withPhotos: req.query.photos !== '0'
    });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ code: 5003, message: '导出失败：' + e.message });
    else res.end();
  }
});

// Excel(.xlsx) 明细导出：现场照片以图片对象内嵌在「现场照片」列（CSV 是纯文本，无法携带图片）
// 参数与 HTML 报告一致；photos=0 输出不含照片的轻量版
app.get('/api/export.xlsx', auth, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const userId = isAdmin ? null : req.user.id;
    const period = ['本月', '上月', '本周', '上周', '全部', '自定义'].includes(req.query.period)
      ? req.query.period : '';
    const query = {
      name: req.query.name || '',
      location: req.query.location || '',
      q: req.query.q || '',
      from: req.query.from || '',
      to: req.query.to || '',
      period,
      bad: req.query.bad === '1' || req.query.bad === 'true'
    };
    const rows = db.allFiltered(query, userId);
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
    const withPhotos = req.query.photos !== '0';
    const fname = `机房巡检明细_${period ? period + '_' : ''}${stamp}_${rows.length}条`
      + `${withPhotos ? '' : '_无照片'}.xlsx`;
    res.setHeader('Content-Disposition',
      `attachment; filename="checkin_detail_${stamp}.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    writeDetailXlsx(res, {
      rows,
      query,
      isAdmin,
      user: req.user,
      uploadDir: UPLOAD_DIR,
      withPhotos,
      scope: scopeText(query, isAdmin),
      operator: (req.user && (req.user.displayName || req.user.username)) || ''
    });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ code: 5004, message: '导出失败：' + e.message });
    else res.end();
  }
});

// 月度巡检汇总导出（按 机房/位置 + 人员 聚合异常次数与异常率）
app.get('/api/export-summary.csv', auth, (req, res) => {
  const userId = req.user.role === 'admin' ? null : req.user.id;
  const sm = db.monthSummary(req.query.month, userId);
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const p2 = (n) => String(n).padStart(2, '0');
  const ts = (v) => {
    if (!v) return '';
    const d = new Date(Number(v));
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  };
  // 项目异常列为动态列：不同模板的巡检项目不同，按当月实际出现异常的项目生成
  const header = ['月份', '机房/位置', '姓名', '打卡次数', '异常次数', '异常率',
    ...sm.itemNames.map((n) => n + '异常'), '首次打卡', '最后打卡'];
  const lines = [header.join(',')];
  for (const r of sm.rows) {
    const rate = r.total ? Math.round((r.bad_total / r.total) * 1000) / 10 + '%' : '0%';
    lines.push([
      sm.month, r.location || '', r.name || '', r.total, r.bad_total, rate,
      ...sm.itemNames.map((n) => (r.itemBad && r.itemBad[n]) || 0),
      ts(r.first_ts), ts(r.last_ts)
    ].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="summary_${sm.month}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
});

// ---------- 人员 / 机房 配置（供打卡页下拉框使用） ----------
app.get('/api/staff', (req, res) => res.json({ code: 0, message: 'ok', data: db.listStaff() }));
app.post('/api/staff', auth, adminOnly, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ code: 4002, message: '姓名不能为空' });
  const id = db.addStaff({ name, staffId: (req.body.staffId || '').trim(), sort: req.body.sort });
  res.json({ code: 0, message: 'ok', data: { id } });
});
app.put('/api/staff/:id', auth, adminOnly, (req, res) => {
  const ok = db.updateStaff(Number(req.params.id), {
    name: (req.body.name || '').trim(),
    staffId: (req.body.staffId || '').trim(),
    sort: req.body.sort
  });
  if (!ok) return res.status(404).json({ code: 4041, message: '人员不存在' });
  res.json({ code: 0, message: 'ok' });
});
app.delete('/api/staff/:id', auth, adminOnly, (req, res) => {
  const ok = db.deleteStaff(Number(req.params.id));
  if (!ok) return res.status(404).json({ code: 4041, message: '人员不存在' });
  res.json({ code: 0, message: 'ok' });
});

// ---------- 机房 / 分组 / 巡检模板 ----------
// 机房列表（含分组与模板信息，打卡页与记录页筛选共用）
app.get('/api/rooms', (req, res) => res.json({ code: 0, message: 'ok', data: db.listRooms() }));
app.post('/api/rooms', auth, adminOnly, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ code: 4002, message: '机房名称不能为空' });
  if (db.getRoomByName(name)) return res.status(400).json({ code: 4012, message: '该机房名称已存在' });
  const id = db.addRoom({ name, sort: req.body.sort, groupId: req.body.groupId });
  res.json({ code: 0, message: 'ok', data: { id } });
});
app.put('/api/rooms/:id', auth, adminOnly, (req, res) => {
  const ok = db.updateRoom(Number(req.params.id), {
    name: (req.body.name || '').trim() || undefined,
    sort: req.body.sort,
    groupId: req.body.groupId
  });
  if (!ok) return res.status(404).json({ code: 4041, message: '机房不存在' });
  res.json({ code: 0, message: 'ok' });
});
app.delete('/api/rooms/:id', auth, adminOnly, (req, res) => {
  const ok = db.deleteRoom(Number(req.params.id));
  if (!ok) return res.status(404).json({ code: 4041, message: '机房不存在' });
  res.json({ code: 0, message: 'ok' });
});

// 机房分组管理（同组机房共用同一巡检模板）
app.get('/api/room-groups', auth, adminOnly, (req, res) => res.json({ code: 0, message: 'ok', data: db.listGroups() }));
app.post('/api/room-groups', auth, adminOnly, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ code: 4002, message: '分组名称不能为空' });
  const id = db.addGroup({ name, templateId: req.body.templateId, sort: req.body.sort });
  res.json({ code: 0, message: 'ok', data: { id } });
});
app.put('/api/room-groups/:id', auth, adminOnly, (req, res) => {
  const ok = db.updateGroup(Number(req.params.id), {
    name: (req.body.name || '').trim() || undefined,
    templateId: req.body.templateId,
    sort: req.body.sort
  });
  if (!ok) return res.status(404).json({ code: 4041, message: '分组不存在' });
  res.json({ code: 0, message: 'ok' });
});
app.delete('/api/room-groups/:id', auth, adminOnly, (req, res) => {
  const ok = db.deleteGroup(Number(req.params.id));
  if (!ok) return res.status(404).json({ code: 4041, message: '分组不存在' });
  res.json({ code: 0, message: 'ok' });
});

// 巡检模板与项目
app.get('/api/inspect/templates', auth, adminOnly, (req, res) => res.json({ code: 0, message: 'ok', data: db.listTemplates() }));
app.post('/api/inspect/templates', auth, adminOnly, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ code: 4002, message: '模板名称不能为空' });
  const id = db.addTemplate({ name, description: req.body.description, sort: req.body.sort });
  res.json({ code: 0, message: 'ok', data: { id } });
});
app.put('/api/inspect/templates/:id', auth, adminOnly, (req, res) => {
  const ok = db.updateTemplate(Number(req.params.id), {
    name: (req.body.name || '').trim() || undefined,
    description: req.body.description,
    sort: req.body.sort
  });
  if (!ok) return res.status(404).json({ code: 4041, message: '模板不存在' });
  res.json({ code: 0, message: 'ok' });
});
app.delete('/api/inspect/templates/:id', auth, adminOnly, (req, res) => {
  const ok = db.deleteTemplate(Number(req.params.id));
  if (!ok) return res.status(404).json({ code: 4041, message: '模板不存在' });
  res.json({ code: 0, message: 'ok' });
});
app.post('/api/inspect/templates/:id/items', auth, adminOnly, (req, res) => {
  const tplId = Number(req.params.id);
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ code: 4002, message: '巡检项目名称不能为空' });
  const r = db.addItem(tplId, name);
  if (r.dup) return res.status(400).json({ code: 4013, message: '该模板下已存在同名巡检项目' });
  res.json({ code: 0, message: 'ok', data: { id: r.id } });
});
app.put('/api/inspect/items/:id', auth, adminOnly, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ code: 4002, message: '巡检项目名称不能为空' });
  const ok = db.updateItem(Number(req.params.id), name);
  if (!ok) return res.status(404).json({ code: 4041, message: '巡检项目不存在' });
  res.json({ code: 0, message: 'ok' });
});
app.delete('/api/inspect/items/:id', auth, adminOnly, (req, res) => {
  const ok = db.deleteItem(Number(req.params.id));
  if (!ok) return res.status(404).json({ code: 4041, message: '巡检项目不存在' });
  res.json({ code: 0, message: 'ok' });
});

// ---------- 用户管理（仅管理员） ----------
app.get('/api/users', auth, adminOnly, (req, res) => res.json({ code: 0, message: 'ok', data: db.listUsers() }));

app.post('/api/users', auth, adminOnly, (req, res) => {
  const username = (req.body.username || '').trim();
  if (!username) return res.status(400).json({ code: 4001, message: '登录账号不能为空' });
  if (db.getUserByUsername(username)) return res.status(400).json({ code: 4005, message: '该账号已存在' });
  const pw = (req.body.password && String(req.body.password).length >= 6) ? String(req.body.password) : db.genPassword(10);
  const id = db.createUser({
    username,
    displayName: req.body.displayName,
    staffId: req.body.staffId,
    role: req.body.role,
    password: pw
  });
  // 返回初始/生成密码，供管理员转交用户（下次登录强制改密）
  res.json({ code: 0, message: 'ok', data: { id, password: pw } });
});

// 重置单个用户密码
app.post('/api/users/:id/reset', auth, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (!db.getUserById(id)) return res.status(404).json({ code: 4041, message: '用户不存在' });
  const pw = db.genPassword(10);
  db.setPassword(id, pw);
  res.json({ code: 0, message: 'ok', data: { password: pw } });
});

// 重置全部普通用户密码
app.post('/api/users/reset-all', auth, adminOnly, (req, res) => {
  const users = db.listUsers().filter((u) => u.role !== 'admin');
  const out = [];
  for (const u of users) {
    const pw = db.genPassword(10);
    db.setPassword(u.id, pw);
    out.push({ id: u.id, username: u.username, password: pw });
  }
  res.json({ code: 0, message: 'ok', data: out });
});

// 删除用户
app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const u = db.getUserById(id);
  if (!u) return res.status(404).json({ code: 4041, message: '用户不存在' });
  if (u.id === req.user.id) return res.status(400).json({ code: 4006, message: '不能删除当前登录账号' });
  if (u.role === 'admin' && db.countAdmins() <= 1) return res.status(400).json({ code: 4007, message: '不能删除唯一的管理员' });
  db.deleteUser(id);
  res.json({ code: 0, message: 'ok' });
});

// ---------- 统一错误处理（multer 等） ----------
app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ code: 4000, message: err.message });
  next();
});

// ---------- 启动 ----------
http.createServer(app).listen(PORT, () => {
  console.log(`[HTTP ] 打卡服务已启动: http://localhost:${PORT}`);
  console.log(`         手机管理端:    http://localhost:${PORT}/admin.html`);
});

const keyPath = process.env.SSL_KEY;
const certPath = process.env.SSL_CERT;
if (keyPath && certPath && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  try {
    const credentials = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    https.createServer(credentials, app).listen(SSL_PORT, () => {
      console.log(`[HTTPS] 安全服务已启动: https://localhost:${SSL_PORT}`);
      console.log(`         ⚠ 手机访问 GPS/摄像头必须使用 HTTPS，请用电脑局域网IP替换 localhost`);
    });
  } catch (e) {
    console.error('HTTPS 启动失败（已忽略，仅 HTTP 可用）:', e.message);
  }
}
