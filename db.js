'use strict';
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'checkin.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS checkins (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  name       TEXT,
  staff_id   TEXT,
  lat        REAL,
  lng        REAL,
  accuracy   REAL,
  location   TEXT,
  note       TEXT,
  photo      TEXT,
  temp_status TEXT,
  env_status  TEXT,
  net_status  TEXT,
  ups_status  TEXT,
  custom_text TEXT,
  created_at TEXT,
  created_ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_checkin_ts ON checkins(created_ts);
CREATE INDEX IF NOT EXISTS idx_checkin_name ON checkins(name);

CREATE TABLE IF NOT EXISTS staff (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  staff_id   TEXT,
  sort       INTEGER DEFAULT 0,
  created_ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_staff_sort ON staff(sort, id);

CREATE TABLE IF NOT EXISTS rooms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  sort       INTEGER DEFAULT 0,
  created_ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_room_sort ON rooms(sort, id);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  staff_id      TEXT,
  role          TEXT NOT NULL DEFAULT 'user',
  password_hash TEXT NOT NULL,
  must_change_pw INTEGER NOT NULL DEFAULT 1,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_ts    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_user_name ON users(username);

-- 巡检模板（一套巡检项目，可被多个机房分组复用）
CREATE TABLE IF NOT EXISTS inspect_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  sort        INTEGER DEFAULT 0,
  created_ts  INTEGER
);

-- 巡检项目（隶属某个模板）
CREATE TABLE IF NOT EXISTS inspect_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  name        TEXT NOT NULL,
  sort        INTEGER DEFAULT 0,
  created_ts  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_item_tpl ON inspect_items(template_id, sort, id);

-- 机房分组（同组机房使用同一个巡检模板）
CREATE TABLE IF NOT EXISTS room_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  template_id INTEGER,
  sort        INTEGER DEFAULT 0,
  created_ts  INTEGER
);

-- 打卡的巡检结果（动态项目，一行一个项目）
CREATE TABLE IF NOT EXISTS checkin_inspections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  checkin_id INTEGER NOT NULL,
  item_id    INTEGER,
  item_name  TEXT,
  status     TEXT,
  sort       INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ci_checkin ON checkin_inspections(checkin_id);
CREATE INDEX IF NOT EXISTS idx_ci_status ON checkin_inspections(status);

-- 通用键值配置（水印设置等）
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_ts INTEGER
);

-- 水印模板：可配置多套，打卡时任选其一；is_default=1 的那套为系统默认
CREATE TABLE IF NOT EXISTS watermark_templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  config     TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_ts INTEGER,
  updated_ts INTEGER
);

-- 机柜连线拓扑：一份记录 = 一个机房的完整图（data 为编辑器 state 的 JSON 原文）
-- rev 为乐观锁版本号，保存时必须与库中一致，否则视为他人已改，返回冲突
CREATE TABLE IF NOT EXISTS rack_topologies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  data            TEXT NOT NULL,
  rev             INTEGER NOT NULL DEFAULT 1,
  rack_count      INTEGER NOT NULL DEFAULT 0,
  device_count    INTEGER NOT NULL DEFAULT 0,
  wire_count      INTEGER NOT NULL DEFAULT 0,
  created_by      INTEGER,
  created_by_name TEXT,
  updated_by      INTEGER,
  updated_by_name TEXT,
  created_ts      INTEGER NOT NULL,
  updated_ts      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topo_updated ON rack_topologies(updated_ts DESC);
