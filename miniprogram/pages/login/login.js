'use strict';
const api = require('../../utils/api');

Page({
  data: {
    username: '',
    password: '',
    err: '',
    loading: false
  },

  onLoad() {
    // 已登录直接跳过登录页
    const app = getApp();
    if (app.globalData.token && app.globalData.me) {
      wx.switchTab({ url: '/pages/checkin/checkin' });
    }
  },

  onUser(e) {
    this.setData({ username: e.detail.value, err: '' });
  },

  onPass(e) {
    this.setData({ password: e.detail.value, err: '' });
  },

  submit() {
    if (this.data.loading) return;
    const username = String(this.data.username || '').trim();
    const password = String(this.data.password || '');
    if (!username || !password) {
      this.setData({ err: '请输入账号和密码' });
      return;
    }

    this.setData({ loading: true, err: '' });
    api.post('/api/login', { username, password })
      .then((d) => {
        const app = getApp();
        const me = {
          id: d.id,
          username: d.username,
          displayName: d.displayName,
          staffId: d.staffId,
          role: d.role,
          mustChangePw: !!d.mustChangePw
        };
        app.setToken(d.token, me);
        if (me.mustChangePw) {
          wx.reLaunch({ url: '/pages/change-password/change-password?must=1' });
          return;
        }
        wx.switchTab({ url: '/pages/checkin/checkin' });
      })
      .catch((e) => {
        this.setData({ loading: false, err: e.message || '登录失败' });
      });
  }
});
