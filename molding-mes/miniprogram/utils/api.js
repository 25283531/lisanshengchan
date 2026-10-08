/** 接口封装：统一承载令牌、错误码与超时 */

const app = () => getApp();

export const baseUrl = () => app().globalData.baseUrl;

function request(method, path, data = {}, needAuth = true) {
  const g = app().globalData;
  const header = { 'Content-Type': 'application/json' };
  if (needAuth && g.token) header.Authorization = `Bearer ${g.token}`;
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${baseUrl()}${path}`,
      method,
      data,
      header,
      timeout: 30000,
      success(res) {
        const body = res.data || {};
        if (res.statusCode >= 500) {
          reject(err(`服务端异常 ${res.statusCode}`));
          return;
        }
        // 业务码非 0：带 code 抛出，便于登录页区分「未绑定 / 未授权」
        if (body.code !== 0) {
          const e = new Error(body.message || '请求失败');
          e.code = body.code;
          e.payload = body.data;
          reject(e);
          return;
        }
        resolve(body.data);
      },
      fail(e) {
        reject(new Error(e.errMsg && e.errMsg.indexOf('timeout') >= 0 ? '请求超时，请检查服务器地址' : '网络错误，请检查服务器地址'));
      },
    });
  });
}

const err = (m) => new Error(m);

export const get = (p, auth = true) => request('GET', p, {}, auth);
export const post = (p, d, auth = true) => request('POST', p, d, auth);

/* ------------------------------ 小程序接口 ------------------------------ */

export const mpConfig = () => get('/api/mp/config', false);
export const mpLogin = (code, extra = {}) => post('/api/mp/login', { code, ...extra }, false);
export const mpBind = (payload) => post('/api/mp/bind', payload, false);
export const mpUnbind = (code) => post('/api/mp/unbind', { code });
export const mpMe = () => get('/api/mp/me');
export const mpView = (view) => get(`/api/mp/view/${encodeURIComponent(view)}`);

/** 统一错误提示 */
export function toastError(e, fallback = '加载失败') {
  wx.showToast({ title: String(e.message || fallback).slice(0, 30), icon: 'none', duration: 2200 });
}
