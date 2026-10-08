/**
 * 微信小程序服务端能力封装（不引第三方 SDK，只用内置 fetch）。
 *
 * 三个真实接口：
 *  1. jscode2session   wx.login() 的 code → openid / unionid / session_key
 *  2. getAccessToken   stable_token 优先，失败回退 cgi-bin/token，内存缓存
 *  3. getuserphonenumber  手机号快速验证组件(<button open-type="getPhoneNumber">)的 code → 真实手机号
 *
 * 开发模式（WX_DEV_MODE=true 且非 production）：仅当 code 以 `dev-` 开头时命中，
 * 不会误伤微信真实 code（真实 code 形如 "0b3xxx"），因此配置了真实凭证也可以保留，
 * 便于不动真机联调。上线务必把 WX_DEV_MODE 置 false，届时 dev- 桩自动失效。
 */
import config from '../config.js';

const API = 'https://api.weixin.qq.com';

const cfg = () => config.wechat;

/** 开发模式桩的 code 前缀 */
const DEV_PREFIX = 'dev-';

export const isConfigured = () => !!(cfg().appId && cfg().secret);

/** 开发模式：仅在非生产且显式开启时可用 */
export const devModeAvailable = () => cfg().devMode && config.env !== 'production';

/** 绑定方式：auto 走绑定码，phone 走手机号快速验证组件 */
export const bindMode = () => (String(cfg().bindMode || 'auto').toLowerCase() === 'phone' ? 'phone' : 'auto');

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
  const raw = String(code || '');
  if (!raw) throw new Error('缺少 wx.login 的 code');

  // 开发模式桩：只有 dev- 前缀才命中，与微信真实 code 不会冲突
  if (raw.startsWith(DEV_PREFIX)) {
    if (!devModeAvailable()) throw new Error('开发模式未开启（需 WX_DEV_MODE=true 且非 production）');
    const tail = raw.slice(DEV_PREFIX.length).slice(0, 32) || 'anon';
    return { openid: `${DEV_PREFIX}${tail}`, unionid: null, sessionKey: 'dev', appid: cfg().appId || 'dev', dev: true };
  }

  if (!isConfigured()) throw new Error('未配置 WX_APPID / WX_SECRET，无法换取微信身份');

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

/**
 * 手机号组件自检。
 *
 * 用一个必然无效的 code 调用 getuserphonenumber，根据微信返回的错误码反推可用性：
 *   - 40029 invalid code  → 接口可达且未报无权限（先用 code 校验），但无法确定是否还有额度
 *   - 48001 / unauthorized→ 无接口权限（典型：个人主体、未完成微信认证）
 *   - 1400001             → 额度已用尽，需购买资源包
 * 结论只是参考：**不能以 40029 就断定一定能扣到手机号**，所以绑定方式的默认值是 auto（走绑定码）。
 */
export async function phoneComponentProbe() {
  const base = { bind_mode: bindMode() };
  if (!isConfigured()) {
    return { ...base, usable: false, verdict: 'no_credentials', detail: '未配置 WX_APPID / WX_SECRET' };
  }
  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    return { ...base, usable: false, verdict: 'bad_credentials', detail: e.message };
  }
  try {
    await wxPost('/wxa/business/getuserphonenumber', { code: 'PROBE_INVALID_CODE' }, { access_token: token });
    // 未报错（理论不可能，无效 code 必然报错）
    return { ...base, usable: true, verdict: 'usable', detail: '接口调用成功' };
  } catch (e) {
    const code = e.errcode;
    const msg = String(e.message || '');
    if (code === 1400001) return { ...base, usable: false, verdict: 'no_quota', detail: msg, hint: '额度已用尽，需在公众平台「付费管理」购买资源包' };
    if (code === 48001 || /unauthorized/i.test(msg)) {
      return { ...base, usable: false, verdict: 'unauthorized', detail: msg, hint: '手机号快速验证组件仅对已微信认证的非个人主体小程序开放；个人主体无法使用，请改用管理员生成的绑定码' };
    }
    if (code === 40029) {
      return { ...base, usable: null, verdict: 'unknown', detail: msg, hint: '接口可达且未报无权限，但无法确定是否仍有额度。建议保持 auto（绑定码）方式' };
    }
    if (code === 41019 || code === 48002) return { ...base, usable: false, verdict: 'forbidden', detail: msg, hint: '该小程序无此接口权限' };
    return { ...base, usable: null, verdict: 'unknown', detail: msg };
  }
}

/** 微信登录链路自检：给管理后台展示当前是真实模式还是开发模式 */
export function modeInfo() {
  return {
    configured: isConfigured(),
    appid: cfg().appId || null,
    dev_mode: devModeAvailable(),
    bind_mode: bindMode(),
    mode: isConfigured() ? 'wechat' : (devModeAvailable() ? 'dev' : 'disabled'),
    note: isConfigured()
      ? '已接入微信小程序：wx.login 换 openid，绑定推荐用管理员生成的绑定码'
      : (devModeAvailable()
        ? '开发模式：code 以 dev- 开头时走本地桩，可用手机号直接登录（仅限非生产环境）'
        : '未配置小程序凭证且未开启开发模式，小程序无法登录'),
  };
}
