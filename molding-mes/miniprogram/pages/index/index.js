import { mpMe, toastError } from '../../utils/api.js';

const app = getApp();

const ROUTE = {
  equipment: '/pages/equipment/equipment',
  inventory: '/pages/inventory/inventory',
  production: '/pages/production/production',
  schedule: '/pages/schedule/schedule',
  material: '/pages/material/material',
  orders: '/pages/orders/orders',
  tasks: '/pages/tasks/tasks',
};

Page({
  data: {
    user: null,
    tenant: null,
    views: [],
    overridden: false,
    refreshedAt: '',
  },

  onShow() {
    if (!app.isLogin()) {
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }
    const p = app.globalData.profile || {};
    this.setData({
      user: p.user || null,
      tenant: p.tenant || null,
      views: p.views || [],
      overridden: p.view_overridden || false,
    });
    this.refresh();
  },

  async onPullDownRefresh() {
    await this.refresh();
    wx.stopPullDownRefresh();
  },

  /** 每次进首页都拉一次：管理员可能刚刚调整了你的可见范围 */
  async refresh() {
    try {
      const me = await mpMe();
      app.globalData.profile = { ...(app.globalData.profile || {}), ...me };
      wx.setStorageSync('mes_profile', app.globalData.profile);
      this.setData({
        user: me.user,
        tenant: me.tenant,
        views: me.views || [],
        overridden: me.view_overridden,
        refreshedAt: fmtTime(new Date()),
      });
    } catch (e) {
      // 令牌失效或权限被取消 → 回登录页
      if (e.code === 'UNAUTHORIZED' || e.code === 'WX_NOT_ALLOWED' || e.code === 'WX_DISABLED') {
        app.clearSession();
        wx.showToast({ title: e.message.slice(0, 26), icon: 'none', duration: 2500 });
        setTimeout(() => wx.redirectTo({ url: '/pages/login/login' }), 1200);
        return;
      }
      toastError(e, '刷新失败');
    }
  },

  go(e) {
    const url = ROUTE[e.currentTarget.dataset.view];
    if (url) wx.navigateTo({ url });
  },

  goMe() {
    wx.navigateTo({ url: '/pages/me/me' });
  },
});

function fmtTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
