'use strict';
/*
 * 现场打卡页
 *
 * 与 H5 版的差异（都是微信环境的硬约束，不是功能删减）：
 *   - 拍照：wx.chooseMedia 取原图（sizeType: original），压缩完全由本地 Canvas 完成，
 *     服务端不做二次有损编码，避免累积失真。
 *   - 定位：wx.getLocation 取 wgs84，与历史数据、H5 端保持同一坐标系（gcj02 会偏移数百米）。
 *   - 水印：Canvas 2D 绘制，配置与水印引擎和 Web 端共用同一套字段。
 */
const api = require('../../utils/api');
const wm = require('../../utils/wm');
const fmt = require('../../utils/fmt');
const cfg = require('../../config');

const P = cfg.photo;
const ROOM_KEY = 'itck_room';
const WM_KEY = 'itck_wm';

Page({
  data: {
    isAdmin: false,
    notice: '',
    stats: { today: 0, todayBad: 0, month: 0 },

    photo: false,
    previewH: 0,
    photoInfo: '',

    roomNames: [],
    roomIndex: 0,
    location: '',

    inspect: [],
    inspectDone: 0,
    needCustom: false,

    customText: '',
    note: '',

    wmNames: [],
    wmIndex: 0,
    wmCurName: '默认水印',
    wmDefaultTitle: '',
    allowCustom: true,
    customTitle: '',
    customOrg: '',

    locText: '未获取定位',
    locState: '',
    locating: false,

    submitting: false,
    submitText: '提交中…'
  },

  // 以下为不参与渲染的实例状态
  canvas: null,
  ctx: null,
  img: null,
  cssWidth: 320,
  rawBytes: 0,
  gps: null,
  _redrawTimer: null,

  onLoad() {
    const me = getApp().globalData.me || {};
    this.setData({ isAdmin: me.role === 'admin' });
  },

  onShow() {
    const app = getApp();
    if (!app.globalData.token) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    const me = app.globalData.me || {};
    this.setData({ isAdmin: me.role === 'admin' });
    this.loadConfig(false);
    this.loadStats();
  },

  onUnload() {
    if (this._redrawTimer) clearTimeout(this._redrawTimer);
  },

  /* ---------------- 数据加载 ---------------- */

  loadConfig(force) {
    const app = getApp();
    const cached = app.globalData.checkinConfig;
    if (cached && !force) {
      this.applyConfig(cached);
      return;
    }
    api.get('/api/checkin-config')
      .then((d) => {
        app.globalData.checkinConfig = d;
        this.applyConfig(d);
      })
      .catch((e) => api.toast(e.message || '加载打卡配置失败'));
  },

  applyConfig(d) {
    const rooms = d.rooms || [];
    const wms = d.watermarks || [];
    // 优先沿用上次选过的模板，其次取系统默认
    let wmIndex = -1;
    try {
      const savedWm = Number(wx.getStorageSync(WM_KEY)) || 0;
      if (savedWm) wmIndex = wms.findIndex((w) => Number(w.id) === savedWm);
    } catch (e) { wmIndex = -1; }
    if (wmIndex < 0) {
      wmIndex = 0;
      for (let i = 0; i < wms.length; i++) {
        if (wms[i].isDefault) { wmIndex = i; break; }
      }
    }
    const cur = wms[wmIndex] || null;

    this.setData({
      roomNames: rooms.map((r) => r.name),
      wmNames: wms.length ? wms.map((w) => w.name) : ['默认水印'],
      wmIndex,
      wmCurName: cur ? cur.name : '默认水印',
      wmDefaultTitle: cur ? cur.config.title : wm.WM_FALLBACK.title,
      allowCustom: cur ? cur.config.allowCustom !== false : true
    });

    // 恢复上次使用的机房（换设备或清缓存后为空）
    if (!this.data.location && rooms.length) {
      let last = '';
      try { last = wx.getStorageSync(ROOM_KEY) || ''; } catch (e) { last = ''; }
      const idx = rooms.findIndex((r) => r.name === last);
      if (idx >= 0) this.pickRoom(idx);
    } else if (this.data.location) {
      // 配置刷新后按名称重新对齐索引
      const idx = rooms.findIndex((r) => r.name === this.data.location);
      if (idx >= 0) this.setData({ roomIndex: idx });
    }
  },

  loadStats() {
    api.get('/api/stats')
      .then((s) => {
        this.setData({
          stats: { today: s.today || 0, todayBad: s.todayBad || 0, month: s.month || 0 }
        });
      })
      .catch(() => { /* 统计失败不影响打卡 */ });
  },

  /* ---------------- 机房与巡检项 ---------------- */

  onRoom(e) {
    const idx = Number(e.detail.value);
    this.pickRoom(idx);
    const name = this.data.roomNames[idx];
    try { if (name) wx.setStorageSync(ROOM_KEY, name); } catch (err) { /* 忽略 */ }
  },

  pickRoom(idx) {
    const d = getApp().globalData.checkinConfig || {};
    const rooms = d.rooms || [];
    const room = rooms[idx];
    if (!room) return;

    const inspect = this.itemsOf(room).map((it) => ({
      itemId: it.id,
      name: it.name,
      status: ''
    }));

    this.setData({
      roomIndex: idx,
      location: room.name,
      inspect,
      inspectDone: 0,
      needCustom: false
    }, () => this.redraw());
  },

  // 机房 → 分组 → 巡检模板 → 项目
  itemsOf(room) {
    const d = getApp().globalData.checkinConfig || {};
    if (!room || !room.template_id) return [];
    const tpls = d.templates || [];
    for (let i = 0; i < tpls.length; i++) {
      if (tpls[i].id === room.template_id) return tpls[i].items || [];
    }
    return [];
  },

  setStatus(e) {
    const i = Number(e.currentTarget.dataset.i);
    const s = e.currentTarget.dataset.s;
    const list = this.data.inspect.map((x) => ({ itemId: x.itemId, name: x.name, status: x.status }));
    if (!list[i]) return;
    // 再次点同一项取消选择，避免误触后无法回退
    list[i].status = list[i].status === s ? '' : s;
    let done = 0;
    for (const it of list) if (it.status) done++;
    this.setData({ inspect: list, inspectDone: done }, () => {
      this.syncState();
      this.redraw();
    });
  },

  /* ---------------- 文本输入 ---------------- */

  onCustom(e) {
    this.setData({ customText: e.detail.value }, () => this.syncState());
    this.debouncedRedraw();
  },

  onNote(e) {
    this.setData({ note: e.detail.value });
    this.debouncedRedraw();
  },

  onTitle(e) {
    this.setData({ customTitle: e.detail.value });
    this.debouncedRedraw();
  },

  onOrg(e) {
    this.setData({ customOrg: e.detail.value });
    this.debouncedRedraw();
  },

  onWm(e) {
    const idx = Number(e.detail.value);
    const d = getApp().globalData.checkinConfig || {};
    const wms = d.watermarks || [];
    const cur = wms[idx];
    this.setData({
      wmIndex: idx,
      wmCurName: cur ? cur.name : '默认水印',
      wmDefaultTitle: cur ? cur.config.title : wm.WM_FALLBACK.title,
      allowCustom: cur ? cur.config.allowCustom !== false : true
    }, () => {
      try { if (cur && cur.id) wx.setStorageSync(WM_KEY, cur.id); } catch (e) { /* 忽略 */ }
      this.redraw();
    });
  },

  syncState() {
    const list = this.data.inspect;
    let bad = false;
    for (const it of list) if (it.status === 'bad') { bad = true; break; }
    const needCustom = bad && !String(this.data.customText || '').trim();
    if (needCustom !== this.data.needCustom) this.setData({ needCustom });
  },

  /* ---------------- 画布与水印 ---------------- */

  ensureCanvas() {
    if (this.canvas && this.ctx) return Promise.resolve();
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .select('#photoCanvas')
        .fields({ node: true, size: true })
        .exec((res) => {
          const r = res && res[0];
          if (!r || !r.node) {
            reject(new Error('画布初始化失败，请重试'));
            return;
          }
          this.canvas = r.node;
          this.ctx = r.node.getContext('2d');
          if (r.width) this.cssWidth = r.width;
          resolve();
        });
    });
  },

  activeCfg() {
    const d = getApp().globalData.checkinConfig || {};
    const wms = d.watermarks || [];
    const cur = wms[this.data.wmIndex];
    const base = cur ? cur.config : (d.watermark || wm.WM_FALLBACK);
    const t = String(this.data.customTitle || '').trim();
    const o = String(this.data.customOrg || '').trim();
    if (t || o) return wm.wmActive(base, 'custom', t, o);
    return wm.wmNormalize(base);
  },

  wmData() {
    const me = getApp().globalData.me || {};
    const z = (s) => (s === 'ok' ? '正常' : s === 'bad' ? '不正常' : '—');
    const insp = [];
    for (const it of this.data.inspect) insp.push(it.name + z(it.status));
    return {
      time: fmt.fmtTime(new Date()),
      coord: this.gps ? fmt.fmtCoord(this.gps.lat, this.gps.lng, this.gps.accuracy) : '',
      name: me.displayName || me.username || '',
      staffId: me.staffId || '',
      location: this.data.location || '未选择',
      insp,
      inspEmpty: this.data.location ? '未配置巡检项' : '—',
      custom: String(this.data.customText || '').trim(),
      note: String(this.data.note || '').trim()
    };
  },

  // 按指定长边把原图 + 水印画进画布，返回像素尺寸
  paint(maxW) {
    const cv = this.canvas;
    const img = this.img;
    const ctx = this.ctx;
    if (!cv || !img || !ctx) return null;
    const iw = img.width || 0;
    const ih = img.height || 0;
    if (!iw || !ih) return null;
    const scale = Math.min(1, maxW / iw);
    const w = Math.round(iw * scale);
    const h = Math.round(ih * scale);
    cv.width = w;
    cv.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    wm.wmPaint(ctx, w, h, this.activeCfg(), this.wmData());
    return { w, h };
  },

  redraw() {
    if (!this.img || !this.canvas) return;
    const dim = this.paint(P.maxWidth);
    if (!dim) return;
    const previewH = Math.round(this.cssWidth * dim.h / dim.w);
    this.setData({
      previewH,
      photoInfo: this.rawBytes ? ('原图 ' + fmt.fmtBytes(this.rawBytes)) : ''
    });
  },

  debouncedRedraw() {
    if (this._redrawTimer) clearTimeout(this._redrawTimer);
    this._redrawTimer = setTimeout(() => { this.redraw(); }, 220);
  },

  /* ---------------- 拍照 ---------------- */

  takePhoto() {
    if (this.data.isAdmin) {
      api.toast('管理员账号不参与现场打卡');
      return;
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      sizeType: ['original'],   // 取原图，压缩交给自己做，水印才能保持清晰
      camera: 'back',
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0];
        if (!f) return;
        this.rawBytes = f.size || 0;
        // 先撑开画布容器，height:0 的元素拿不到有效 node
        this.setData({ photo: true, previewH: Math.round(this.cssWidth * 0.75) }, () => {
          this.ensureCanvas()
            .then(() => this.loadImage(f.tempFilePath))
            .catch((e) => {
              this.setData({ photo: false, previewH: 0 });
              api.toast(e.message || '照片处理失败');
            });
        });
      },
      fail: (e) => {
        const msg = (e && e.errMsg) || '';
        if (/cancel/i.test(msg)) return;   // 用户取消不提示
        api.toast('无法获取照片：' + msg);
      }
    });
  },

  loadImage(path) {
    wx.showLoading({ title: '处理照片…', mask: true });
    const img = this.canvas.createImage();
    img.onload = () => {
      wx.hideLoading();
      this.img = img;
      this.redraw();
      // 首次拍照自动取一次定位，失败不阻塞
      if (!this.gps && this.data.locState !== 'fail') this.getLocation(true);
    };
    img.onerror = () => {
      wx.hideLoading();
      this.img = null;
      this.setData({ photo: false, previewH: 0 });
      api.toast('照片读取失败，请重试或换一张');
    };
    img.src = path;
  },

  /* ---------------- 定位 ---------------- */

  getLocation(auto) {
    if (this.data.locating) return;
    this.setData({ locating: true, locText: auto ? '正在获取定位…' : '定位中…', locState: '' });

    wx.getLocation({
      // wgs84 与后端历史数据、H5 端保持一致；gcj02 存进去会和旧记录差几百米
      type: 'wgs84',
      isHighAccuracy: true,
      highAccuracyExpireTime: 4000,
      success: (r) => {
        this.gps = { lat: r.latitude, lng: r.longitude, accuracy: r.accuracy };
        this.setData({
          locating: false,
          locState: 'ok',
          locText: fmt.fmtCoord(r.latitude, r.longitude, r.accuracy)
        }, () => this.redraw());
      },
      fail: (e) => {
        const msg = (e && e.errMsg) || '';
        this.gps = null;
        let text = '定位不可用，可继续打卡';
        if (/deny|auth deny|authorize/i.test(msg)) {
          text = '已拒绝定位授权，可继续打卡';
        } else if (/privacy|scope/i.test(msg)) {
          text = '定位接口未开通，可继续打卡';
        }
        this.setData({ locating: false, locState: 'fail', locText: text }, () => this.redraw());
      }
    });
  },

  /* ---------------- 压缩与提交 ---------------- */

  exportJpeg(quality) {
    return new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas: this.canvas,
        fileType: 'jpg',
        quality,
        success: (r) => resolve(r.tempFilePath),
        fail: (e) => reject(new Error('照片编码失败：' + ((e && e.errMsg) || '')))
      });
    });
  },

  fileSize(path) {
    return new Promise((resolve) => {
      wx.getFileSystemManager().getFileInfo({
        filePath: path,
        success: (r) => resolve(r.size || 0),
        fail: () => resolve(0)
      });
    });
  },

  /*
   * 自适应压缩（与 H5 同一策略）：
   *   1) 1280 宽 + q0.82；体积很富余则试 q0.88，优先保清晰度
   *   2) 超目标 → 0.76 / 0.72
   *   3) 仍超 → 缩到 1080 / 960 重绘（水印按新宽度重新排版，字不会糊）
   */
  encodePhoto() {
    const step = (q) => this.exportJpeg(q)
      .then((path) => this.fileSize(path).then((size) => ({ path, size, q })));

    const dim = this.paint(P.maxWidth);
    if (!dim) return Promise.reject(new Error('照片未就绪'));

    return step(P.qStart)
      .then((first) => {
        if (first.size < P.targetBytes * 0.5) {
          return step(P.qHi).then((hi) => (hi.size <= P.targetBytes ? hi : first));
        }
        return first;
      })
      .then((r) => {
        if (r.size <= P.targetBytes) return r;
        return step(0.76).then((s1) => {
          if (s1.size <= P.targetBytes) return s1;
          return step(P.qLow).then((s2) => {
            if (s2.size <= P.targetBytes) return s2;
            return this.shrinkTo(P.minWidth, s2);
          });
        });
      });
  },

  // 1280 宽降到质量下限仍超标时，缩尺寸重绘再压
  shrinkTo(minWidth, fallback) {
    const tryWidth = (maxW) => {
      this.paint(maxW);
      return this.exportJpeg(0.8)
        .then((p) => this.fileSize(p).then((size) => ({ path: p, size, q: 0.8 })))
        .then((r) => {
          if (r.size <= P.targetBytes) return r;
          return this.exportJpeg(0.74)
            .then((p) => this.fileSize(p).then((size) => ({ path: p, size, q: 0.74 })));
        });
    };
    return tryWidth(1080)
      .then((r) => (r.size <= P.targetBytes ? r : tryWidth(minWidth)))
      .then((r) => {
        this.redraw();   // 恢复画布到 1280 预览尺寸
        return r;
      })
      .catch(() => {
        this.redraw();
        return fallback;
      });
  },

  submit() {
    if (this.data.submitting) return;
    if (this.data.isAdmin) {
      api.toast('管理员账号不参与现场打卡');
      return;
    }
    if (!this.img) { api.toast('请先拍照'); return; }
    if (!this.data.location) { api.toast('请选择机房 / 位置'); return; }

    const lacking = this.data.inspect.filter((x) => !x.status);
    if (lacking.length) {
      api.toast('请完成巡检项：' + lacking.map((x) => x.name).join('、'));
      return;
    }
    const bads = this.data.inspect.filter((x) => x.status === 'bad').map((x) => x.name);
    if (bads.length && !String(this.data.customText || '').trim()) {
      this.setData({ needCustom: true });
      api.toast('「' + bads.join('、') + '」不正常，请填写巡检说明');
      return;
    }

    this.setData({ submitting: true, submitText: '提交中…' });

    this.encodePhoto()
      .then((enc) => {
        const d = getApp().globalData.checkinConfig || {};
        const wms = d.watermarks || [];
        const cur = wms[this.data.wmIndex];

        const form = {
          location: this.data.location,
          note: String(this.data.note || '').trim(),
          customText: String(this.data.customText || '').trim(),
          inspect: JSON.stringify(this.data.inspect.map((x) => ({ itemId: x.itemId, status: x.status }))),
          rawBytes: String(this.rawBytes || 0)
        };
        if (cur && cur.id) form.wmTemplateId = String(cur.id);
        if (this.gps) {
          form.lat = String(this.gps.lat);
          form.lng = String(this.gps.lng);
          form.accuracy = String(this.gps.accuracy);
        }
        return api.upload('/api/checkin', enc.path, form).then(() => enc);
      })
      .then((enc) => {
        // 压缩在 encodePhoto 内部完成，对用户透明，不展示体积对比
        this.resetForm();
        this.loadStats();
        this.setData({ notice: '上传成功，打卡完成' });
        setTimeout(() => this.setData({ notice: '' }), 6000);
      })
      .catch((e) => {
        api.toast((e && e.message) || '提交失败');
        this.setData({ submitting: false, submitText: '提交中…' });
      })
      .then(() => {
        if (this.data.submitting) this.setData({ submitting: false });
      });
  },

  // 保留机房与水印选择，清空本条打卡内容
  resetForm() {
    this.img = null;
    this.rawBytes = 0;
    this.gps = null;
    const inspect = this.data.inspect.map((x) => ({ itemId: x.itemId, name: x.name, status: '' }));
    this.setData({
      photo: false,
      previewH: 0,
      photoInfo: '',
      customText: '',
      note: '',
      inspect,
      inspectDone: 0,
      needCustom: false,
      locText: '未获取定位',
      locState: '',
      submitting: false
    });
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
    }
  }
});