`);

// 兼容旧库：补加 user_id 列（已在库的 checkins 表可能缺少该字段）
(function migrate() {
  try {
    const cols = db.prepare('PRAGMA table_info(checkins)').all().map((c) => c.name);
    if (!cols.includes('user_id')) {
      db.prepare('ALTER TABLE checkins ADD COLUMN user_id INTEGER').run();
    }
    db.prepare('CREATE INDEX IF NOT EXISTS idx_checkin_uid ON checkins(user_id)').run();
    // 巡检项字段（旧库兼容）：温度/环境/网络设备/UPS电池 + 自定义说明
    const inspectCols = [['temp_status', 'TEXT'], ['env_status', 'TEXT'], ['net_status', 'TEXT'], ['ups_status', 'TEXT'], ['custom_text', 'TEXT'], ['wm_template', 'TEXT'],
      // 照片体积审计：压缩后落盘字节 / 客户端原始字节
      ['photo_bytes', 'INTEGER'], ['photo_raw_bytes', 'INTEGER']];
    for (const [c, t] of inspectCols) {
      if (!cols.includes(c)) db.prepare(`ALTER TABLE checkins ADD COLUMN ${c} ${t}`).run();
    }
  } catch (e) { /* 忽略 */ }
  try {
    const ucols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    if (!ucols.includes('token_version')) {
      db.prepare('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0').run();
    }
  } catch (e) { /* 忽略 */ }
  try {
    // 机房归属分组（旧库兼容）
    const rcols = db.prepare('PRAGMA table_info(rooms)').all().map((c) => c.name);
    if (!rcols.includes('group_id')) {
      db.prepare('ALTER TABLE rooms ADD COLUMN group_id INTEGER').run();
    }
    db.prepare('CREATE INDEX IF NOT EXISTS idx_room_group ON rooms(group_id)').run();
  } catch (e) { /* 忽略 */ }
})();

// ---------- 密码工具 ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}
function verifyPassword(pw, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const got = crypto.scryptSync(String(pw), salt, 64);
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  } catch (e) {
    return false;
  }
}
function genPassword(len = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const b = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += chars[b[i] % chars.length];
  return s;
}

// ---------- 首次初始化 ----------
(function seedIfEmpty() {
  const ts = Date.now();
  // 机房示例（可在管理端修改/删除）
  if (db.prepare('SELECT COUNT(*) c FROM rooms').get().c === 0) {
    const ins = db.prepare('INSERT INTO rooms (name, sort, created_ts) VALUES (?,?,?)');
    [['核心机房A区', 1], ['核心机房B区', 2], ['UPS配电间', 3], ['网络接入间', 4]]
      .forEach(([n, s]) => ins.run(n, s, ts));
  }
  // 管理员账号（首次登录必须改密）
  // 初始密码优先级：环境变量 INIT_ADMIN_PASSWORD > 随机生成（仅首次）
  // 迁移部署包内不硬编码任何固定密码，避免泄露。
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
    const fromEnv = !!(process.env.INIT_ADMIN_PASSWORD && process.env.INIT_ADMIN_PASSWORD.length >= 6);
    const initPw = fromEnv ? process.env.INIT_ADMIN_PASSWORD : genPassword(12);
    db.prepare(`INSERT INTO users (username, display_name, staff_id, role, password_hash, must_change_pw, created_ts)
      VALUES (?,?,?,?,?,?,?)`)
      .run('admin', '系统管理员', '', 'admin', hashPassword(initPw), 1, ts);
    // 初始密码落盘为仅管理员可读的文件（权限 600），防止错过控制台输出后无处找回
    const pwFile = path.join(DATA_DIR, 'first_password.txt');
    try {
      fs.writeFileSync(pwFile,
        'IT 机房打卡服务 · 初始管理员密码（仅首次生成，首次登录后请修改并删除本文件）\n' +
        '=====================================================================\n' +
        '生成时间: ' + new Date().toLocaleString() + '\n' +
        '账号    : admin\n' +
        '初始密码: ' + initPw + '\n' +
        '来源    : ' + (fromEnv ? '环境变量 INIT_ADMIN_PASSWORD' : '系统随机生成') + '\n' +
        '=====================================================================\n',
        { mode: 0o600 });
      fs.chmodSync(pwFile, 0o600);
    } catch (e) {
      console.error(' [初始化] 写入初始密码文件失败:', e.message);
    }
    console.log('\n======================================================');
    console.log(' [初始化] 管理员账号 : admin');
    console.log(' [初始化] 初始密码   : ' + initPw + '   （请立即登录并修改）');
    console.log(' [初始化] 密码已保存 : ' + pwFile + '（权限 600，仅管理员可读）');
    console.log(' 该密码仅生成一次，首次登录强制修改；改密后请删除该文件。');
    console.log('======================================================\n');
  }
  // 巡检模板：首次初始化，内置与旧版一致的 4 项，避免历史习惯被打断
  if (db.prepare('SELECT COUNT(*) c FROM inspect_templates').get().c === 0) {
    const tplId = db.prepare('INSERT INTO inspect_templates (name, description, sort, created_ts) VALUES (?,?,?,?)')
      .run('标准机房巡检', '机房温度 / 环境 / 网络设备 / UPS电池', 1, ts).lastInsertRowid;
    const insItem = db.prepare('INSERT INTO inspect_items (template_id, name, sort, created_ts) VALUES (?,?,?,?)');
    ['机房温度', '环境', '网络设备', 'UPS电池'].forEach((n, i) => insItem.run(tplId, n, i + 1, ts));
  }
  // 机房分组：首次初始化一个默认分组，绑定第一个模板
  if (db.prepare('SELECT COUNT(*) c FROM room_groups').get().c === 0) {
    const tpl = db.prepare('SELECT id FROM inspect_templates ORDER BY sort ASC, id ASC LIMIT 1').get();
    db.prepare('INSERT INTO room_groups (name, template_id, sort, created_ts) VALUES (?,?,?,?)')
      .run('默认分组', tpl ? tpl.id : null, 1, ts);
  }
  // 未分组机房统一归入默认分组，保证打卡页一定能取到巡检项目
  const dg = db.prepare('SELECT id FROM room_groups ORDER BY sort ASC, id ASC LIMIT 1').get();
  if (dg) db.prepare('UPDATE rooms SET group_id=? WHERE group_id IS NULL').run(dg.id);
})();

function trim(v, n) {
  return String(v == null ? '' : v).slice(0, n);
}

// ---------- 打卡记录 ----------
function insert(r) {
  const now = new Date();
  const info = db.prepare(`
    INSERT INTO checkins (user_id, name, staff_id, lat, lng, accuracy, location, note, photo,
      temp_status, env_status, net_status, ups_status, custom_text, wm_template,
      photo_bytes, photo_raw_bytes, created_at, created_ts)
    VALUES (@userId, @name, @staffId, @lat, @lng, @accuracy, @location, @note, @photo,
      @tempStatus, @envStatus, @netStatus, @upsStatus, @customText, @wmTemplate,
      @photoBytes, @photoRawBytes, @createdAt, @createdTs)
  `).run({
    userId: r.userId == null ? null : r.userId,
    name: trim(r.name, 64),
    staffId: trim(r.staffId, 64),
    lat: r.lat,
    lng: r.lng,
    accuracy: r.accuracy,
    location: trim(r.location, 128),
    note: trim(r.note, 512),
    photo: r.photo,
    tempStatus: r.tempStatus || null,
    envStatus: r.envStatus || null,
    netStatus: r.netStatus || null,
    upsStatus: r.upsStatus || null,
    customText: r.customText == null ? null : trim(r.customText, 500),
    wmTemplate: r.wmTemplate == null ? null : trim(r.wmTemplate, 64),
    photoBytes: Number.isFinite(r.photoBytes) ? Math.round(r.photoBytes) : null,
    photoRawBytes: Number.isFinite(r.photoRawBytes) ? Math.round(r.photoRawBytes) : null,
    createdAt: now.toISOString(),
    createdTs: now.getTime()
  });
  return info.lastInsertRowid;
}

// 任一巡检项为「不正常」的条件（异常记录）
// 兼容两种数据：新的动态巡检表 checkin_inspections + 旧版固定的四列
const BAD_COND = "((temp_status='bad' OR env_status='bad' OR net_status='bad' OR ups_status='bad')" +
  " OR EXISTS (SELECT 1 FROM checkin_inspections ci WHERE ci.checkin_id = checkins.id AND ci.status='bad'))";

// userId 为 null 表示管理员查全部；否则只查该用户
function buildWhere(q, userId) {
  const where = [];
  const params = {};
  if (userId != null) { where.push('user_id = @userId'); params.userId = userId; }
  if (q.name) { where.push('name LIKE @name'); params.name = '%' + String(q.name).trim() + '%'; }
  if (q.location) { where.push('location LIKE @location'); params.location = '%' + String(q.location).trim() + '%'; }
  if (q.from) { where.push('created_ts >= @from'); params.from = Number(q.from); }
  if (q.to) { where.push('created_ts <= @to'); params.to = Number(q.to); }
  // 关键字：跨机房 / 姓名 / 备注 / 巡检说明模糊匹配（一行输入即可搜）
  if (q.q) {
    const kw = String(q.q).trim().slice(0, 64);
    if (kw) {
      where.push('(location LIKE @kw OR name LIKE @kw OR note LIKE @kw OR custom_text LIKE @kw)');
      params.kw = '%' + kw + '%';
    }
  }
  // 只看异常：四项任一项为 bad
  if (q.bad) where.push(BAD_COND);
  const ws = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return { ws, params };
}

// 统计：今日 / 本月 打卡数与异常数（userId 为 null 表示全站）
function stats(userId) {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const count = (conds, params) =>
    db.prepare(`SELECT COUNT(*) c FROM checkins WHERE ${conds.join(' AND ')}`).get(params).c;
  const build = (since, bad) => {
    const conds = ['created_ts >= @since'];
    const params = { since };
    if (bad) conds.push(BAD_COND);
    if (userId != null) { conds.push('user_id = @uid'); params.uid = userId; }
    return count(conds, params);
  };
  const lastSince = (since) => {
    const conds = ['created_ts >= @since'];
    const p = { since };
    if (userId != null) { conds.push('user_id = @uid'); p.uid = userId; }
    const row = db.prepare(`SELECT MAX(created_ts) t FROM checkins WHERE ${conds.join(' AND ')}`).get(p);
    return row && row.t ? new Date(row.t).toISOString() : null;
  };
  // 近 7 日趋势（含今天，按本地日期分桶；无记录的日期补 0）
  const trend = (() => {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      days.push({
        date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        total: 0,
        bad: 0
      });
    }
    const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
    const conds = ['created_ts >= @since'];
    const p = { since };
    if (userId != null) { conds.push('user_id = @uid'); p.uid = userId; }
    const rows = db.prepare(
      `SELECT date(created_ts/1000, 'unixepoch', 'localtime') d, COUNT(*) total,
              SUM(CASE WHEN ${BAD_COND} THEN 1 ELSE 0 END) bad
         FROM checkins WHERE ${conds.join(' AND ')} GROUP BY d`
    ).all(p);
    const byDate = new Map(rows.map((r) => [r.d, r]));
    return days.map((d) => {
      const hit = byDate.get(d.date);
      return { date: d.date, total: hit ? hit.total : 0, bad: hit ? (hit.bad || 0) : 0 };
    });
  })();
  return {
    today: build(dayStart, false),
    todayBad: build(dayStart, true),
    month: build(monthStart, false),
    monthBad: build(monthStart, true),
    lastToday: lastSince(dayStart),
    lastMonth: lastSince(monthStart),
    trend
  };
}

// 写入本次打卡的巡检结果（动态项目）
function insertInspections(checkinId, items) {
  if (!Array.isArray(items) || !items.length) return 0;
  const st = db.prepare(
    'INSERT INTO checkin_inspections (checkin_id, item_id, item_name, status, sort) VALUES (?,?,?,?,?)'
  );
  let n = 0;
  const tx = db.transaction((list) => {
    list.forEach((it, i) => {
      st.run(checkinId, it.itemId == null ? null : it.itemId, trim(it.name, 64), it.status, i + 1);
      n++;
    });
  });
  tx(items);
  return n;
}

// 月度巡检汇总：按 机房/位置 + 人员 聚合（userId 为 null 表示全站）
// itemNames 为当月出现异常的项目名（动态列），rows[].itemBad 为该项目异常次数
function monthSummary(month, userId) {
  const m = /^(\d{4})-(\d{1,2})$/.exec(String(month || ''));
  const now = new Date();
  const y = m ? Number(m[1]) : now.getFullYear();
  const mo = m ? Number(m[2]) - 1 : now.getMonth();
  const from = new Date(y, mo, 1).getTime();
  const to = new Date(y, mo + 1, 1).getTime();
  const conds = ['created_ts >= @from', 'created_ts < @to'];
  const params = { from, to };
  if (userId != null) { conds.push('user_id = @uid'); params.uid = userId; }
  const rows = db.prepare(`
    SELECT location, name,
      COUNT(*) total,
      SUM(CASE WHEN temp_status='bad' THEN 1 ELSE 0 END) temp_bad,
      SUM(CASE WHEN env_status='bad' THEN 1 ELSE 0 END) env_bad,
      SUM(CASE WHEN net_status='bad' THEN 1 ELSE 0 END) net_bad,
      SUM(CASE WHEN ups_status='bad' THEN 1 ELSE 0 END) ups_bad,
      SUM(CASE WHEN ${BAD_COND} THEN 1 ELSE 0 END) bad_total,
      MIN(created_ts) first_ts,
      MAX(created_ts) last_ts
    FROM checkins
    WHERE ${conds.join(' AND ')}
    GROUP BY location, name
    ORDER BY location ASC, name ASC
  `).all(params);

  // 动态巡检项目的异常次数
  const cj = ['c.created_ts >= @from', 'c.created_ts < @to'];
  if (userId != null) cj.push('c.user_id = @uid');
  const itemRows = db.prepare(`
    SELECT c.location loc, c.name pname, ci.item_name nm, COUNT(*) cnt
    FROM checkin_inspections ci
    JOIN checkins c ON c.id = ci.checkin_id
    WHERE ci.status='bad' AND ${cj.join(' AND ')}
    GROUP BY c.location, c.name, ci.item_name
  `).all(params);

  const LEGACY = [['机房温度', 'temp_bad'], ['环境', 'env_bad'], ['网络设备', 'net_bad'], ['UPS电池', 'ups_bad']];
  const key = (l, n) => String(l || '') + '\u0001' + String(n || '');
  const byKey = new Map(rows.map((r) => [key(r.location, r.name), r]));
  const names = new Set();
  for (const r of rows) {
    r.itemBad = {};
    for (const [nm, col] of LEGACY) {
      if (r[col]) { r.itemBad[nm] = r[col]; names.add(nm); }
    }
  }
  for (const it of itemRows) {
    const r = byKey.get(key(it.loc, it.pname));
    if (!r) continue;
    r.itemBad[it.nm] = (r.itemBad[it.nm] || 0) + it.cnt;
    names.add(it.nm);
  }
  const order = ['机房温度', '环境', '网络设备', 'UPS电池'];
  const itemNames = Array.from(names).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return String(a).localeCompare(String(b), 'zh');
  });
  return { month: `${y}-${String(mo + 1).padStart(2, '0')}`, from, to, rows, itemNames };
}

// 批量附加巡检明细（一次查询，避免 N+1）
function attachInspections(rows) {
  if (!rows || !rows.length) return rows || [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const items = db.prepare(
    `SELECT checkin_id, item_id, item_name, status, sort FROM checkin_inspections
     WHERE checkin_id IN (${ph}) ORDER BY checkin_id ASC, sort ASC, id ASC`
  ).all(...ids);
  const map = new Map();
  for (const it of items) {
    if (!map.has(it.checkin_id)) map.set(it.checkin_id, []);
    map.get(it.checkin_id).push({ itemId: it.item_id, name: it.item_name, status: it.status });
  }
  for (const r of rows) r.inspections = map.get(r.id) || [];
  return rows;
}

function list(q, userId) {
  const { ws, params } = buildWhere(q, userId);
  const total = db.prepare(`SELECT COUNT(*) c FROM checkins ${ws}`).get(params).c;
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(q.pageSize, 10) || 20));
  const rows = db.prepare(
    `SELECT * FROM checkins ${ws} ORDER BY created_ts DESC LIMIT @lim OFFSET @off`
  ).all({ ...params, lim: pageSize, off: (page - 1) * pageSize });
  attachInspections(rows);
  return { list: rows, total, page, pageSize };
}

function allFiltered(q, userId) {
  const { ws, params } = buildWhere(q, userId);
  const rows = db.prepare(`SELECT * FROM checkins ${ws} ORDER BY created_ts DESC`).all(params);
  return attachInspections(rows);
}

// 删除单条打卡记录，返回其照片文件名（供调用方清理文件，无则 null）
function deleteCheckin(id) {
  const row = db.prepare('SELECT photo FROM checkins WHERE id=?').get(id);
  if (!row) return null;
  db.prepare('DELETE FROM checkin_inspections WHERE checkin_id=?').run(id);
  db.prepare('DELETE FROM checkins WHERE id=?').run(id);
  return row.photo;
}
// 单条打卡记录（含巡检明细），供详情页使用
function getCheckinById(id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return null;
  const row = db.prepare('SELECT * FROM checkins WHERE id=?').get(n);
  if (!row) return null;
  attachInspections([row]);
  return row;
}
function getCheckinOwner(id) {
  return db.prepare('SELECT user_id FROM checkins WHERE id=?').get(id);
}
// 按照片文件名查归属用户（用于照片鉴权）
function getPhotoOwner(name) {
  const row = db.prepare('SELECT user_id FROM checkins WHERE photo=? LIMIT 1').get(name);
  if (!row) return { found: false, userId: null };
  return { found: true, userId: row.user_id == null ? null : row.user_id };
}

// ---------- 人员 staff（历史兼容，保留） ----------
function listStaff() {
  return db.prepare('SELECT id, name, staff_id, sort FROM staff ORDER BY sort ASC, id ASC').all();
}
function addStaff(r) {
  const info = db.prepare('INSERT INTO staff (name, staff_id, sort, created_ts) VALUES (@name, @staffId, @sort, @ts)').run({
    name: trim(r.name, 64),
    staffId: trim(r.staffId || '', 64),
    sort: Number.isFinite(+r.sort) ? +r.sort : 0,
    ts: Date.now()
  });
  return info.lastInsertRowid;
}
function updateStaff(id, r) {
  const cur = db.prepare('SELECT * FROM staff WHERE id=?').get(id);
  if (!cur) return false;
  db.prepare('UPDATE staff SET name=@name, staff_id=@staffId, sort=@sort WHERE id=@id').run({
    id,
    name: r.name != null ? trim(r.name, 64) : cur.name,
    staffId: r.staffId != null ? trim(r.staffId, 64) : cur.staff_id,
    sort: r.sort != null && Number.isFinite(+r.sort) ? +r.sort : cur.sort
  });
  return true;
}
function deleteStaff(id) {
  return db.prepare('DELETE FROM staff WHERE id=?').run(id).changes > 0;
}

// ---------- 巡检模板 / 巡检项目 ----------
function listTemplates() {
  const tpls = db.prepare('SELECT id, name, description, sort FROM inspect_templates ORDER BY sort ASC, id ASC').all();
  const items = db.prepare('SELECT id, template_id, name, sort FROM inspect_items ORDER BY sort ASC, id ASC').all();
  const byTpl = new Map();
  for (const it of items) {
    if (!byTpl.has(it.template_id)) byTpl.set(it.template_id, []);
    byTpl.get(it.template_id).push({ id: it.id, name: it.name, sort: it.sort });
  }
  for (const t of tpls) t.items = byTpl.get(t.id) || [];
  return tpls;
}
function addTemplate(r) {
  const info = db.prepare('INSERT INTO inspect_templates (name, description, sort, created_ts) VALUES (?,?,?,?)')
    .run(trim(r.name, 64), trim(r.description || '', 200), Number.isFinite(+r.sort) ? +r.sort : 0, Date.now());
  return info.lastInsertRowid;
}
function updateTemplate(id, r) {
  const cur = db.prepare('SELECT * FROM inspect_templates WHERE id=?').get(id);
  if (!cur) return false;
  db.prepare('UPDATE inspect_templates SET name=@name, description=@desc, sort=@sort WHERE id=@id').run({
    id,
    name: r.name != null ? trim(r.name, 64) : cur.name,
    desc: r.description != null ? trim(r.description, 200) : cur.description,
    sort: r.sort != null && Number.isFinite(+r.sort) ? +r.sort : cur.sort
  });
  return true;
}
// 删除模板：一并删除其项目，并把引用它的分组置空（机房不再有巡检项）
function deleteTemplate(id) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM inspect_items WHERE template_id=?').run(id);
    db.prepare('UPDATE room_groups SET template_id=NULL WHERE template_id=?').run(id);
    return db.prepare('DELETE FROM inspect_templates WHERE id=?').run(id).changes > 0;
  });
  return tx();
}
function addItem(templateId, name) {
  const dup = db.prepare('SELECT id FROM inspect_items WHERE template_id=? AND name=?').get(templateId, trim(name, 64));
  if (dup) return { id: null, dup: true };
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort),0) m FROM inspect_items WHERE template_id=?').get(templateId).m;
  const info = db.prepare('INSERT INTO inspect_items (template_id, name, sort, created_ts) VALUES (?,?,?,?)')
    .run(templateId, trim(name, 64), maxSort + 1, Date.now());
  return { id: info.lastInsertRowid, dup: false };
}
function updateItem(id, name) {
  return db.prepare('UPDATE inspect_items SET name=? WHERE id=?').run(trim(name, 64), id).changes > 0;
}
function deleteItem(id) {
  return db.prepare('DELETE FROM inspect_items WHERE id=?').run(id).changes > 0;
}
function getTemplateItems(templateId) {
  return db.prepare('SELECT id, name, sort FROM inspect_items WHERE template_id=? ORDER BY sort ASC, id ASC').all(templateId);
}

// ---------- 机房分组 ----------
function listGroups() {
  return db.prepare(`
    SELECT g.id, g.name, g.template_id, g.sort, t.name AS template_name,
      (SELECT COUNT(*) FROM rooms r WHERE r.group_id = g.id) AS room_count
    FROM room_groups g LEFT JOIN inspect_templates t ON t.id = g.template_id
    ORDER BY g.sort ASC, g.id ASC
  `).all();
}
function addGroup(r) {
  const info = db.prepare('INSERT INTO room_groups (name, template_id, sort, created_ts) VALUES (?,?,?,?)')
    .run(trim(r.name, 64), r.templateId == null || r.templateId === '' ? null : Number(r.templateId),
      Number.isFinite(+r.sort) ? +r.sort : 0, Date.now());
  return info.lastInsertRowid;
}
function updateGroup(id, r) {
  const cur = db.prepare('SELECT * FROM room_groups WHERE id=?').get(id);
  if (!cur) return false;
  const tpl = r.templateId === undefined ? cur.template_id
    : (r.templateId == null || r.templateId === '' ? null : Number(r.templateId));
  db.prepare('UPDATE room_groups SET name=@name, template_id=@tpl, sort=@sort WHERE id=@id').run({
    id,
    name: r.name != null ? trim(r.name, 64) : cur.name,
    tpl,
    sort: r.sort != null && Number.isFinite(+r.sort) ? +r.sort : cur.sort
  });
  return true;
}
// 删除分组：该组机房变为未分组（仍可打卡，但无巡检项）
function deleteGroup(id) {
  const tx = db.transaction(() => {
    db.prepare('UPDATE rooms SET group_id=NULL WHERE group_id=?').run(id);
    return db.prepare('DELETE FROM room_groups WHERE id=?').run(id).changes > 0;
  });
  return tx();
}

// ---------- 机房 rooms ----------
// 附带分组与模板信息，打卡页据此决定渲染哪些巡检项目
function listRooms() {
  return db.prepare(`
    SELECT r.id, r.name, r.sort, r.group_id,
      g.name AS group_name, g.template_id, t.name AS template_name
    FROM rooms r
    LEFT JOIN room_groups g ON g.id = r.group_id
    LEFT JOIN inspect_templates t ON t.id = g.template_id
    ORDER BY r.sort ASC, r.id ASC
  `).all();
}
function getRoomByName(name) {
  return db.prepare(`
    SELECT r.id, r.name, r.group_id, g.template_id
    FROM rooms r LEFT JOIN room_groups g ON g.id = r.group_id
    WHERE r.name = ? LIMIT 1
  `).get(String(name || ''));
}
function addRoom(r) {
  const info = db.prepare('INSERT INTO rooms (name, sort, group_id, created_ts) VALUES (@name, @sort, @groupId, @ts)').run({
    name: trim(r.name, 128),
    sort: Number.isFinite(+r.sort) ? +r.sort : 0,
    groupId: r.groupId == null || r.groupId === '' ? null : Number(r.groupId),
    ts: Date.now()
  });
  return info.lastInsertRowid;
}
function updateRoom(id, r) {
  const cur = db.prepare('SELECT * FROM rooms WHERE id=?').get(id);
  if (!cur) return false;
  const gid = r.groupId === undefined ? cur.group_id
    : (r.groupId == null || r.groupId === '' ? null : Number(r.groupId));
  db.prepare('UPDATE rooms SET name=@name, sort=@sort, group_id=@gid WHERE id=@id').run({
    id,
    name: r.name != null ? trim(r.name, 128) : cur.name,
    sort: r.sort != null && Number.isFinite(+r.sort) ? +r.sort : cur.sort,
    gid
  });
  return true;
}
function deleteRoom(id) {
  return db.prepare('DELETE FROM rooms WHERE id=?').run(id).changes > 0;
}

// ---------- 用户 users ----------
function getUserByUsername(u) {
  return db.prepare('SELECT * FROM users WHERE username=?').get(u);
}
function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
}
function listUsers() {
  return db.prepare('SELECT id, username, display_name, staff_id, role, must_change_pw, created_ts FROM users ORDER BY id ASC').all();
}
function createUser({ username, displayName, staffId, role, password }) {
  const info = db.prepare(`INSERT INTO users (username, display_name, staff_id, role, password_hash, must_change_pw, created_ts)
    VALUES (@username, @displayName, @staffId, @role, @pw, 1, @ts)`).run({
    username: trim(username, 64),
    displayName: trim(displayName || username, 64),
    staffId: trim(staffId || '', 64),
    role: role === 'admin' ? 'admin' : 'user',
    pw: hashPassword(password),
    ts: Date.now()
  });
  return info.lastInsertRowid;
}
// 管理员重置密码：强制下次登录改密，并废除该用户全部现有会话
function setPassword(id, password) {
  db.prepare('UPDATE users SET password_hash=?, must_change_pw=1, token_version = token_version + 1 WHERE id=?').run(hashPassword(password), id);
}
// 本人修改密码：清除改密标志，并废除全部现有会话（含本设备）
function changeOwnPassword(id, password) {
  db.prepare('UPDATE users SET password_hash=?, must_change_pw=0, token_version = token_version + 1 WHERE id=?').run(hashPassword(password), id);
}
// 让某用户的全部令牌失效（用于登出 / 强制下线）
function bumpTokenVersion(id) {
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id=?').run(id);
}
function deleteUser(id) {
  return db.prepare('DELETE FROM users WHERE id=?').run(id).changes > 0;
}
function countAdmins() {
  return db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
}

// ---------- 应用配置（键值） ----------
const wm = require('./public/js/watermark.js');   // 与前端共用同一套水印字段与校正规则

function getSetting(key, def) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return row ? row.value : def;
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO app_settings (key, value, updated_ts) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_ts=excluded.updated_ts`)
    .run(key, String(value), Date.now());
}

