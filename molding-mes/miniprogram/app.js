/**
 * 注塑生产协同 MES · 微信小程序
 * 只读看板：按手机号判定权限，只展示该成员可见范围内的数据。
 */
const TOKEN_KEY = 'mes_token';
const PROFILE_KEY = 'mes_profile';
const BASE_KEY = 'mes_base_url';

App({
  globalData: {
    token: wx.getStorageSync(TOKEN_KEY) || '',
    profile: wx.getStorageSync(PROFILE_KEY) || null,
    baseUrl: wx.getStorageSync(BASE_KEY) || 'http://127.0.0.1:8080',
  },

  onLaunch() {
    this.globalData.token = wx.getStorageSync(TOKEN_KEY) || '';
    this.globalData.profile = wx.getStorageSync(PROFILE_KEY) || null;
    this.globalData.baseUrl = wx.getStorageSync(BASE_KEY) || 'http://127.0.0.1:8080';
  },

  saveSession(token, profile) {
    this.globalData.token = token;
    this.globalData.profile = profile;
    wx.setStorageSync(TOKEN_KEY, token);
    wx.setStorageSync(PROFILE_KEY, profile);
  },

  clearSession() {
    this.globalData.token = '';
    this.globalData.profile = null;
    wx.removeStorageSync(TOKEN_KEY);
    wx.removeStorageSync(PROFILE_KEY);
  },

  setBaseUrl(url) {
    this.globalData.baseUrl = String(url || '').replace(/\/+$/, '');
    wx.setStorageSync(BASE_KEY, this.globalData.baseUrl);
  },

  isLogin() {
    return !!this.globalData.token;
  },
});
