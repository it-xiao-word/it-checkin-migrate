'use strict';
const api = require('../../utils/api');

// 启动分发：有登录态进打卡页，无登录态回登录页
Page({
  data: { tip: '正在进入…' },

  onLoad() {
    const app = getApp();
    if (!app.globalData.token) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    if (app.globalData.me) {
      this.enter();
      return;
    }
    // 有令牌但本地没有用户信息（换设备、清缓存），补拉一次
    this.setData({ tip: '正在校验登录状态…' });
    api.get('/api/me')
      .then((me) => {
        app.setMe(me);
        this.enter();
      })
      .catch((e) => {
        app.clearToken();
        // 401 已由网络层统一跳转，这里只需处理网络类错误
        if (!e || e.code !== 401) wx.reLaunch({ url: '/pages/login/login' });
      });
  },

  enter() {
    const me = getApp().globalData.me || {};
    if (me.mustChangePw) {
      wx.reLaunch({ url: '/pages/change-password/change-password?must=1' });
      return;
    }
    wx.switchTab({ url: '/pages/checkin/checkin' });
  }
});