// 默认水印配置（管理员可改；普通用户可在此基础上自定义标题/副标题）
function getWatermark() {
  const tpl = getDefaultWmTemplate();
  return tpl ? tpl.config : wm.wmNormalize({});
}
function setWatermark(patch) {
  const tpl = getDefaultWmTemplate();
  if (!tpl) return getWatermark();
  updateWmTemplate(tpl.id, { config: Object.assign({}, tpl.config, patch || {}) });
  return getWatermark();
}

// ---------------- 水印模板 ----------------
function wmTplOut(row) {
  if (!row) return null;
  let cfg = {};
  try { cfg = JSON.parse(row.config) || {}; } catch (e) { cfg = {}; }
  return {
    id: row.id,
    name: row.name,
    config: wm.wmNormalize(cfg),
    isDefault: !!row.is_default,
    sort: row.sort || 0
  };
}
const WM_TPL_ORDER = 'ORDER BY is_default DESC, sort ASC, id ASC';

function listWmTemplates() {
  return db.prepare(`SELECT * FROM watermark_templates ${WM_TPL_ORDER}`).all().map(wmTplOut);
}
function getWmTemplate(id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return null;
  return wmTplOut(db.prepare('SELECT * FROM watermark_templates WHERE id=?').get(n));
}
function getDefaultWmTemplate() {
  const row = db.prepare(`SELECT * FROM watermark_templates ${WM_TPL_ORDER} LIMIT 1`).get();
  return wmTplOut(row);
}
function wmTplName(name, fallback) {
  return (trim(name, 24) || fallback || '未命名水印').trim();
}

