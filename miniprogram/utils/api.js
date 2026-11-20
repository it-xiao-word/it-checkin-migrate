'use strict';
/*
 * 网络层：统一携带 Bearer Token、统一错误提示、401 自动回登录页。
 * 后端 auth 中间件同时支持 Cookie 与 Authorization: Bearer，小程序走后者。
 */
const cfg = require('../config');

let redirecting = false;

function app() {
  try { return getApp(); } catch (e) { return null; }
}

function baseUrl() {
  const a = app();
  return (a && a.globalData.baseUrl) || cfg.baseUrl;
}

function token() {
  const a = app();
  return (a && a.globalData.token) || '';
}

function makeError(message, code, status) {
  const e = new Error(message || '请求失败');
  e.code = code;
  e.status = status;
  return e;
}

// 登录失效：清本地态并回登录页。防抖避免并发请求连续 reLaunch
function toLogin() {
  if (redirecting) return;
  redirecting = true;
  const a = app();
  if (a) a.clearToken();
  wx.reLaunch({
    url: '/pages/login/login',
    complete() { setTimeout(() => { redirecting = false; }, 800); }
  });
}

function qs(params) {
  const parts = [];
  const src = params || {};
  Object.keys(src).forEach((k) => {
    const v = src[k];
    if (v === undefined || v === null || v === '') return;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  });
  return parts.length ? '?' + parts.join('&') : '';
}

function authHeader(extra) {
  const h = Object.assign({}, extra || {});
  if (token()) h.Authorization = 'Bearer ' + token();
  return h;
}

function request(path, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    wx.request({
      url: baseUrl() + path,
      method: o.method || 'GET',
      data: o.data || {},
      header: authHeader(Object.assign({ 'content-type': 'application/json' }, o.header || {})),
      timeout: cfg.timeout,
      success(res) {
        const body = (res.data && typeof res.data === 'object') ? res.data : {};
        if (res.statusCode === 401 || body.code === 401) {
          // 已持有令牌才说明是「登录态失效」；登录接口密码错误同样是 401，要留在原页提示
          if (token()) toLogin();
          reject(makeError(body.message || '登录已过期，请重新登录', body.code || 401, 401));
          return;
        }
        if (res.statusCode >= 400 || (typeof body.code === 'number' && body.code !== 0)) {
          reject(makeError(body.message || ('请求失败（' + res.statusCode + '）'), body.code, res.statusCode));
          return;
        }
        resolve(body.data === undefined ? body : body.data);
      },
      fail(err) {
        const msg = err && err.errMsg ? err.errMsg : '';
        const hint = /timeout/i.test(msg)
          ? '请求超时，请检查网络'
          : '网络连接失败，请检查域名是否已在后台登记';
        reject(makeError(hint + '（' + msg + '）', -1, 0));
      }
    });
  });
}

function get(path, params) {
  return request(path + qs(params));
}

function post(path, data) {
  return request(path, { method: 'POST', data: data || {} });
}

function put(path, data) {
  return request(path, { method: 'PUT', data: data || {} });
}

function del(path) {
  return request(path, { method: 'DELETE' });
}

// 打卡提交：multipart/form-data，字段全部以字符串传（服务端按字符串解析）
function upload(path, filePath, formData) {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: baseUrl() + path,
      filePath,
      name: 'photo',
      formData: formData || {},
      header: authHeader(),
      timeout: 60000,
      success(res) {
        let body = {};
        try { body = JSON.parse(res.data); } catch (e) { body = {}; }
        if (res.statusCode === 401 || body.code === 401) {
          // 已持有令牌才说明是「登录态失效」；登录接口密码错误同样是 401，要留在原页提示
          if (token()) toLogin();
          reject(makeError(body.message || '登录已过期，请重新登录', body.code || 401, 401));
          return;
        }
        if (res.statusCode >= 400 || (typeof body.code === 'number' && body.code !== 0)) {
          reject(makeError(body.message || ('上传失败（' + res.statusCode + '）'), body.code, res.statusCode));
          return;
        }
        resolve(body.data === undefined ? body : body.data);
      },
      fail(err) {
        reject(makeError('上传失败：' + ((err && err.errMsg) || '未知错误'), -1, 0));
      }
    });
  });
}

// 打卡照片需要登录才能访问；小程序 <image> 无法带自定义请求头，
// 因此把 token 放在查询参数里（后端 auth 中间件支持 req.query.token）。
function photoUrl(name) {
  if (!name) return '';
  return baseUrl() + '/api/photo/' + encodeURIComponent(name) + '?token=' + encodeURIComponent(token());
}

// 导出文件：下载到临时目录后交给微信内置文档预览，可「用其他应用打开」或转发
function downloadOpen(path, fileType) {
  return new Promise((resolve, reject) => {
    const full = baseUrl() + path + (path.indexOf('?') >= 0 ? '&' : '?')
      + 'token=' + encodeURIComponent(token());
    wx.showLoading({ title: '正在生成…', mask: true });
    wx.downloadFile({
      url: full,
      header: authHeader(),
      timeout: 120000,
      success(res) {
        wx.hideLoading();
        if (res.statusCode !== 200) {
          reject(makeError('导出失败（' + res.statusCode + '），请确认筛选范围内有记录', res.statusCode, res.statusCode));
          return;
        }
        wx.openDocument({
          filePath: res.tempFilePath,
          fileType: fileType || 'xlsx',
          showMenu: true,
          success() { resolve(res.tempFilePath); },
          fail(e) { reject(makeError('文件打开失败：' + ((e && e.errMsg) || ''), -1, 0)); }
        });
      },
      fail(err) {
        wx.hideLoading();
        reject(makeError('下载失败：' + ((err && err.errMsg) || '未知错误'), -1, 0));
      }
    });
  });
}

// 统一 toast（错误文案过长时用弹窗，避免看不全）
function toast(msg, icon) {
  const text = String(msg || '');
  if (text.length > 18) {
    wx.showModal({ title: '提示', content: text, showCancel: false, confirmText: '知道了' });
    return;
  }
  wx.showToast({ title: text, icon: icon || 'none', duration: 2000 });
}

module.exports = {
  baseUrl, token, request, get, post, put, del, upload,
  photoUrl, downloadOpen, toast, toLogin, qs
};
