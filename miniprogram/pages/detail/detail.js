'use strict';
const api = require('../../utils/api');
const fmt = require('../../utils/fmt');

const Z = (s) => (s === 'ok' ? '正常' : s === 'bad' ? '异常' : '');

Page({
  data: {
    state: 'loading',   // loading | ok | error
    errMsg: '',
    row: {},
    insp: [],
    photoUrl: ''
  },

  _id: 0,

  onLoad(q) {
    this._id = Number((q && q.id) || 0);
    this.load();
  },

  load() {
    if (!this._id) {
      this.setData({ state: 'error', errMsg: '缺少记录编号' });
      return;
    }
    this.setData({ state: 'loading' });
    api.get('/api/checkins/' + this._id)
      .then((r) => {
        const insp = (r.inspections || []).map((it) => ({
          name: it.name,
          status: it.status,
          text: it.status === 'bad' ? '异常' : '正常'
        }));
        // 旧版固定四列的记录没有 inspections，改用四列还原
        if (!insp.length) {
          const legacy = [
            ['机房温度', r.temp_status],
            ['环境', r.env_status],
            ['网络设备', r.net_status],
            ['UPS电池', r.ups_status]
          ];
          for (const [n, s] of legacy) {
            if (s === 'ok' || s === 'bad') insp.push({ name: n, status: s, text: s === 'bad' ? '异常' : '正常' });
          }
        }

        let photoSize = '';
        if (r.photo_bytes) {
          photoSize = fmt.fmtBytes(r.photo_bytes);
          if (r.photo_raw_bytes && r.photo_raw_bytes > r.photo_bytes) {
            const pct = Math.round((1 - r.photo_bytes / r.photo_raw_bytes) * 100);
            photoSize = fmt.fmtBytes(r.photo_raw_bytes) + ' → ' + fmt.fmtBytes(r.photo_bytes) + '（省 ' + pct + '%）';
          }
        }

        let bad = false;
        for (const it of insp) if (it.status === 'bad') { bad = true; break; }

        this.setData({
          state: 'ok',
          insp,
          photoUrl: r.photo ? api.photoUrl(r.photo) : '',
          row: {
            id: r.id,
            location: r.location || '未填写位置',
            timeText: fmt.fmtTime(r.created_ts || r.created_at),
            nameText: (r.name || '-') + (r.staff_id ? '（' + r.staff_id + '）' : ''),
            coord: fmt.fmtCoord(r.lat, r.lng, r.accuracy),
            wmTemplate: r.wm_template || '',
            customText: r.custom_text || '',
            note: r.note || '',
            photoSize,
            bad
          }
        });
      })
      .catch((e) => {
        this.setData({ state: 'error', errMsg: (e && e.message) || '记录加载失败' });
      });
  },

  preview() {
    if (!this.data.photoUrl) return;
    wx.previewImage({ urls: [this.data.photoUrl], current: this.data.photoUrl });
  },

  remove() {
    wx.showModal({
      title: '删除记录',
      content: '删除后照片与巡检明细一并清除，无法恢复，确定删除吗？',
      confirmText: '删除',
      confirmColor: '#C0392B',
      success: (r) => {
        if (!r.confirm) return;
        api.del('/api/checkins/' + this._id)
          .then(() => {
            wx.showToast({ title: '已删除', icon: 'success', duration: 1000 });
            setTimeout(() => wx.navigateBack(), 500);
          })
          .catch((e) => api.toast((e && e.message) || '删除失败'));
      }
    });
  }
});
