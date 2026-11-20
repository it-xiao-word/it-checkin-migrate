'use strict';
/*
 * 水印模板管理
 * config 字段与水印绘制引擎（utils/wm.js）、服务端 db.wmNormalize 完全一致，
 * 这里只改配置，绘制逻辑仍由打卡页统一执行，避免两端样式漂移。
 */
const api = require('../../../utils/api');
const wm = require('../../../utils/wm');

Page({
  data: {
    state: 'loading',
    errMsg: '',
    list: [],
    colors: wm.WM_ACCENTS,
    saving: false,
    edit: { show: false, id: 0, name: '', cfg: {} }
  },

  onLoad() {
    const app = getApp();
    if (!app.globalData.token) { wx.reLaunch({ url: '/pages/login/login' }); return; }
    if (!app.isAdmin()) {
      api.toast('需要管理员权限');
      setTimeout(() => wx.navigateBack(), 900);
      return;
    }
    this.load();
  },

  load() {
    this.setData({ state: 'loading', errMsg: '' });
    api.get('/api/watermark/templates')
      .then((arr) => {
        this.setData({ state: 'ok', list: arr || [] });
      })
      .catch((e) => this.setData({ state: 'error', errMsg: (e && e.message) || '加载失败' }));
  },

  findById(id) {
    for (const t of this.data.list) if (Number(t.id) === Number(id)) return t;
    return null;
  },

  openAdd() {
    this.setData({
      edit: {
        show: true,
        id: 0,
        name: '新建水印',
        cfg: wm.wmNormalize({})
      }
    });
  },

  editTpl(e) {
    const t = this.findById(e.currentTarget.dataset.id);
    if (!t) return;
    this.setData({
      edit: { show: true, id: t.id, name: t.name, cfg: wm.wmNormalize(t.config) }
    });
  },

  closeEdit() {
    this.setData({ edit: { show: false, id: 0, name: '', cfg: {} } });
  },

  onName(e) { this.setData({ 'edit.name': e.detail.value }); },
  onTitle(e) { this.setData({ 'edit.cfg.title': e.detail.value }); },
  onOrg(e) { this.setData({ 'edit.cfg.org': e.detail.value }); },
  onColor(e) { this.setData({ 'edit.cfg.accent': e.currentTarget.dataset.c }); },

  onSwitch(e) {
    const k = e.currentTarget.dataset.k;
    const v = e.detail.value;
    const patch = {};
    patch['edit.cfg.' + k] = v;
    this.setData(patch);
  },

  save() {
    if (this.data.saving) return;
    const ed = this.data.edit;
    const name = String(ed.name || '').trim() || String(ed.cfg.title || '').trim();
    if (!name) { api.toast('请填写模板名称'); return; }

    this.setData({ saving: true });
    const body = { name, config: ed.cfg };
    const req = ed.id > 0
      ? api.put('/api/watermark/templates/' + ed.id, body)
      : api.post('/api/watermark/templates', body);

    req
      .then(() => {
        this.setData({ saving: false });
        this.closeEdit();
        this.load();
        api.toast('已保存');
      })
      .catch((e) => {
        this.setData({ saving: false });
        api.toast((e && e.message) || '保存失败');
      });
  },

  setDefault(e) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;
    api.post('/api/watermark/templates/' + id + '/default')
      .then(() => {
        this.load();
        api.toast('已设为默认');
      })
      .catch((err) => api.toast((err && err.message) || '设置失败'));
  },

  removeTpl(e) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;
    wx.showModal({
      title: '删除模板',
      content: '删除后无法恢复。若删的是默认模板，会自动把排序第一套升为默认。',
      confirmText: '删除',
      confirmColor: '#C0392B',
      success: (r) => {
        if (!r.confirm) return;
        api.del('/api/watermark/templates/' + id)
          .then(() => {
            this.load();
            api.toast('已删除');
          })
          .catch((err) => api.toast((err && err.message) || '删除失败'));
      }
    });
  }
});
