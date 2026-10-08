import { mpConfig, mpLogin, mpBind, toastError } from '../../utils/api.js';

const app = getApp();

Page({
  data: {
    mode: '',            // wechat | dev | disabled
    note: '',
    loading: true,
    phone: '',           // 开发模式用
    step: 'login',       // login | bind
    openidHint: '',
    devMode: false,
    multiTenants: null,  // 一人多家公司时选择
    loginCode: '',
  },

  async onLoad() {
    try {
      const cfg = await mpConfig();
      this.setData({
        mode: cfg.mode,
        note: cfg.note,
        devMode: cfg.dev_mode,
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false, mode: 'error', note: String(e.message || '无法连接服务器') });
    }
  },

  onPhoneInput(e) {
    this.setData({ phone: e.detail.value });
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

  /** 手机号快速验证组件回调 */
  async onGetPhone(e) {
    if (e.detail.errMsg && e.detail.errMsg.indexOf('ok') < 0) {
      wx.showToast({ title: '需要授权手机号才能使用', icon: 'none' });
      return;
    }
    const phoneCode = e.detail.code;
    if (!phoneCode) {
      wx.showToast({ title: '未取到手机号授权，请重试', icon: 'none' });
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

  /** 开发模式：手机号直接登录 */
  async onDevLogin() {
    const phone = String(this.data.phone || '').trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) {
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
        this.data.devMode ? this.onDevLogin() : this.onWechatLogin();
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
