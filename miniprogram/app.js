'use strict';
const cfg = require('./config');

const TOKEN_KEY = 'itck_token';
const ME_KEY = 'itck_me';

App({
  globalData: {
    baseUrl: cfg.baseUrl,
    token: '',
    me: null,
    // 打卡页配置（机房 / 模板 / 分组 / 水印），登录后缓存，切页面不必重复拉取
    checkinConfig: null
  },

  onLaunch() {
    try {
      const t = wx.getStorageSync(TOKEN_KEY);
      const me = wx.getStorageSync(ME_KEY);
      if (t) this.globalData.token = t;
      if (me && typeof me === 'object') this.globalData.me = me;
    } catch (e) {
      // 存储不可用时按未登录处理
    }
  },

  setToken(token, me) {
    this.globalData.token = token || '';
    if (me) this.globalData.me = me;
    try {
      wx.setStorageSync(TOKEN_KEY, this.globalData.token);
      if (me) wx.setStorageSync(ME_KEY, me);
    } catch (e) { /* 忽略 */ }
  },

  setMe(me) {
    this.globalData.me = me || null;
    try {
      if (me) wx.setStorageSync(ME_KEY, me);
      else wx.removeStorageSync(ME_KEY);
    } catch (e) { /* 忽略 */ }
  },

  clearToken() {
    this.globalData.token = '';
    this.globalData.me = null;
    this.globalData.checkinConfig = null;
    try {
      wx.removeStorageSync(TOKEN_KEY);
      wx.removeStorageSync(ME_KEY);
    } catch (e) { /* 忽略 */ }
  },

  isAdmin() {
    const me = this.globalData.me;
    return !!(me && me.role === 'admin');
  }
});
