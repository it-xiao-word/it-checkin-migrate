/* ============================================================================
 * IT 机房打卡服务 · 静态演示 Mock API
 * 在 GitHub Pages 上运行，无后端。通过劫持 window.fetch 模拟全部 /api 接口。
 * 数据存于 demo_seed.json（内存态），新打卡/改密等操作写入 localStorage。
 * ========================================================================== */
(function () {
  'use strict';
  var SEED = null;
  var LS_KEY = 'itck_demo_state_v1';
  var state = null;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // 从 localStorage 恢复可变状态，否则用种子
  function loadState() {
    if (SEED) state = clone(SEED);
    else state = {};
    try {
      var saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        if (saved.records) state.records = saved.records;
        if (saved.users) state.users = saved.users;
        if (saved.topologies) state.topologies = saved.topologies;
        if (saved.watermarks) state.watermarks = saved.watermarks;
        if (saved.rooms) state.rooms = saved.rooms;
        if (saved.templates) state.templates = saved.templates;
        if (saved.groups) state.groups = saved.groups;
        if (saved.watermark) state.watermark = saved.watermark;
      }
    } catch (e) {}
    // 演示登录态：默认普通用户；可在首页切换为 admin
    var role = 'user';
    try { role = localStorage.getItem('itck_demo_role') || 'user'; } catch (e) {}
    var me = (state.users || []).filter(function (u) { return u.role === role; })[0] ||
             { id: 99, username: 'demo', display_name: '演示用户', staff_id: 'DEMO-1', role: 'user' };
    state._me = { id: me.id, username: me.username, role: me.role,
      displayName: me.display_name, staffId: me.staff_id, mustChangePw: false };
    return state;
  }

  function saveState() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        records: state.records, users: state.users, topologies: state.topologies,
        watermarks: state.watermarks, rooms: state.rooms, templates: state.templates,
        groups: state.groups, watermark: state.watermark
      }));
    } catch (e) {}
  }

  // 轻量 Response 兜底（jsdom 等无原生 Response 的环境）
  function makeResponse(body, status, headers) {
    if (typeof Response === 'function') {
      return new Response(body, { status: status, headers: headers });
    }
    return {
      status: status, ok: status >= 200 && status < 300,
      _body: String(body),
      headers: { get: function (k) { return headers[k] || headers[k.toLowerCase()] || null; } },
      json: function () { return Promise.resolve(JSON.parse(String(body))); },
      text: function () { return Promise.resolve(String(body)); },
      blob: function () { return Promise.resolve(new Blob([body])); },
      arrayBuffer: function () { return Promise.resolve(new Uint8Array(0)); }
    };
  }
  function json(data, status) {
    status = status || 200;
    return makeResponse(JSON.stringify(data), status, { 'Content-Type': 'application/json; charset=utf-8' });
  }
  function ok(data) { return json({ code: 0, message: 'ok', data: data }); }
  function err(code, msg, status) { return json({ code: code, message: msg }, status || 400); }

  function parseBody(opts) {
    if (!opts || !opts.body) return {};
    try {
      if (opts.body instanceof FormData) {
        var o = {};
        opts.body.forEach(function (v, k) { if (typeof v === 'string') o[k] = v; });
        return o;
      }
      return JSON.parse(opts.body);
    } catch (e) { return {}; }
  }

  function recomputeStats() {
    var recs = state.records || [];
    var now = Date.now();
    var today = new Date(now).toISOString().slice(0, 10);
    var trend = [];
    for (var d = 6; d >= 0; d--) {
      var dt = new Date(now - d * 86400000).toISOString().slice(0, 10);
      var day = recs.filter(function (r) { return (r.created_at || '').slice(0, 10) === dt; });
      trend.push({ date: dt, total: day.length,
        bad: day.filter(function (r) { return r.env_status === 'bad' || r.temp_status === 'bad' ||
          r.net_status === 'bad' || r.ups_status === 'bad'; }).length });
    }
    state.stats = {
      today: recs.filter(function (r) { return (r.created_at || '').slice(0, 10) === today; }).length,
      todayBad: 0, month: recs.length,
      monthBad: recs.filter(function (r) { return r.env_status === 'bad'; }).length,
      lastToday: 3, lastMonth: 18, trend: trend
    };
  }

  function match(path, re) { var m = path.match(re); return m ? m : null; }

  function handleGet(path, url) {
    var me = state._me;
    if (path === '/api/me') return ok(me);
    if (path === '/api/stats') { recomputeStats(); return ok(state.stats); }
    if (path === '/api/checkin-config') return ok({
      rooms: state.rooms || [], templates: state.templates || [], groups: state.groups || [],
      watermark: state.watermark || {}, watermarks: state.watermarks || []
    });
    if (path.indexOf('/api/rooms') === 0) return ok(state.rooms || []);
    if (path.indexOf('/api/room-groups') === 0) return ok(state.groups || []);
    if (path.indexOf('/api/inspect/templates') === 0) return ok(state.templates || []);
    if (path === '/api/watermark') return ok(state.watermark || {});
    if (path === '/api/watermark/templates') return ok(state.watermarks || []);
    if (path.indexOf('/api/inspect/items/') === 0) {
      var tid = Number(path.split('/').pop());
      var tpl = (state.templates || []).filter(function (t) { return t.id === tid; })[0];
      return ok(tpl ? tpl.items || [] : []);
    }
    if (path.indexOf('/api/checkins/') === 0 && path === '/api/checkins/latest') return ok(null);
    if (path === '/api/checkins' || path.indexOf('/api/checkins?') === 0) {
      var page = Number(url.searchParams.get('page') || 1);
      var pageSize = Number(url.searchParams.get('pageSize') || 20);
      var q = (url.searchParams.get('q') || '').toLowerCase();
      var list = (state.records || []).slice();
      if (q) list = list.filter(function (r) {
        return [r.name, r.location, r.note, r.staff_id].join(' ').toLowerCase().indexOf(q) >= 0;
      });
      list.sort(function (a, b) { return (b.created_ts || 0) - (a.created_ts || 0); });
      return ok({ list: list.slice((page - 1) * pageSize, page * pageSize), total: list.length,
        page: page, pageSize: pageSize });
    }
    if (path.indexOf('/api/checkins/') === 0) {
      var id = Number(path.split('/').pop());
      var rec = (state.records || []).filter(function (r) { return r.id === id; })[0];
      return rec ? ok(rec) : err(4042, '记录不存在', 404);
    }
    if (path.indexOf('/api/photo/') === 0) {
      // 演示模式无真实照片，返回 1x1 透明 PNG
      return makeResponse(new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137,0,0,0,13,73,68,65,84,8,215,99,248,207,192,240,31,0,5,0,1,255,153,61,29,209,0,0,0,0,73,69,78,68,174,66,96,130]),
        200, { 'Content-Type': 'image/png' });
    }
    if (path === '/api/users') return ok(state.users || []);
    if (path === '/api/topologies') return ok(state.topologies || []);
    return err(4040, '演示模式：未模拟的 GET ' + path, 404);
  }

  function handlePost(path, body, opts) {
    var me = state._me;
    if (path === '/api/login') {
      var u = (state.users || []).filter(function (x) {
        return x.username === (body.username || '') || x.display_name === (body.username || '');
      })[0] || { id: 99, username: 'demo', display_name: '演示用户', staff_id: 'DEMO-1', role: 'user' };
      state._me = { id: u.id, username: u.username, role: u.role,
        displayName: u.display_name, staffId: u.staff_id || '', mustChangePw: false };
      // 让后续 /api/me 记住本次登录角色
      try { localStorage.setItem('itck_demo_role', u.role); } catch (e) {}
      var resp = ok(state._me);
      // 附带 token 以兼容旧脚本
      return resp;
    }
    if (path === '/api/logout') return ok({});
    if (path === '/api/change-password') return ok({});
    if (path === '/api/checkin') {
      var rec = {
        id: Date.now(), name: me.displayName || '演示用户', staff_id: me.staffId || '',
        lat: body.lat ? Number(body.lat) : 30.2741, lng: body.lng ? Number(body.lng) : 120.1551,
        accuracy: 12, location: body.location || body.room || '核心机房A区',
        note: body.note || '', photo: '', created_at: new Date().toISOString(), created_ts: Date.now(),
        user_id: me.id, temp_status: 'ok', env_status: 'ok', net_status: 'ok', ups_status: 'ok',
        custom_text: body.customText || '', wm_template: null,
        photo_bytes: 198000, photo_raw_bytes: 2640000, inspections: []
      };
      state.records = state.records || [];
      state.records.unshift(rec);
      saveState();
      return ok(rec);
    }
    if (path === '/api/rooms') { var nr = { id: Date.now(), name: body.name || '新机房', sort: 99, created_ts: Date.now() }; state.rooms.push(nr); saveState(); return ok(nr); }
    if (path === '/api/room-groups') { var ng = { id: Date.now(), name: body.name || '新分组', sort: 99 }; state.groups.push(ng); saveState(); return ok(ng); }
    if (path === '/api/inspect/templates') { var nt = { id: Date.now(), name: body.name || '新模板', description: body.description || '', sort: 99, items: [] }; state.templates.push(nt); saveState(); return ok(nt); }
    if (path === '/api/watermark/templates') { var nw = { id: Date.now(), name: body.name || '新水印', config: body.config || {}, isDefault: false, sort: 99 }; state.watermarks.push(nw); saveState(); return ok(nw); }
    if (path === '/api/users') { var nu = { id: Date.now(), username: body.username || 'newuser', display_name: body.displayName || '新用户', staff_id: body.staffId || '', role: body.role || 'user', must_change_pw: 0 }; state.users.push(nu); saveState(); return ok(nu); }
    if (path === '/api/users/reset-all') return ok([]);
    if (path === '/api/topologies') {
      var ntp = { id: Date.now(), name: body.name || '未命名拓扑', data: body.data || {}, updated_ts: Date.now() };
      state.topologies = state.topologies || []; state.topologies.push(ntp); saveState(); return ok(ntp);
    }
    // 导出接口：返回可下载的演示文本
    if (path.indexOf('/api/export') === 0 || path.indexOf('/api/export-summary') === 0) {
      var csv = '时间,姓名,机房,备注\n' + (state.records || []).slice(0, 20).map(function (r) {
        return [r.created_at, r.name, r.location, r.note || ''].join(',');
      }).join('\n');
      return makeResponse('\ufeff' + csv, 200, { 'Content-Type': 'text/csv; charset=utf-8' });
    }
    return err(4040, '演示模式：未模拟的 POST ' + path, 404);
  }

  function handlePut(path, body) {
    var m;
    if ((m = match(path, /^\/api\/topologies\/(\d+)$/))) {
      var t = (state.topologies || []).filter(function (x) { return x.id === Number(m[1]); })[0];
      if (t) { t.data = body.data || t.data; t.name = body.name || t.name; t.updated_ts = Date.now(); saveState(); return ok(t); }
      return err(4042, '拓扑不存在', 404);
    }
    if ((m = match(path, /^\/api\/users\/(\d+)$/))) {
      var u = (state.users || []).filter(function (x) { return x.id === Number(m[1]); })[0];
      if (u) { Object.assign(u, body); saveState(); return ok(u); }
      return err(4041, '用户不存在', 404);
    }
    if (path === '/api/watermark') { state.watermark = Object.assign({}, state.watermark, body); saveState(); return ok(state.watermark); }
    return err(4040, '演示模式：未模拟的 PUT ' + path, 404);
  }

  function handleDelete(path) {
    var m;
    if ((m = match(path, /^\/api\/checkins\/(\d+)$/))) {
      var id = Number(m[1]);
      state.records = (state.records || []).filter(function (r) { return r.id !== id; });
      saveState(); return ok({});
    }
    if ((m = match(path, /^\/api\/topologies\/(\d+)$/))) {
      state.topologies = (state.topologies || []).filter(function (t) { return t.id !== Number(m[1]); });
      saveState(); return ok({});
    }
    if ((m = match(path, /^\/api\/users\/(\d+)$/))) {
      state.users = (state.users || []).filter(function (u) { return u.id !== Number(m[1]); });
      saveState(); return ok({});
    }
    return err(4040, '演示模式：未模拟的 DELETE ' + path, 404);
  }

  // 种子就绪 Promise：所有 API 调用都等待它完成，避免页面脚本抢先调用时 state 为空
  // 用 XHR 加载，避免依赖原生 fetch（部分环境无 fetch）
  var seedReady = new Promise(function (resolve) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', './demo_seed.json', true);
    xhr.onload = function () {
      try { SEED = JSON.parse(xhr.responseText); } catch (e) { SEED = {}; }
      loadState();
      if (window.__ITCK_DEMO__) window.__ITCK_DEMO__.ready = true;
      document.dispatchEvent(new CustomEvent('itck-demo-ready'));
      resolve();
    };
    xhr.onerror = function () { loadState(); resolve(); };
    xhr.send();
  });

  // 劫持 fetch
  var realFetch = (typeof window.fetch === 'function') ? window.fetch.bind(window) : function () {
    return Promise.reject(new Error('fetch unavailable'));
  };
  window.fetch = function (input, opts) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    var u;
    try { u = new URL(url, location.href); } catch (e) { return realFetch(input, opts); }
    // 种子文件自身交给原生 fetch
    if (String(url).indexOf('demo_seed.json') >= 0) return realFetch(input, opts);
    // 拦截所有含 /api/ 的路径（覆盖 /api/、/demo/api/、/it-checkin-migrate/demo/api/ 等）
    var isApi = u.pathname.indexOf('/api/') >= 0;
    if (!isApi) return realFetch(input, opts);
    // 取 /api/ 之后的部分，标准化为 /api/xxx
    var path = '/api/' + u.pathname.split('/api/').pop();
    opts = opts || {};
    var method = (opts.method || 'GET').toUpperCase();
    var body = parseBody(opts);
    return seedReady.then(function () {
      var resp;
      try {
        if (method === 'GET') resp = handleGet(path, u);
        else if (method === 'POST') resp = handlePost(path, body, opts);
        else if (method === 'PUT') resp = handlePut(path, body);
        else if (method === 'DELETE') resp = handleDelete(path);
        else resp = err(4050, '演示模式：不支持的方法 ' + method, 405);
      } catch (e) {
        resp = err(5000, '演示模式异常：' + e.message, 500);
      }
      return resp;
    });
  };

  window.__ITCK_DEMO__ = { ready: false, reset: function () { localStorage.removeItem(LS_KEY); location.reload(); } };
})();