function addWmTemplate(o) {
  const opts = o || {};
  const ts = Date.now();
  const isFirst = db.prepare('SELECT COUNT(*) c FROM watermark_templates').get().c === 0;
  const cfg = wm.wmNormalize(opts.config || {});
  const sort = db.prepare('SELECT COALESCE(MAX(sort),0) m FROM watermark_templates').get().m + 1;
  const wantDefault = isFirst || opts.isDefault === true;
  const tx = db.transaction(() => {
    if (wantDefault) db.prepare('UPDATE watermark_templates SET is_default=0').run();
    return db.prepare(`INSERT INTO watermark_templates (name, config, is_default, sort, created_ts, updated_ts)
      VALUES (?,?,?,?,?,?)`)
      .run(wmTplName(opts.name, cfg.title), JSON.stringify(cfg), wantDefault ? 1 : 0, sort, ts, ts)
      .lastInsertRowid;
  });
  const id = tx();
  return getWmTemplate(id);
}

function updateWmTemplate(id, patch) {
  const cur = getWmTemplate(id);
  if (!cur) return null;
  const p = patch || {};
  const name = p.name === undefined ? cur.name : wmTplName(p.name, cur.name);
  const cfg = p.config === undefined ? cur.config : wm.wmNormalize(Object.assign({}, cur.config, p.config));
  const tx = db.transaction(() => {
    if (p.isDefault === true) db.prepare('UPDATE watermark_templates SET is_default=0').run();
    db.prepare(`UPDATE watermark_templates SET name=?, config=?, is_default=?, updated_ts=? WHERE id=?`)
      .run(
        name,
        JSON.stringify(cfg),
        p.isDefault === undefined ? (cur.isDefault ? 1 : 0) : (p.isDefault ? 1 : 0),
        Date.now(),
        cur.id
      );
  });
  tx();
  return getWmTemplate(cur.id);
}

