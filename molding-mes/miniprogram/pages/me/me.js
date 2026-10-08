import { mpMe, mpUnbind, toastError } from '../../utils/api.js';

const app = getApp();

Page({
  data: {
    user: null,
    tenant: null,
    views: [],
    roleDefaults: [],
    overridden: false,
    baseUrl: '',
    envTip: '',
  },

  onShow() {
    if (!app.isLogin()) return wx.redirectTo({ url: '/pages/login/login' });
    const p = app.globalData.profile || {};
    this.setData({
      user: p.user || null,
      tenant: p.tenant || null,
      views: p.views || [],
      roleDefaults: p.role_default_views || [],
      overridden: p.view_overridden || false,
      baseUrl: app.globalData.baseUrl,
      envTip: app.globalData.baseUrl.indexOf('https://') === 0
        ? '已使用 HTTPS，正式环境需在小程序后台配置 request 合法域名。'
        : '当前为 HTTP 地址，真机预览请在开发者工具勾选「不校验合法域名」，上线前必须换成 HTTPS 备案域名。',
    });
    this.refresh();
  },

  async refresh() {
    try {
      const me = await mpMe();
      app.globalData.profile = { ...(app.globalData.profile || {}), ...me };
      wx.setStorageSync('mes_profile', app.globalData.profile);
      this.setData({
        user: me.user, tenant: me.tenant,
        views: me.views || [], roleDefaults: me.role_default_views || [],
        overridden: me.view_overridden,
      });
    } catch (e) {
      if (e.code === 'WX_NOT_ALLOWED' || e.code === 'WX_DISABLED') {
        app.clearSession();
        wx.showModal({ title: '访问权已变更', content: e.message, showCancel: false, success: () => wx.reLaunch({ url: '/pages/login/login' }) });
        return;
      }
      toastError(e, '刷新失败');
    }
  },

  onBaseInput(e) {
    this.setData({ baseUrl: e.detail.value });
  },

  saveBase() {
    const url = String(this.data.baseUrl || '').trim();
    if (!url) return wx.showToast({ title: '请填写服务器地址', icon: 'none' });
    app.setBaseUrl(url);
    wx.showToast({ title: '已保存', icon: 'success' });
    this.setData({ baseUrl: app.globalData.baseUrl });
  },

  async unbind() {
    const ok = await new Promise((r) => wx.showModal({
      title: '解绑微信',
      content: '解绑后需要用手机号重新授权才能登录，确定继续？',
      success: (res) => r(res.confirm),
    }));
    if (!ok) return;
    try {
      const lr = await new Promise((resolve, reject) => {
        wx.login({ success: (r) => (r.code ? resolve({ code: r.code }) : reject(new Error('wx.login 失败'))), fail: () => reject(new Error('wx.login 失败')) });
      });
      await mpUnbind(lr.code);
      app.clearSession();
      wx.reLaunch({ url: '/pages/login/login' });
    } catch (e) {
      toastError(e, '解绑失败');
    }
  },

  logout() {
    app.clearSession();
    wx.reLaunch({ url: '/pages/login/login' });
  },
});
