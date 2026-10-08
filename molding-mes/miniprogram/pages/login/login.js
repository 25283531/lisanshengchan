import { mpConfig, mpLogin, mpBind, mpBindByCode, toastError } from '../../utils/api.js';

const app = getApp();

const PHONE_RE = /^1[3-9]\d{9}$/;

Page({
  data: {
    mode: '',            // wechat | dev | disabled | error
    note: '',
    loading: true,
    phone: '',
    bindCode: '',
    step: 'login',       // login | bind
    openidHint: '',
    devMode: false,
    multiTenants: null,  // 一人多家公司时选择
    loginCode: '',
    /** 绑定方式开关：由服务端 /api/mp/config 的 bind_methods 决定 */
    useBindCode: true,
    usePhoneComponent: false,
  },

  async onLoad() {
    try {
      const cfg = await mpConfig();
      const methods = cfg.bind_methods || ['bind_code'];
      this.setData({
        mode: cfg.mode,
        note: cfg.note,
        devMode: cfg.dev_mode,
        loading: false,
        useBindCode: methods.includes('bind_code'),
        usePhoneComponent: methods.includes('phone_component'),
      });
    } catch (e) {
      this.setData({ loading: false, mode: 'error', note: String(e.message || '无法连接服务器') });
    }
  },

  onPhoneInput(e) {
    this.setData({ phone: e.detail.value });
  },

  onBindCodeInput(e) {
    this.setData({ bindCode: String(e.detail.value || '').toUpperCase() });
  },

  /** 微信登录：拿 code 换 openid */
  async onWechatLogin() {
    wx.showLoading({ title: '登录中' });
    try {
      const lr = await wxLogin();
      const data = await mpLogin(lr.code);
      wx.hideLoading();
      if (data.bound) return this.afterLogin(data);
      this.setData({ step: 'bind', loginCode: lr.code });
    } catch (e) {
      wx.hideLoading();
      if (e.code === 'MULTI_TENANT') return this.pickTenant(e.payload);
      toastError(e, '登录失败');
    }
  },

  /** 手机号快速验证组件回调（需企业认证 + 付费，个人主体无效） */
  async onGetPhone(e) {
    if (e.detail.errMsg && e.detail.errMsg.indexOf('ok') < 0) {
      wx.showToast({ title: '需要授权手机号才能使用', icon: 'none' });
      return;
    }
    const phoneCode = e.detail.code;
    if (!phoneCode) {
      wx.showToast({ title: '未取到手机号授权，请改用绑定码绑定', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '绑定中' });
    try {
      let code = this.data.loginCode;
      if (!code) code = (await wxLogin()).code;   // code 5 分钟有效，过期重新取
      const data = await mpBind({ code, phoneCode });
      wx.hideLoading();
      await this.afterLogin(data);
    } catch (e) {
      wx.hideLoading();
      if (e.code === 'MULTI_TENANT') return this.pickTenant(e.payload);
      toastError(e, '绑定失败');
    }
  },

  /** 绑定码绑定（默认方式） */
  async onBindByCode() {
    const phone = String(this.data.phone || '').trim();
    const bindCode = String(this.data.bindCode || '').trim().toUpperCase();
    if (!PHONE_RE.test(phone)) return wx.showToast({ title: '请输入 11 位手机号', icon: 'none' });
    if (!bindCode) return wx.showToast({ title: '请输入管理员给的绑定码', icon: 'none' });

    wx.showLoading({ title: '绑定中' });
    try {
      let code = this.data.loginCode;
      if (!code) code = (await wxLogin()).code;
      const data = await mpBindByCode({ code, phone, bindCode: bindCode, tenantCode: this.data.tenantCode });
      wx.hideLoading();
      await this.afterLogin(data);
    } catch (e) {
      wx.hideLoading();
      if (e.code === 'MULTI_TENANT') return this.pickTenant(e.payload);
      toastError(e, '绑定失败');
    }
  },

  /**
   * 扫码绑定：二维码内容可以是 "MPBIND:XXXXXX" 或 "...?c=XXXXXX"。
   * 二维码本身用什么工具生成都行（后台给的是纯文本载荷）。
   */
  async onScanBind() {
    try {
      const r = await new Promise((resolve, reject) => {
        wx.scanCode({
          onlyFromCamera: false,
          scanType: ['qrCode', 'barCode'],
          success: resolve,
          fail: (e) => reject(new Error(e.errMsg || '扫码失败')),
        });
      });
      const raw = String(r.result || '').trim();
      const m = raw.match(/^MPBIND:([A-Z0-9]+)$/i) || raw.match(/[?&]c=([A-Z0-9]+)/i);
      if (!m) {
        wx.showToast({ title: '不是有效的绑定码二维码', icon: 'none' });
        return;
      }
      this.setData({ bindCode: m[1].toUpperCase() });
      wx.showToast({ title: '已识别绑定码，请填手机号', icon: 'none' });
    } catch (e) {
      toastError(e, '扫码失败');
    }
  },

  /** 开发模式：手机号直接登录 */
  async onDevLogin() {
    const phone = String(this.data.phone || '').trim();
    if (!PHONE_RE.test(phone)) {
      wx.showToast({ title: '请输入 11 位手机号', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '登录中' });
    try {
      const data = await mpLogin(`dev-${Date.now()}`, { phone, tenantCode: this.data.tenantCode });
      wx.hideLoading();
      await this.afterLogin(data);
    } catch (e) {
      wx.hideLoading();
      if (e.code === 'MULTI_TENANT') return this.pickTenant(e.payload);
      toastError(e, '登录失败');
    }
  },

  /** 一人多家公司：列出后重登 */
  pickTenant(payload) {
    const list = (payload && payload.tenants) || [];
    const names = list.map((t) => t.name);
    wx.showActionSheet({
      itemList: names,
      success: (res) => {
        const t = list[res.tapIndex];
        this.setData({ tenantCode: t.code });
        if (this.data.mode === 'dev') this.onDevLogin();
        else if (this.data.bindCode) this.onBindByCode();
        else this.onWechatLogin();
      },
    });
  },

  async afterLogin(data) {
    app.saveSession(data.token, {
      user: data.user, tenant: data.tenant, views: data.views, view_keys: data.view_keys,
    });
    wx.showToast({ title: '登录成功', icon: 'success' });
    setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 600);
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/me/me' });
  },
});

function wxLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (r) => (r.code ? resolve({ code: r.code }) : reject(new Error('wx.login 失败：' + r.errMsg))),
      fail: (e) => reject(new Error('wx.login 失败：' + e.errMsg)),
    });
  });
}
