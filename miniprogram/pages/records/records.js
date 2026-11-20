'use strict';
const api = require('../../utils/api');
const fmt = require('../../utils/fmt');

const Z = (s) => (s === 'ok' ? '正常' : s === 'bad' ? '异常' : '');

Page({
  data: {
    q: '',
    bad: false,
    list: [],
    page: 1,
    pageSize: 20,
    total: 0,
    hasMore: false,
    loadingMore: false,
    state: 'loading',   // loading | ok | empty | error
    errMsg: '',

    trend: [],
    today: 0,
    todayBad: 0,
    month: 0
  },

  _searchTimer: null,
  _first: true,

  onShow() {
    if (!getApp().globalData.token) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.loadStats();
    // 从打卡页回来时静默刷新第一页，避免整屏 loading 闪烁
    this.load(true, !this._first);
    this._first = false;
  },

  onUnload() {
    if (this._searchTimer) clearTimeout(this._searchTimer);
  },

  /* ---------------- 列表 ---------------- */

  load(reset, silent) {
    const nextPage = reset ? 1 : (this.data.page + 1);
    if (reset) {
      if (!silent) this.setData({ state: 'loading', errMsg: '' });
    } else {
      this.setData({ loadingMore: true });
    }

    api.get('/api/checkins', {
      page: nextPage,
      pageSize: this.data.pageSize,
      q: this.data.q,
      bad: this.data.bad ? '1' : ''
    })
      .then((d) => {
        const rows = (d.list || []).map((r) => this.mapRow(r));
        const list = reset ? rows : this.data.list.concat(rows);
        const total = d.total || 0;
        this.setData({
          list,
          total,
          page: nextPage,
          hasMore: list.length < total,
          loadingMore: false,
          state: list.length ? 'ok' : 'empty'
        });
      })
      .catch((e) => {
        this.setData({
          loadingMore: false,
          state: this.data.list.length ? 'ok' : 'error',
          errMsg: (e && e.message) || '加载失败'
        });
      })
      .then(() => {
        wx.stopPullDownRefresh();
      });
  },

  mapRow(r) {
    const insp = r.inspections || [];
    let inspText = '';
    let badText = '';

    if (insp.length) {
      const parts = [];
      const bads = [];
      for (const it of insp) {
        parts.push(it.name + Z(it.status));
        if (it.status === 'bad') bads.push(it.name);
      }
      inspText = parts.join(' · ');
      badText = bads.join('、');
    } else {
      // 兼容旧版固定四列数据
      const legacy = [
        ['机房温度', r.temp_status],
        ['环境', r.env_status],
        ['网络设备', r.net_status],
        ['UPS电池', r.ups_status]
      ].filter((x) => x[1] === 'ok' || x[1] === 'bad');
      inspText = legacy.map((x) => x[0] + Z(x[1])).join(' · ');
      badText = legacy.filter((x) => x[1] === 'bad').map((x) => x[0]).join('、');
    }

    return {
      id: r.id,
      location: r.location || '未填写位置',
      timeText: fmt.fmtDateShort(r.created_ts || r.created_at),
      inspText: inspText || '无巡检项',
      badText,
      bad: !!badText,
      customText: r.custom_text || '',
      photo: r.photo || '',
      thumb: r.photo ? api.photoUrl(r.photo) : ''
    };
  },

  /* ---------------- 趋势 ---------------- */

  loadStats() {
    api.get('/api/stats')
      .then((s) => {
        this.setData({
          trend: this.mapTrend(s.trend),
          today: s.today || 0,
          todayBad: s.todayBad || 0,
          month: s.month || 0
        });
      })
      .catch(() => { /* 趋势失败不影响列表 */ });
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

  /* ---------------- 交互 ---------------- */

  onSearch(e) {
    this.setData({ q: e.detail.value });
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this.load(true, true), 360);
  },

  onSearchNow() {
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this.load(true, true);
  },

  toggleBad() {
    this.setData({ bad: !this.data.bad }, () => this.load(true, false));
  },

  reload() {
    this.load(true, false);
    this.loadStats();
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
  },

  onPullDownRefresh() {
    this.loadStats();
    this.load(true, true);
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) this.load(false, true);
  }
});