// 删除模板：至少保留一套；删掉默认模板时自动把排序第一套升为默认
function deleteWmTemplate(id) {
  const cur = getWmTemplate(id);
  if (!cur) return { ok: false, reason: 'notfound' };
  if (db.prepare('SELECT COUNT(*) c FROM watermark_templates').get().c <= 1) {
    return { ok: false, reason: 'last' };
  }
  db.prepare('DELETE FROM watermark_templates WHERE id=?').run(cur.id);
  if (cur.isDefault) {
    const first = db.prepare(`SELECT id FROM watermark_templates ${WM_TPL_ORDER} LIMIT 1`).get();
    if (first) db.prepare('UPDATE watermark_templates SET is_default=1 WHERE id=?').run(first.id);
  }
  return { ok: true, defaultId: (getDefaultWmTemplate() || {}).id || null };
}

function setDefaultWmTemplate(id) {
  const cur = getWmTemplate(id);
  if (!cur) return null;
  const tx = db.transaction(() => {
    db.prepare('UPDATE watermark_templates SET is_default=0').run();
    db.prepare('UPDATE watermark_templates SET is_default=1, updated_ts=? WHERE id=?').run(Date.now(), cur.id);
  });
  tx();
  return getWmTemplate(cur.id);
}

// 首次初始化：把旧版单套水印配置迁成第一个模板，避免升级后配置丢失
(function seedWmTemplates() {
  try {
    if (db.prepare('SELECT COUNT(*) c FROM watermark_templates').get().c > 0) return;
    let cfg = {};
    try {
      const raw = getSetting('watermark', '');
      if (raw) cfg = JSON.parse(raw) || {};
    } catch (e) { cfg = {}; }
    const normalized = wm.wmNormalize(cfg);
    db.prepare(`INSERT INTO watermark_templates (name, config, is_default, sort, created_ts, updated_ts)
      VALUES (?,?,?,?,?,?)`)
      .run('标准打卡水印', JSON.stringify(normalized), 1, 1, Date.now(), Date.now());
  } catch (e) { /* 迁移失败不影响启动 */ }
})();

