'use strict';
const api = require('../../../utils/api');
const fmt = require('../../../utils/fmt');

const Z = (s) => (s === 'ok' ? '正常' : s === 'bad' ? '异常' : '');

Page({
  data: {
    q: '',
    from: '',
    to: '',
    bad: false,
    staffNames: ['全部人员'],
    staffIndex: 0,

    list: [],
    total: 0,
    page: 1,
    pageSize: 20,
    hasMore: false,
    loadingMore: false,
    state: 'loading',
    errMsg: '',
    exporting: false
  },

  _searchTimer: null,
  _first: true,

  onShow() {
    const app = getApp();
    if (!app.globalData.token) { wx.reLaunch({ url: '/pages/login/login' }); return; }
    if (!app.isAdmin()) {
      api.toast('需要管理员权限');
      setTimeout(() => wx.navigateBack(), 900);
      return;
    }
    if (this._first) this.loadStaff();
    this.load(true, !this._first);
    this._first = false;
  },

  onUnload() {
    if (this._searchTimer) clearTimeout(this._searchTimer);
  },

  loadStaff() {
    api.get('/api/staff')
      .then((arr) => {
        const names = ['全部人员'].concat((arr || []).map((s) => s.name));
        this.setData({ staffNames: names });
      })
      .catch(() => { /* 人员筛选不可用不影响主流程 */ });
  },

  /* ---------------- 筛选 ---------------- */

  onSearch(e) {
    this.setData({ q: e.detail.value });
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this.load(true, true), 360);
  },

  searchNow() {
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this.load(true, true);
  },

  onFrom(e) { this.setData({ from: e.detail.value }, () => this.load(true, false)); },
  onTo(e) { this.setData({ to: e.detail.value }, () => this.load(true, false)); },

  onStaff(e) {
    this.setData({ staffIndex: Number(e.detail.value) }, () => this.load(true, false));
  },

  toggleBad() {
    this.setData({ bad: !this.data.bad }, () => this.load(true, false));
  },

  resetFilter() {
    this.setData({ q: '', from: '', to: '', bad: false, staffIndex: 0 }, () => this.load(true, false));
  },

  // 后端 from/to 是毫秒时间戳；iOS 无法解析 "YYYY-MM-DD hh:mm:ss"，先换成斜杠
  queryParams() {
    const p = {};
    const q = String(this.data.q || '').trim();
    if (q) p.q = q;
    if (this.data.bad) p.bad = '1';
    if (this.data.from) {
      p.from = String(new Date(String(this.data.from).replace(/-/g, '/') + ' 00:00:00').getTime());
    }
    if (this.data.to) {
      p.to = String(new Date(String(this.data.to).replace(/-/g, '/') + ' 23:59:59').getTime());
    }
    if (this.data.staffIndex > 0) p.name = this.data.staffNames[this.data.staffIndex];
    return p;
  },

  /* ---------------- 列表 ---------------- */

  load(reset, silent) {
    const nextPage = reset ? 1 : this.data.page + 1;
    if (reset) {
      if (!silent) this.setData({ state: 'loading', errMsg: '' });
    } else {
      this.setData({ loadingMore: true });
    }

    const params = Object.assign({ page: nextPage, pageSize: this.data.pageSize }, this.queryParams());

    api.get('/api/checkins', params)
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
      .then(() => wx.stopPullDownRefresh());
  },

  mapRow(r) {
    const insp = r.inspections || [];
    let badText = '';
    if (insp.length) {
      badText = insp.filter((i) => i.status === 'bad').map((i) => i.name).join('、');
    } else {
      badText = [
        ['机房温度', r.temp_status], ['环境', r.env_status],
        ['网络设备', r.net_status], ['UPS电池', r.ups_status]
      ].filter((x) => x[1] === 'bad').map((x) => x[0]).join('、');
    }
    return {
      id: r.id,
      location: r.location || '未填写位置',
      timeText: fmt.fmtDateShort(r.created_ts || r.created_at),
      nameText: (r.name || '-') + (r.staff_id ? '（' + r.staff_id + '）' : ''),
      badText,
      bad: !!badText,
      customText: r.custom_text || '',
      photo: r.photo || '',
      thumb: r.photo ? api.photoUrl(r.photo) : ''
    };
  },

  reload() {
    this.load(true, false);
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
  },

  /* ---------------- 导出 ---------------- */

  exportXlsx() {
    this.doExport(true);
  },

  exportLite() {
    this.doExport(false);
  },

  doExport(withPhotos) {
    if (this.data.exporting) return;
    if (!this.data.total) {
      api.toast('当前筛选范围没有记录');
      return;
    }
    this.setData({ exporting: true });
    const p = this.queryParams();
    if (!withPhotos) p.photos = '0';
    api.downloadOpen('/api/export.xlsx' + api.qs(p), 'xlsx')
      .then(() => this.setData({ exporting: false }))
      .catch((e) => {
        this.setData({ exporting: false });
        api.toast((e && e.message) || '导出失败');
      });
  },

  onPullDownRefresh() {
    this.load(true, true);
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) this.load(false, true);
  }
});
