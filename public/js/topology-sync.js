'use strict';
/**
 * 机柜拓扑 · 云端同步层
 * ------------------------------------------------------------------
 * 编辑器本身（rack-topology.html 内联脚本）保持不动，它所有变更最终都调用
 * persist()；本文件只接管「云端那一半」：
 *   - 启动时拉取服务端版本并重建画面
 *   - persist() 触发的防抖自动保存（900ms 内多次改动合并成一次 PUT）
 *   - rev 乐观锁冲突处理（他人先保存时不静默覆盖）
 *   - 多份拓扑的切换 / 新建 / 删除
 * localStorage 仍在写，作为断网兜底；服务端为空时把本机草稿提升为第一份。
 *
 * 与编辑器只通过 window.TSEditor.applyState / getSnapshot 交互，
 * 其余仅复用全局函数 toast()、esc() 与 auth.js 的 apiFetch()、logout()。
 */
const TS = (function () {
  const KEY_LOCAL = 'rack_topology_v1';
  const KEY_LAST = 'itck_topo_last';
  const SAVE_DEBOUNCE = 900;
  const MAX_AUTO_RETRY = 3;
  const API = '/api/topologies';

  let me = null;
  let cur = null;        // { id, name, rev }
  let list = [];
  let pending = null;    // 待保存的 snapshot 字符串
  let timer = null;
  let busy = false;
  let failCount = 0;
  let booted = false;
  // 冲突挂起：等用户在弹层里选定「覆盖」还是「加载对方版本」，
  // 期间停止一切自动重试，否则会陷入 409 → 弹窗 → 重试的死循环。
  let conflictHold = false;

  const el = (id) => document.getElementById(id);
  const hhmm = (ts) => {
    if (!ts) return '--:--';
    const d = new Date(ts);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  };

  function setState(text, cls) {
    const node = el('saveState');
    if (!node) return;
    node.textContent = text;
    node.className = 'save-state' + (cls ? ' ' + cls : '');
  }

  function countOf(json) {
    try {
      const o = JSON.parse(json);
      let dev = 0;
      (o.racks || []).forEach((r) => { dev += (r.devices || []).length; });
      return { racks: (o.racks || []).length, devices: dev, wires: (o.wires || []).length };
    } catch (e) {
      return { racks: 0, devices: 0, wires: 0 };
    }
  }

  /* ---------------- 弹层 ---------------- */
  function showModal(opts) {
    let m = el('tsModal');
    if (!m) {
      m = document.createElement('div');
      m.id = 'tsModal';
      m.className = 'ts-modal';
      m.innerHTML = '<div class="ts-modal-box"><h4></h4><div class="ts-body"></div><div class="ts-acts"></div></div>';
      document.body.appendChild(m);
    }
    m.querySelector('h4').textContent = opts.title || '';
    const box = m.querySelector('.ts-modal-box');
    if (box) box.className = 'ts-modal-box' + (opts.wide ? ' wide' : '');
    const body = m.querySelector('.ts-body');
    if (opts.html) body.innerHTML = opts.html;
    else body.innerHTML = '<p>' + esc(opts.text || '') + '</p>';
    const acts = m.querySelector('.ts-acts');
    acts.innerHTML = '';
    (opts.acts || []).forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn' + (a.cls === 'danger' ? ' btn-danger' : (a.cls ? ' ' + a.cls : ''));
      b.textContent = a.text;
      b.onclick = () => { m.classList.remove('show'); if (a.fn) a.fn(); };
      acts.appendChild(b);
    });
    m.classList.add('show');
  }

  /* ---------------- 数据装载 ---------------- */
  // 画面重建交给编辑器自己的 applyRemoteState（经 window.TSEditor 暴露），
  // 本层只负责取数、选定当前拓扑与状态提示。
  function applyState(obj, row) {
    if (!window.TSEditor || typeof window.TSEditor.applyState !== 'function') {
      setState('编辑器未就绪', 'err');
      return false;
    }
    window.TSEditor.applyState(obj);
    if (row) setState('已保存 ' + hhmm(row.updatedTs), 'ok');
    return true;
  }

  async function open(id) {
    try {
      const r = await apiFetch(API + '/' + id);
      if (r.status === 401) { location.href = '/login.html'; return; }
      if (r.status === 404) { toast('该拓扑已被删除'); return refreshList(); }
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      const row = (await r.json()).data;
      cur = { id: row.id, name: row.name, rev: row.rev };
      try { localStorage.setItem(KEY_LAST, String(row.id)); } catch (e) { /* 忽略隐私模式限制 */ }
      let obj = null;
      try { obj = JSON.parse(row.data); } catch (e) { obj = null; }
      applyState(obj, row);
      renderList();
      pending = null;
      conflictHold = false;   // 已加载服务端最新版本，冲突解除
      failCount = 0;
    } catch (e) {
      setState('加载失败', 'err');
      toast('拓扑加载失败：' + e.message);
    }
  }

  function renderList() {
    const sel = el('topoSel');
    if (!sel) return;
    if (!list.length) {
      sel.innerHTML = '<option value="">暂无拓扑</option>';
      return;
    }
    sel.innerHTML = list.map((x) => {
      const label = x.name + ' · ' + x.rackCount + ' 柜 / ' + x.deviceCount + ' 设备';
      return '<option value="' + x.id + '">' + esc(label) + '</option>';
    }).join('');
    if (cur) sel.value = String(cur.id);
  }

  /**
   * 拉列表。服务端为空时把当前画布（可能正是本机草稿）提升为第一份拓扑。
   */
  async function refreshList(opts) {
    const initial = !!(opts && opts.initial);
    let data;
    try {
      const r = await apiFetch(API);
      if (r.status === 401) { location.href = '/login.html'; return; }
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      data = await r.json();
    } catch (e) {
      setState('列表加载失败', 'err');
      toast('无法获取拓扑列表：' + e.message);
      return;
    }
    list = (data.data && data.data.list) || [];

    if (!list.length) {
      // 只在第一轮尝试自动播种；失败就停手，避免「播种失败 → 重拉列表 → 再播种」的死循环
      if (opts && opts.seeded) {
        setState('暂无可用拓扑', 'err');
        return;
      }
      const made = await seedFirst();
      if (!made) { setState('初始化失败', 'err'); return; }
      return refreshList({ seeded: true });
    }

    renderList();
    if (initial) {
      let want = 0;
      try { want = Number(localStorage.getItem(KEY_LAST)) || 0; } catch (e) { want = 0; }
      const pick = list.find((x) => x.id === want) || list[0];
      await open(pick.id);
    } else if (!cur || !list.some((x) => x.id === cur.id)) {
      cur = null;
      await open(list[0].id);
    }
  }

  /* ---------------- 首次迁移 ---------------- */
  async function seedFirst() {
    const hasLocal = !!localStorage.getItem(KEY_LOCAL);
    const snap = (window.TSEditor && window.TSEditor.getSnapshot) ? window.TSEditor.getSnapshot() : '{}';
    let name = '第一机房';
    try { name = (JSON.parse(snap).roomName || '').trim() || name; } catch (e) { /* 用默认名 */ }
    try {
      const r = await apiFetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, data: snap })
      });
      const d = await r.json();
      if (r.status !== 200) {
        setState('初始化失败', 'err');
        toast('初始化失败：' + (d.message || ('HTTP ' + r.status)));
        return false;
      }
      cur = { id: d.data.id, name: d.data.name, rev: d.data.rev };
      try { localStorage.setItem(KEY_LAST, String(d.data.id)); } catch (e) { /* 忽略 */ }
      toast(hasLocal ? '已把本机草稿上传为云端拓扑' : '已创建初始拓扑，可直接编辑');
      return true;
    } catch (e) {
      setState('初始化失败', 'err');
      toast('初始化失败：' + e.message);
      return false;
    }
  }

  /* ---------------- 保存 ---------------- */
  function markDirty(snap) {
    pending = snap;
    if (!cur) { setState('等待云端…', 'dirty'); return; }
    setState('未保存', 'dirty');
    schedule();
  }

  function schedule() {
    if (conflictHold) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; flush(false); }, SAVE_DEBOUNCE);
  }

  async function flush(manual) {
    if (conflictHold) return;
    if (timer) { clearTimeout(timer); timer = null; }
    if (!cur) { if (manual) toast('云端尚未就绪'); return; }
    if (!pending) { if (manual && !busy) toast('已是最新'); return; }
    if (busy) { if (manual) schedule(); return; }

    const body = pending;
    pending = null;
    busy = true;
    setState('保存中…', 'saving');
    try {
      const r = await apiFetch(API + '/' + cur.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: body, rev: cur.rev })
      });
      if (r.status === 401) { location.href = '/login.html'; return; }
      const d = await r.json().catch(() => ({}));
      if (r.status === 409) { handleConflict(d, body); return; }
      if (r.status !== 200) throw new Error((d && d.message) || ('HTTP ' + r.status));

      cur.rev = d.data.rev;
      failCount = 0;
      setState('已保存 ' + hhmm(d.data.updatedTs), 'ok');
      // 顺手把列表里这份的计数刷新，避免下拉里显示旧数字
      const meta = countOf(body);
      const row = list.find((x) => x.id === cur.id);
      if (row) {
        row.rackCount = meta.racks;
        row.deviceCount = meta.devices;
        row.wireCount = meta.wires;
        row.updatedTs = d.data.updatedTs;
        row.rev = cur.rev;
        renderList();
      }
    } catch (e) {
      failCount++;
      pending = body;   // 放回待存队列，避免改动丢失
      setState(failCount >= MAX_AUTO_RETRY ? '保存失败，点击重试' : '保存失败，重试中…', 'err');
      if (manual) toast('保存失败：' + e.message);
    } finally {
      busy = false;
      // 保存期间又有新改动：继续排队；连续失败则停下，等用户点击重试
      if (pending && failCount < MAX_AUTO_RETRY) schedule();
    }
  }

  function handleConflict(d, body) {
    pending = body;
    conflictHold = true;   // 交给用户决定前不再自动保存
    setState('与他人的版本冲突', 'err');
    const info = (d && d.data) || {};
    const who = info.updatedByName ? esc(info.updatedByName) : '其他同事';
    showModal({
      title: '拓扑已被他人修改',
      html: '<p>' + who + ' 已于 ' + hhmm(info.updatedTs) + ' 保存了新版本（第 ' + (info.rev || '?') + ' 版）。</p>' +
        '<p>你手上的改动还没上传。选择一种处理方式：</p>',
      acts: [
        { text: '加载对方版本', fn: () => { pending = null; open(cur.id); } },
        { text: '用我的覆盖', cls: 'primary', fn: () => forceSave(body) }
      ]
    });
  }

  // 不带 rev 提交 = 强制覆盖（用户明确选择「以我的为准」）
  async function forceSave(body) {
    busy = true;
    conflictHold = false;
    setState('保存中…', 'saving');
    try {
      const r = await apiFetch(API + '/' + cur.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: body })
      });
      const d = await r.json().catch(() => ({}));
      if (r.status !== 200) throw new Error((d && d.message) || ('HTTP ' + r.status));
      cur.rev = d.data.rev;
      failCount = 0;
      setState('已覆盖保存 ' + hhmm(d.data.updatedTs), 'ok');
      toast('已用你的版本覆盖');
    } catch (e) {
      pending = body;
      setState('保存失败，点击重试', 'err');
      toast('保存失败：' + e.message);
    } finally {
      busy = false;
    }
  }

  /* ---------------- 多份管理 ---------------- */
  function blankTopo(name) {
    return {
      theme: document.body.classList.contains('theme-light') ? 'light' : 'dark',
      focus: 'A-01',
      roomName: name,
      roomPos: { x: 24, y: 16 },
      uOrder: 'desc',
      size: { width: 250, unitH: 17, totalU: 42 },
      zoom: 1,
      textboxes: [],
      racks: [{ id: 'A-01', name: 'A-01', totalU: 42, pos: { x: 24, y: 64 }, devices: [] }],
      wires: []
    };
  }

  /* ---- 通用：输入名称的弹层（替代浏览器 prompt） ---- */
  function askName(title, label, initial, onOk) {
    showModal({
      title: title,
      wide: false,
      html: '<p>' + esc(label) + '</p>' +
        '<input id="tsNameInput" class="ts-mgr-input" maxlength="40" ' +
        'value="' + esc(initial || '') + '" placeholder="例如：A 柜机房">' +
        '<p id="tsNameErr" style="color:#e53935;min-height:0;margin:6px 0 0"></p>',
      acts: [
        { text: '取消' },
        {
          text: '确定', cls: 'primary', fn: () => {
            const inp = el('tsNameInput');
            const name = inp ? String(inp.value).trim() : '';
            if (!name) {
              const err = el('tsNameErr');
              if (err) err.textContent = '名称不能为空';
              // 校验失败时把弹层重新打开，保留用户输入
              askName(title, label, name, onOk);
              return;
            }
            onOk(name);
          }
        }
      ]
    });
    // 自动聚焦并全选，回车=确定
    setTimeout(() => {
      const inp = el('tsNameInput');
      if (inp) { inp.focus(); inp.select(); inp.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); const ok = document.querySelector('#tsModal .ts-acts .primary'); if (ok) ok.click(); }
      }; }
    }, 30);
  }

  /* ---- 从当前画布派生一份新拓扑的数据 ---- */
  function currentSnapshotAs(name) {
    let snap = (window.TSEditor && window.TSEditor.getSnapshot) ? window.TSEditor.getSnapshot() : null;
    try {
      const o = snap ? JSON.parse(snap) : blankTopo(name);
      o.roomName = name;          // 机房名跟拓扑名保持一致
      return JSON.stringify(o);
    } catch (e) {
      return JSON.stringify(blankTopo(name));
    }
  }

  async function doCreate(name, data) {
    await flush(true);
    try {
      const r = await apiFetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, data: data })
      });
      const d = await r.json();
      if (r.status !== 200) throw new Error((d && d.message) || ('HTTP ' + r.status));
      pending = null;
      await refreshList({});
      await open(d.data.id);
      toast('已创建「' + name + '」');
    } catch (e) {
      toast('新建失败：' + e.message);
    }
  }

  function createBlank() {
    askName('新建机房拓扑', '给这份拓扑起个名字，之后可在下拉里随时切换：', '', (name) => {
      doCreate(name, JSON.stringify(blankTopo(name)));
    });
  }

  function duplicateCurrent() {
    if (!cur) { toast('云端尚未就绪'); return; }
    const row = list.find((x) => x.id === cur.id);
    const base = row ? row.name : '拓扑';
    askName('复制当前拓扑', '将当前画布完整复制为一份新拓扑（适合同型号机房快速建图）：', base + ' - 副本', (name) => {
      doCreate(name, currentSnapshotAs(name));
    });
  }

  function renameTopo() {
    if (!cur) { toast('云端尚未就绪'); return; }
    const row = list.find((x) => x.id === cur.id);
    askName('重命名拓扑', '输入新的机房名称：', row ? row.name : cur.name, async (name) => {
      await flush(true);   // 先落盘当前改动，避免改名请求与自动保存打架
      try {
        // 用 PUT 带 name 改名；data 用当前快照，rev 用最新值（open 后已同步）
        const body = { name: name, data: currentSnapshotAs(name) };
        if (cur.rev != null) body.rev = cur.rev;
        const r = await apiFetch(API + '/' + cur.id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const d = await r.json().catch(() => ({}));
        if (r.status === 409) {
          handleConflict(d, body.data);
          return;
        }
        if (r.status !== 200) throw new Error((d && d.message) || ('HTTP ' + r.status));
        cur.rev = d.data.rev;
        cur.name = name;
        if (row) row.name = name;
        renderList();
        toast('已重命名为「' + name + '」');
      } catch (e) {
        toast('重命名失败：' + e.message);
      }
    });
  }

  async function deleteById(id) {
    const row = list.find((x) => x.id === id);
    const nm = row ? row.name : ('#' + id);
    showModal({
      title: '删除拓扑',
      html: '<p>确认删除「<b>' + esc(nm) + '</b>」？</p><p>删除后所有人都看不到这份图，且无法恢复。</p>',
      acts: [
        { text: '取消' },
        {
          text: '确认删除', cls: 'danger', fn: async () => {
            try {
              const r = await apiFetch(API + '/' + id, { method: 'DELETE' });
              if (r.status !== 200) throw new Error('HTTP ' + r.status);
              if (cur && cur.id === id) { cur = null; pending = null; }
              toast('已删除「' + nm + '」');
              await refreshList({ seeded: true });
            } catch (e) {
              toast('删除失败：' + e.message);
            }
          }
        }
      ]
    });
  }

  /* ---- 机房管理总入口：列出所有拓扑并操作 ---- */
  function openManager() {
    if (!list.length) { toast('暂无拓扑，请先新建'); return; }
    const items = list.map((x) => {
      const isCur = cur && x.id === cur.id;
      return '<div class="ts-mgr-item' + (isCur ? ' cur' : '') + '">' +
        '<div class="ts-mgr-meta" data-open="' + x.id + '">' +
          '<div class="ts-mgr-name">' + esc(x.name) +
            (isCur ? '<span class="cur-tag">当前</span>' : '') + '</div>' +
          '<div class="ts-mgr-sub">' + x.rackCount + ' 机柜 · ' + x.deviceCount + ' 设备 · ' +
            x.wireCount + ' 连线 · ' + hhmm(x.updatedTs) + ' 更新</div>' +
        '</div>' +
        '<div class="ts-mgr-ops">' +
          (isCur ? '' : '<button data-act="open" data-id="' + x.id + '">切换</button>') +
          (isCur ? '<button data-act="rename">重命名</button>' : '') +
          '<button data-act="dup" data-id="' + x.id + '">复制</button>' +
          '<button class="danger" data-act="del" data-id="' + x.id + '">删除</button>' +
        '</div>' +
      '</div>';
    }).join('');

    showModal({
      title: '机房拓扑管理 · 共 ' + list.length + ' 份',
      wide: true,
      html: '<div class="ts-mgr-tip">每份拓扑对应一个机房，改动自动保存到服务器、团队共享。点击名称可切换；「复制」适合同型号机房快速建图。</div>' +
        '<div class="ts-mgr-list">' + items + '</div>',
      acts: [
        { text: '新建空白', fn: createBlank },
        { text: '复制当前', cls: 'primary', fn: duplicateCurrent }
      ]
    });

    const m = el('tsModal');
    if (!m) return;
    m.querySelectorAll('[data-open]').forEach((node) => {
      node.onclick = () => { m.classList.remove('show'); switchTo(Number(node.getAttribute('data-open'))); };
    });
    m.querySelectorAll('button[data-act]').forEach((b) => {
      b.onclick = () => {
        const id = Number(b.getAttribute('data-id'));
        const act = b.getAttribute('data-act');
        if (act === 'open') { m.classList.remove('show'); switchTo(id); }
        else if (act === 'rename') { m.classList.remove('show'); renameTopo(); }
        else if (act === 'dup') {
          m.classList.remove('show');
          const src = list.find((x) => x.id === id);
          askName('复制拓扑', '基于「' + (src ? src.name : '该拓扑') + '」复制一份新拓扑：',
            (src ? src.name : '拓扑') + ' - 副本', (name) => {
              // 从服务端取该份的完整 data 再派生，避免只复制当前画布
              apiFetch(API + '/' + id).then((r) => r.json()).then((d) => {
                doCreate(name, d && d.data ? d.data.data : currentSnapshotAs(name));
              }).catch(() => doCreate(name, currentSnapshotAs(name)));
            });
        }
        else if (act === 'del') { m.classList.remove('show'); deleteById(id); }
      };
    });
  }

  async function switchTo(id) {
    if (!id || (cur && id === cur.id)) return;
    await flush(true);          // 切换前先把当前改动写回去
    await open(id);
  }

  /* ---------------- 启动 ---------------- */
  function bindUI() {
    const sel = el('topoSel');
    if (sel) sel.onchange = (e) => switchTo(Number(e.target.value) || 0);
    const mg = el('topoMgr');
    if (mg) mg.onclick = openManager;
    const lo = el('topoLogout');
    if (lo) lo.onclick = () => { if (typeof logout === 'function') logout(); };
    const st = el('saveState');
    if (st) st.onclick = () => { if (st.classList.contains('err')) { failCount = 0; flush(true); } };

    // 待保存状态下离开页面给个提醒，避免改动静默丢失
    window.addEventListener('beforeunload', (e) => {
      if (pending || busy) { e.preventDefault(); e.returnValue = ''; return ''; }
    });
    // 切到后台/锁屏时尽量把改动送出去
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && pending && !busy) flush(false);
    });
  }

  async function boot() {
    if (booted) return;
    booted = true;
    try {
      const r = await apiFetch('/api/me');
      if (r.status !== 200) { location.href = '/login.html'; return; }
      me = (await r.json()).data || null;
    } catch (e) {
      location.href = '/login.html';
      return;
    }
    try {
      const who = el('whoami');
      if (who && me) {
        const label = me.displayName || me.username || '—';
        who.textContent = label;
        who.title = label + (me.role === 'admin' ? '（管理员）' : '（员工）');
      }
      bindUI();
      setState('连接中…', 'saving');
      await refreshList({ initial: true });
    } catch (e) {
      // 任何初始化异常都要显式暴露，不能让界面停在「连接中…」这种假状态
      setState('初始化异常', 'err');
      console.error('[拓扑] 初始化失败：', e);
    }
  }

  return { boot, flush, markDirty, open, refreshList };
})();
