'use strict';
/*
 * 我的（个人中心）：账号信息 + 功能入口
 * 管理员多一个「管理后台」入口
 */
const api = require('../../utils/api');

Page({
  data: {
    me: {},
    initial: '?',
    isAdmin: false,
    menuGroups: []
  },

  onShow() {
    const app = getApp();
    if (!app.globalData.token) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    const me = app.globalData.me || {};
    const name = me.displayName || me.username || '';
    this.setData({
      me,
      initial: name ? name.slice(0, 1) : '?',
      isAdmin: me.role === 'admin',
      menuGroups: this.buildMenu(me.role === 'admin')
    });
    // 后台可能改了资料，静默对齐一次
    api.get('/api/me')
      .then((fresh) => {
        app.setMe(fresh);
        const n = fresh.displayName || fresh.username || '';
        this.setData({
          me: fresh,
          initial: n ? n.slice(0, 1) : '?',
          isAdmin: fresh.role === 'admin',
          menuGroups: this.buildMenu(fresh.role === 'admin')
        });
      })
      .catch(() => { /* 网络异常时沿用本地缓存 */ });
  },

  buildMenu(isAdmin) {
    const groups = [
      {
        key: 'work',
        title: '巡检',
        items: [
          { key: 'checkin', text: '现场打卡', desc: '拍照 + 定位 + 巡检项', path: 'checkin' },
          { key: 'records', text: '我的记录', desc: '历史打卡与异常情况', path: 'records' }
        ]
      },
      {
        key: 'account',
        title: '账号',
        items: [
          { key: 'pw', text: '修改密码', desc: '修改后需重新登录', path: 'pw' }
        ]
      }
    ];
    if (isAdmin) {
      groups.splice(1, 0, {
        key: 'admin',
        title: '管理',
        items: [
          { key: 'adm-home', text: '管理后台', desc: '全站统计与数据管理', path: 'admin' }
        ]
      });
    }
    return groups;
  },

  onMenu(e) {
    const path = e.currentTarget.dataset.path;
    if (path === 'checkin') { wx.switchTab({ url: '/pages/checkin/checkin' }); return; }
    if (path === 'records') { wx.switchTab({ url: '/pages/records/records' }); return; }
    if (path === 'pw') { wx.navigateTo({ url: '/pages/change-password/change-password' }); return; }
    if (path === 'admin') { wx.navigateTo({ url: '/pages/admin/home/home' }); return; }
    api.toast('该功能暂未开放');
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新输入账号密码，确定吗？',
      confirmText: '退出',
      confirmColor: '#C0392B',
      success: (r) => {
        if (!r.confirm) return;
        // 服务端会作废该账号全部令牌，失败也要清本地态
        api.post('/api/logout').catch(() => {}).then(() => {
          getApp().clearToken();
          wx.reLaunch({ url: '/pages/login/login' });
        });
      }
    });
  }
});