// ==================== 机柜连线拓扑 ====================
// data 是编辑器 state 的 JSON 原文，服务端不解析结构、只统计数量用于列表展示。
// 单份上限 8MB：正常拓扑几百 KB，超过说明客户端异常或恶意请求。
const TOPO_MAX_CHARS = 8 * 1024 * 1024;

function topoErr(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

function topoStats(json) {
  try {
    const s = JSON.parse(json);
    let devices = 0;
    (s.racks || []).forEach((r) => { devices += (r.devices || []).length; });
    return { racks: (s.racks || []).length, devices, wires: (s.wires || []).length };
  } catch (e) {
    return { racks: 0, devices: 0, wires: 0 };
  }
}

function checkTopoData(data) {
  const json = String(data == null ? '' : data);
  if (!json) throw topoErr('EMPTY_DATA');
  if (json.length > TOPO_MAX_CHARS) throw topoErr('TOO_LARGE');
  let obj = null;
  try { obj = JSON.parse(json); } catch (e) { throw topoErr('BAD_JSON'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw topoErr('BAD_JSON');
  return json;
}

function topoOut(row, withData) {
  if (!row) return null;
  const o = {
    id: row.id,
    name: row.name,
    rev: row.rev,
    rackCount: row.rack_count,
    deviceCount: row.device_count,
    wireCount: row.wire_count,
    createdByName: row.created_by_name || '',
    updatedByName: row.updated_by_name || '',
    createdTs: row.created_ts,
    updatedTs: row.updated_ts
  };
  if (withData) o.data = row.data;
  return o;
}

function topoOwner(p) {
  const u = (p && p.user) || null;
  return {
    id: u ? u.id : null,
    name: u ? (u.displayName || u.username || '') : ''
  };
}

// 列表（不带 data，避免几十份拓扑一次拉全量）
function listTopologies() {
  return db.prepare(`SELECT id,name,rev,rack_count,device_count,wire_count,
      created_by_name,updated_by_name,created_ts,updated_ts
    FROM rack_topologies ORDER BY updated_ts DESC, id DESC`).all().map((r) => topoOut(r, false));
}

function getTopology(id) {
  return topoOut(db.prepare('SELECT * FROM rack_topologies WHERE id=?').get(Number(id) || 0), true);
}

function countTopologies() {
  return db.prepare('SELECT COUNT(*) c FROM rack_topologies').get().c;
}

function createTopology(p) {
  const data = checkTopoData(p && p.data);
  const name = trim((p && p.name) || '未命名拓扑', 64);
  const st = topoStats(data);
  const ts = Date.now();
  const who = topoOwner(p);
  const info = db.prepare(`INSERT INTO rack_topologies
      (name,data,rev,rack_count,device_count,wire_count,
       created_by,created_by_name,updated_by,updated_by_name,created_ts,updated_ts)
    VALUES (?,?,1,?,?,?,?,?,?,?,?,?)`)
    .run(name, data, st.racks, st.devices, st.wires, who.id, who.name, who.id, who.name, ts, ts);
  return getTopology(info.lastInsertRowid);
}

/**
 * 保存拓扑。
 * p.rev 为客户端拿到的版本号：不一致说明别人先存过，返回 CONFLICT 交前端决定。
 * 不传 rev 视为强制覆盖（用于「以我的为准」）。
 */
function saveTopology(id, p) {
  const rid = Number(id) || 0;
  const data = checkTopoData(p && p.data);
  const expect = (p && p.rev != null && p.rev !== '') ? Number(p.rev) : null;
  const st = topoStats(data);
  const ts = Date.now();
  const who = topoOwner(p);
  const tx = db.transaction(() => {
    const cur = db.prepare('SELECT id,name,rev,updated_by_name,updated_ts FROM rack_topologies WHERE id=?').get(rid);
    if (!cur) return { code: 'NOT_FOUND' };
    if (expect != null && expect !== cur.rev) {
      return {
        code: 'CONFLICT',
        rev: cur.rev,
        updatedByName: cur.updated_by_name || '',
        updatedTs: cur.updated_ts
      };
    }
    const name = (p && p.name) ? trim(p.name, 64) : cur.name;
    db.prepare(`UPDATE rack_topologies SET name=?, data=?, rev=rev+1,
        rack_count=?, device_count=?, wire_count=?,
        updated_by=?, updated_by_name=?, updated_ts=? WHERE id=?`)
      .run(name, data, st.racks, st.devices, st.wires, who.id, who.name, ts, rid);
    return { code: 'OK', rev: cur.rev + 1, name, updatedTs: ts };
  });
  return tx();
}

function renameTopology(id, name) {
  const rid = Number(id) || 0;
  const cur = db.prepare('SELECT id FROM rack_topologies WHERE id=?').get(rid);
  if (!cur) return null;
  db.prepare('UPDATE rack_topologies SET name=?, updated_ts=? WHERE id=?').run(trim(name || '未命名拓扑', 64), Date.now(), rid);
  return getTopology(rid);
}

function deleteTopology(id) {
  return db.prepare('DELETE FROM rack_topologies WHERE id=?').run(Number(id) || 0).changes > 0;
}

module.exports = {
  hashPassword, verifyPassword, genPassword,
  insert, insertInspections, list, allFiltered, getCheckinById, deleteCheckin, getCheckinOwner, getPhotoOwner, stats, monthSummary,
  listStaff, addStaff, updateStaff, deleteStaff,
  listTemplates, addTemplate, updateTemplate, deleteTemplate,
  addItem, updateItem, deleteItem, getTemplateItems,
  listGroups, addGroup, updateGroup, deleteGroup,
  listRooms, getRoomByName, addRoom, updateRoom, deleteRoom,
  getUserByUsername, getUserById, listUsers,
  createUser, setPassword, changeOwnPassword, deleteUser, countAdmins,
  bumpTokenVersion,
  getWatermark, setWatermark, getSetting, setSetting,
  listWmTemplates, getWmTemplate, getDefaultWmTemplate,
  addWmTemplate, updateWmTemplate, deleteWmTemplate, setDefaultWmTemplate,
  listTopologies, getTopology, countTopologies,
  createTopology, saveTopology, renameTopology, deleteTopology
};
