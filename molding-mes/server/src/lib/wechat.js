/**
 * 微信小程序服务端能力封装（不引第三方 SDK，只用内置 fetch）。
 *
 * 三个真实接口：
 *  1. jscode2session   wx.login() 的 code → openid / unionid / session_key
 *  2. getAccessToken   stable_token 优先，失败回退 cgi-bin/token，内存缓存
 *  3. getuserphonenumber  手机号快速验证组件(<button open-type="getPhoneNumber">)的 code → 真实手机号
 *
 * 开发模式（WX_DEV_MODE=true 且非 production）：不连微信，
 * 直接用提交的手机号换取令牌，便于本地联调与演示。上线必须关闭。
 */
import config from '../config.js';

const API = 'https://api.weixin.qq.com';

const cfg = () => config.wechat;

export const isConfigured = () => !!(cfg().appId && cfg().secret);

/** 开发模式：仅在非生产且显式开启时可用 */
export const devModeAvailable = () => cfg().devMode && config.env !== 'production';

async function wxGet(pathname, params = {}) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg().timeoutMs || 10000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const json = await res.json().catch(() => ({}));
    if (json.errcode) {
      const err = new Error(`微信接口 ${pathname} 返回错误 ${json.errcode}：${json.errmsg || ''}`);
      err.errcode = json.errcode;
      err.wx = true;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function wxPost(pathname, body, params = {}) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg().timeoutMs || 10000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (json.errcode) {
      const err = new Error(`微信接口 ${pathname} 返回错误 ${json.errcode}：${json.errmsg || ''}`);
      err.errcode = json.errcode;
      err.wx = true;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * code → openid。
 * @returns {{openid:string, unionid?:string, sessionKey:string, appid:string, dev:boolean}}
 */
export async function jscode2session(code) {
  if (!code) throw new Error('缺少 wx.login 的 code');
  if (!isConfigured()) {
    if (!devModeAvailable()) throw new Error('未配置 WX_APPID / WX_SECRET，且未开启开发模式');
    // 开发模式：code 原样当作身份标识，便于区分不同"虚拟微信用户"
    return { openid: `dev-${String(code).slice(0, 24)}`, unionid: null, sessionKey: 'dev', appid: cfg().appId || 'dev', dev: true };
  }
  const j = await wxGet('/sns/jscode2session', {
    appid: cfg().appId,
    secret: cfg().secret,
    js_code: code,
    grant_type: 'authorization_code',
  });
  if (!j.openid) throw new Error('微信未返回 openid');
  return { openid: j.openid, unionid: j.unionid || null, sessionKey: j.session_key || '', appid: cfg().appId, dev: false };
}

/* ---------------------------- access_token ---------------------------- */

let tokenCache = { token: null, exp: 0 };

export async function getAccessToken() {
  if (!isConfigured()) throw new Error('未配置 WX_APPID / WX_SECRET');
  if (tokenCache.token && tokenCache.exp > Date.now()) return tokenCache.token;

  let j;
  try {
    // 稳定版接口：不会使旧 token 失效
    j = await wxPost('/cgi-bin/stable_token', {
      grant_type: 'client_credential',
      appid: cfg().appId,
      secret: cfg().secret,
      force_refresh: false,
    });
  } catch {
    j = await wxGet('/cgi-bin/token', {
      grant_type: 'client_credential',
      appid: cfg().appId,
      secret: cfg().secret,
    });
  }
  if (!j.access_token) throw new Error('微信未返回 access_token');
  tokenCache = {
    token: j.access_token,
    exp: Date.now() + Math.max(0, Number(j.expires_in || 7200) - 300) * 1000,
  };
  return tokenCache.token;
}

/**
 * 手机号快速验证：code → 真实手机号。
 * code 来自 <button open-type="getPhoneNumber" bindgetphonenumber> 的 e.detail.code，
 * 每次有效且 5 分钟过期，服务端换取，不需要 session_key 解密。
 */
export async function getPhoneNumber(code) {
  if (!code) throw new Error('缺少手机号授权 code');
  if (!isConfigured()) throw new Error('未配置 WX_APPID / WX_SECRET，无法换取手机号');
  const token = await getAccessToken();
  const j = await wxPost('/wxa/business/getuserphonenumber', { code }, { access_token: token });
  const info = j.phone_info || {};
  if (!info.phoneNumber) throw new Error('微信未返回手机号');
  return {
    phone: String(info.phoneNumber),
    /** 带区号，如 +8613800000000 */
    purePhone: String(info.purePhoneNumber || info.phoneNumber),
    countryCode: String(info.countryCode || '86'),
  };
}

/** 微信登录链路自检：给管理后台展示当前是真实模式还是开发模式 */
export function modeInfo() {
  return {
    configured: isConfigured(),
    appid: cfg().appId || null,
    dev_mode: devModeAvailable(),
    mode: isConfigured() ? 'wechat' : (devModeAvailable() ? 'dev' : 'disabled'),
    note: isConfigured()
      ? '已接入微信小程序，走 jscode2session + 手机号快速验证'
      : (devModeAvailable()
        ? '开发模式：跳过微信鉴权，用手机号直接登录（仅限非生产环境）'
        : '未配置小程序凭证且未开启开发模式，小程序无法登录'),
  };
}
