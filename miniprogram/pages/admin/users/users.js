'use strict';
const api = require('../../../utils/api');

const ROLE_NAMES = ['普通巡检员', '管理员'];

Page({
  data: {
    state: 'loading',
    errMsg: '',
    list: [],
    credential: null,
    roleNames: ROLE_NAMES,
    saving: false,
    edit: { show: false, username: '', displayName: '', staffId: '', roleIndex: 0, password: '' }
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
    api.get('/api/users')
      .then((arr) => {
        this.setData({
          state: 'ok',
          list: (arr || []).map((u) => {
            const n = u.display_name || u.username || '?';
            return Object.assign({}, u, { initial: String(n).slice(0, 1) });
          })
        });
      })
      .catch((e) => this.setData({ state: 'error', errMsg: (e && e.message) || '加载失败' }));
  },

  dismissCred() {
    this.setData({ credential: null });
  },

  copyCred() {
    const c = this.data.credential;
    if (!c) return;
    wx.setClipboardData({
      data: c.password,
      success: () => wx.showToast({ title: '密码已复制', icon: 'success' })
    });
  },

  /* ---------------- 新建 ---------------- */

  openAdd() {
    this.setData({
      edit: { show: true, username: '', displayName: '', staffId: '', roleIndex: 0, password: '' }
    });
  },

  closeEdit() {
    this.setData({ edit: { show: false, username: '', displayName: '', staffId: '', roleIndex: 0, password: '' } });
  },

  onUsername(e) { this.setData({ 'edit.username': e.detail.value }); },
  onDisplayName(e) { this.setData({ 'edit.displayName': e.detail.value }); },
  onStaffId(e) { this.setData({ 'edit.staffId': e.detail.value }); },
  onPassword(e) { this.setData({ 'edit.password': e.detail.value }); },
  onRole(e) { this.setData({ 'edit.roleIndex': Number(e.detail.value) }); },

  save() {
    if (this.data.saving) return;
    const ed = this.data.edit;
    const username = String(ed.username || '').trim();
    if (!username) { api.toast('请填写登录账号'); return; }
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
      api.toast('账号用 3-32 位字母、数字、下划线或点');
      return;
    }
    const pw = String(ed.password || '');
    if (pw && pw.length < 6) { api.toast('初始密码至少 6 位'); return; }

    const body = {
      username,
      displayName: String(ed.displayName || '').trim() || username,
      staffId: String(ed.staffId || '').trim(),
      role: ed.roleIndex === 1 ? 'admin' : 'user'
    };
    if (pw) body.password = pw;

    this.setData({ saving: true });
    api.post('/api/users', body)
      .then((d) => {
        this.setData({ saving: false });
        this.closeEdit();
        this.load();
        this.setData({ credential: { username, password: (d && d.password) || pw } });
      })
      .catch((e) => {
        this.setData({ saving: false });
        api.toast((e && e.message) || '创建失败');
      });
  },

  /* ---------------- 重置 / 删除 ---------------- */

  resetPw(e) {
    const id = Number(e.currentTarget.dataset.id);
    const username = e.currentTarget.dataset.u || '';
    if (!id) return;
    wx.showModal({
      title: '重置密码',
      content: '将为「' + username + '」生成新的随机密码，其当前登录会立即失效。继续吗？',
      confirmText: '重置',
      success: (r) => {
        if (!r.confirm) return;
        api.post('/api/users/' + id + '/reset')
          .then((d) => {
            this.load();
            this.setData({ credential: { username, password: (d && d.password) || '' } });
          })
          .catch((err) => api.toast((err && err.message) || '重置失败'));
      }
    });
  },

  removeUser(e) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;
    wx.showModal({
      title: '删除账号',
      content: '删除后该账号无法再登录，其历史打卡记录仍会保留。确定删除吗？',
      confirmText: '删除',
      confirmColor: '#C0392B',
      success: (r) => {
        if (!r.confirm) return;
        api.del('/api/users/' + id)
          .then(() => {
            this.load();
            api.toast('已删除');
          })
          .catch((err) => api.toast((err && err.message) || '删除失败'));
      }
    });
  }
});
