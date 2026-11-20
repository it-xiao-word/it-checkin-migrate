'use strict';
/*
 * 巡检配置：机房 / 分组 / 模板（含巡检项）/ 人员
 * 四类配置同一个页面用分段切换，编辑统一走底部弹层。
 */
const api = require('../../../utils/api');

const META = {
  rooms: {
    add: '新增机房',
    hint: '打卡页只能选择这里配置过的机房。机房归入分组后，会自动使用该分组的巡检模板。'
  },
  groups: {
    add: '新增分组',
    hint: '分组让多个机房共用一套巡检模板。顺序：先建模板 → 建分组并绑定模板 → 把机房放进分组。'
  },
  templates: {
    add: '新增模板',
    hint: '模板是一组巡检项目。机房通过分组关联模板，打卡时会逐项要求选择正常 / 不正常。'
  },
  staff: {
    add: '新增人员',
    hint: '人员列表用于管理端按人筛选记录。'
  }
};

const EMPTY_EDIT = { show: false, type: '', id: 0, title: '', name: '', desc: '', staffId: '' };

Page({
  data: {
    tab: 'rooms',
    state: 'loading',
    errMsg: '',

    rooms: [],
    groups: [],
    templates: [],
    staff: [],

    groupNames: ['未分组'],
    templateNames: ['不使用模板'],

    newItemName: '',
    addText: META.rooms.add,
    hint: META.rooms.hint,

    saving: false,
    edit: Object.assign({}, EMPTY_EDIT),
    editGroupIndex: 0,
    editTemplateIndex: 0
  },

  onLoad() {
    const app = getApp();
    if (!app.globalData.token) { wx.reLaunch({ url: '/pages/login/login' }); return; }
    if (!app.isAdmin()) {
      api.toast('需要管理员权限');
      setTimeout(() => wx.navigateBack(), 900);
      return;
    }
    this.loadAll();
  },

  /* ---------------- 加载 ---------------- */

  loadAll() {
    this.setData({ state: 'loading', errMsg: '' });
    Promise.all([
      api.get('/api/rooms'),
      api.get('/api/room-groups'),
      api.get('/api/inspect/templates'),
      api.get('/api/staff')
    ])
      .then((res) => {
        const rooms = res[0] || [];
        const groups = res[1] || [];
        const templates = res[2] || [];
        const staff = res[3] || [];
        this.setData({
          state: 'ok',
          rooms: rooms.map((r) => ({
            id: r.id,
            name: r.name,
            group_id: r.group_id,
            sub: (r.group_name || '未分组') + ' · ' + (r.template_name || '无巡检模板')
          })),
          groups: groups.map((g) => ({
            id: g.id,
            name: g.name,
            template_id: g.template_id,
            sub: '模板：' + (g.template_name || '未设置') + ' · ' + (g.room_count || 0) + ' 个机房'
          })),
          templates: templates.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description || '',
            sub: ((t.items || []).length) + ' 个巡检项',
            items: t.items || []
          })),
          staff: staff.map((s) => ({
            id: s.id,
            name: s.name,
            staff_id: s.staff_id || '',
            sub: s.staff_id ? ('工号 ' + s.staff_id) : '未填工号'
          })),
          groupNames: ['未分组'].concat(groups.map((g) => g.name)),
          templateNames: ['不使用模板'].concat(templates.map((t) => t.name))
        });
      })
      .catch((e) => this.setData({ state: 'error', errMsg: (e && e.message) || '加载失败' }));
  },

  onTab(e) {
    const t = e.currentTarget.dataset.t;
    const m = META[t] || META.rooms;
    this.setData({ tab: t, addText: m.add, hint: m.hint });
  },

  /* ---------------- 弹层 ---------------- */

  openAdd() {
    const t = this.data.tab;
    const titles = { rooms: '新增机房', groups: '新增分组', templates: '新增模板', staff: '新增人员' };
    const typeMap = { rooms: 'room', groups: 'group', templates: 'template', staff: 'staff' };
    this.setData({
      edit: Object.assign({}, EMPTY_EDIT, { show: true, type: typeMap[t], title: titles[t] }),
      editGroupIndex: 0,
      editTemplateIndex: 0
    });
  },

  closeEdit() {
    this.setData({ edit: Object.assign({}, EMPTY_EDIT) });
  },

  findById(list, id) {
    for (const x of list) if (Number(x.id) === Number(id)) return x;
    return null;
  },

  editRoom(e) {
    const r = this.findById(this.data.rooms, e.currentTarget.dataset.id);
    if (!r) return;
    let gi = 0;
    if (r.group_id) {
      const idx = this.data.groups.findIndex((g) => Number(g.id) === Number(r.group_id));
      if (idx >= 0) gi = idx + 1;
    }
    this.setData({
      edit: { show: true, type: 'room', id: r.id, title: '编辑机房', name: r.name, desc: '', staffId: '' },
      editGroupIndex: gi
    });
  },

  editGroup(e) {
    const g = this.findById(this.data.groups, e.currentTarget.dataset.id);
    if (!g) return;
    let ti = 0;
    if (g.template_id) {
      const idx = this.data.templates.findIndex((t) => Number(t.id) === Number(g.template_id));
      if (idx >= 0) ti = idx + 1;
    }
    this.setData({
      edit: { show: true, type: 'group', id: g.id, title: '编辑分组', name: g.name, desc: '', staffId: '' },
      editTemplateIndex: ti
    });
  },

  editTemplate(e) {
    const t = this.findById(this.data.templates, e.currentTarget.dataset.id);
    if (!t) return;
    this.setData({
      edit: { show: true, type: 'template', id: t.id, title: '编辑模板', name: t.name, desc: t.description, staffId: '' }
    });
  },

  editStaff(e) {
    const s = this.findById(this.data.staff, e.currentTarget.dataset.id);
    if (!s) return;
    this.setData({
      edit: { show: true, type: 'staff', id: s.id, title: '编辑人员', name: s.name, desc: '', staffId: s.staff_id }
    });
  },

  onEditName(e) { this.setData({ 'edit.name': e.detail.value }); },
  onEditDesc(e) { this.setData({ 'edit.desc': e.detail.value }); },
  onEditStaffId(e) { this.setData({ 'edit.staffId': e.detail.value }); },
  onEditGroup(e) { this.setData({ editGroupIndex: Number(e.detail.value) }); },
  onEditTemplate(e) { this.setData({ editTemplateIndex: Number(e.detail.value) }); },

  /* ---------------- 保存 / 删除 ---------------- */

  saveEdit() {
    if (this.data.saving) return;
    const ed = this.data.edit;
    const name = String(ed.name || '').trim();
    if (!name) { api.toast('名称不能为空'); return; }

    let req = null;
    if (ed.type === 'room') {
      const gid = this.data.editGroupIndex > 0
        ? this.data.groups[this.data.editGroupIndex - 1].id : null;
      req = ed.id > 0
        ? api.put('/api/rooms/' + ed.id, { name, groupId: gid })
        : api.post('/api/rooms', { name, groupId: gid });
    } else if (ed.type === 'group') {
      const tid = this.data.editTemplateIndex > 0
        ? this.data.templates[this.data.editTemplateIndex - 1].id : null;
      req = ed.id > 0
        ? api.put('/api/room-groups/' + ed.id, { name, templateId: tid })
        : api.post('/api/room-groups', { name, templateId: tid });
    } else if (ed.type === 'template') {
      req = ed.id > 0
        ? api.put('/api/inspect/templates/' + ed.id, { name, description: String(ed.desc || '').trim() })
        : api.post('/api/inspect/templates', { name, description: String(ed.desc || '').trim() });
    } else if (ed.type === 'staff') {
      req = ed.id > 0
        ? api.put('/api/staff/' + ed.id, { name, staffId: String(ed.staffId || '').trim() })
        : api.post('/api/staff', { name, staffId: String(ed.staffId || '').trim() });
    }

    if (!req) return;
    this.setData({ saving: true });
    req
      .then(() => {
        this.setData({ saving: false });
        this.closeEdit();
        this.loadAll();
        api.toast('已保存');
      })
      .catch((e) => {
        this.setData({ saving: false });
        api.toast((e && e.message) || '保存失败');
      });
  },

  removeEdit() {
    const ed = this.data.edit;
    if (!ed.id) return;
    const urls = {
      room: '/api/rooms/',
      group: '/api/room-groups/',
      template: '/api/inspect/templates/',
      staff: '/api/staff/'
    };
    const tips = {
      room: '删除机房后，历史打卡记录仍保留，但打卡页不再显示该机房。',
      group: '删除分组后，组内机房变为未分组，将没有巡检项目。',
      template: '删除模板会同时删除其下所有巡检项目，关联分组将失去模板。',
      staff: '删除人员只影响管理端筛选列表，不影响历史记录。'
    };
    wx.showModal({
      title: '确认删除',
      content: tips[ed.type] || '删除后无法恢复，确定吗？',
      confirmText: '删除',
      confirmColor: '#C0392B',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ saving: true });
        api.del(urls[ed.type] + ed.id)
          .then(() => {
            this.setData({ saving: false });
            this.closeEdit();
            this.loadAll();
            api.toast('已删除');
          })
          .catch((e) => {
            this.setData({ saving: false });
            api.toast((e && e.message) || '删除失败');
          });
      }
    });
  },

  /* ---------------- 巡检项 ---------------- */

  onNewItemName(e) {
    this.setData({ newItemName: e.detail.value });
  },

  onFocusTpl(e) {
    this._tplId = Number(e.currentTarget.dataset.tid);
  },

  addItem(e) {
    const tid = Number(e.currentTarget.dataset.tid) || this._tplId;
    const name = String(this.data.newItemName || '').trim();
    if (!tid) { api.toast('模板未识别，请重新进入页面'); return; }
    if (!name) { api.toast('请输入巡检项目名称'); return; }
    api.post('/api/inspect/templates/' + tid + '/items', { name })
      .then(() => {
        this.setData({ newItemName: '' });
        this.loadAll();
        api.toast('已添加');
      })
      .catch((err) => api.toast((err && err.message) || '添加失败'));
  },

  delItem(e) {
    const iid = Number(e.currentTarget.dataset.iid);
    if (!iid) return;
    wx.showModal({
      title: '删除巡检项',
      content: '删除后历史记录中的该项仍保留，但新打卡不再出现。确定删除吗？',
      confirmText: '删除',
      confirmColor: '#C0392B',
      success: (r) => {
        if (!r.confirm) return;
        api.del('/api/inspect/items/' + iid)
          .then(() => this.loadAll())
          .catch((err) => api.toast((err && err.message) || '删除失败'));
      }
    });
  }
});
