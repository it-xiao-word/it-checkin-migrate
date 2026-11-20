'use strict';
const api = require('../../../utils/api');
const fmt = require('../../../utils/fmt');

Page({
  data: {
    stats: { today: 0, todayBad: 0, month: 0, monthBad: 0 },
    trend: [],
    lastText: '-',
    menu: [
      { key: 'records', icon: '记', text: '打卡记录', desc: '筛选 · 导出 · 删除', path: 'records' },
      { key: 'config', icon: '配', text: '巡检配置', desc: '机房 / 分组 / 模板 / 人员', path: 'config' },
      { key: 'watermark', icon: '水', text: '水印模板', desc: '样式与字段开关', path: 'watermark' },
      { key: 'users', icon: '号', text: '账号管理', desc: '新建 · 重置密码', path: 'users' }
    ]
  },

  onShow() {
    const app = getApp();
    if (!app.globalData.token) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    if (!app.isAdmin()) {
      api.toast('需要管理员权限');
      setTimeout(() => wx.navigateBack(), 900);
      return;
    }
    this.loadStats();
  },

  loadStats() {
    api.get('/api/stats')
      .then((s) => {
        this.setData({
          stats: {
            today: s.today || 0,
            todayBad: s.todayBad || 0,
            month: s.month || 0,
            monthBad: s.monthBad || 0
          },
          trend: this.mapTrend(s.trend),
          lastText: s.lastToday ? fmt.fmtRel(s.lastToday) : '暂无'
        });
      })
      .catch((e) => api.toast((e && e.message) || '统计加载失败'));
  },

  mapTrend(trend) {
    const arr = trend || [];
    let max = 1;
    for (const d of arr) if (d.total > max) max = d.total;
    const todayKey = fmt.dayKey(new Date());
    return arr.map((d) => ({
      date: d.date,
      total: d.total || 0,
      bad: d.bad || 0,
      h: Math.round(((d.total || 0) / max) * 100),
      badH: d.total > 0 ? Math.round(((d.bad || 0) / d.total) * 100) : 0,
      label: d.date === todayKey ? '今天' : String(d.date).slice(5),
      isToday: d.date === todayKey
    }));
  },

  onTile(e) {
    const p = e.currentTarget.dataset.path;
    if (p === 'records') { this.goRecords(); return; }
    const map = {
      config: '/pages/admin/config/config',
      watermark: '/pages/admin/watermark/watermark',
      users: '/pages/admin/users/users'
    };
    if (map[p]) wx.navigateTo({ url: map[p] });
  },

  goRecords() {
    wx.navigateTo({ url: '/pages/admin/records/records' });
  }
});
