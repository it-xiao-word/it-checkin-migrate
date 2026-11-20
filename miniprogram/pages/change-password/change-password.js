'use strict';
const api = require('../../utils/api');

Page({
  data: {
    must: false,
    oldPassword: '',
    newPassword: '',
    confirm: '',
    err: '',
    loading: false
  },

  onLoad(q) {
    const must = String((q && q.must) || '') === '1';
    this.setData({ must });
    if (!must) wx.setNavigationBarTitle({ title: '修改密码' });
  },

  onOld(e) { this.setData({ oldPassword: e.detail.value, err: '' }); },
  onNew(e) { this.setData({ newPassword: e.detail.value, err: '' }); },
  onConfirm(e) { this.setData({ confirm: e.detail.value, err: '' }); },

  submit() {
    if (this.data.loading) return;
    const oldPassword = String(this.data.oldPassword || '');
    const newPassword = String(this.data.newPassword || '');
    const confirm = String(this.data.confirm || '');

    if (!oldPassword) { this.setData({ err: '请输入原密码' }); return; }
    if (newPassword.length < 6) { this.setData({ err: '新密码至少 6 位' }); return; }
    if (newPassword !== confirm) { this.setData({ err: '两次输入的新密码不一致' }); return; }
    if (newPassword === oldPassword) { this.setData({ err: '新密码不能与原密码相同' }); return; }

    this.setData({ loading: true, err: '' });
    api.post('/api/change-password', { oldPassword, newPassword })
      .then((d) => {
        const app = getApp();
        const me = Object.assign({}, app.globalData.me || {}, { mustChangePw: false });
        // 改密会作废全部旧令牌，必须换成服务端刚下发的新令牌
        app.setToken(d && d.token ? d.token : app.globalData.token, me);
        wx.showToast({ title: '密码已更新', icon: 'success', duration: 1200 });
        setTimeout(() => {
          wx.switchTab({ url: '/pages/checkin/checkin' });
        }, 600);
      })
      .catch((e) => {
        this.setData({ loading: false, err: (e && e.message) || '修改失败' });
      });
  }
});
