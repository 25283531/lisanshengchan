import { mpView, toastError } from '../../utils/api.js';

const app = getApp();

Page({
  data: { loading: true, summary: null, finished: [], materials: [], labels: [], alerts: [] },

  onLoad() {
    if (!app.isLogin()) return wx.redirectTo({ url: '/pages/login/login' });
    this.load();
  },
  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  async load() {
    try {
      const r = await mpView('inventory');
      const d = r.data || {};
      this.setData({
        loading: false,
        summary: d.summary || null,
        finished: d.finished || [],
        materials: (d.materials || []).map((m) => ({
          ...m,
          cls: m.shortage ? 'err' : 'ok',
          pct: m.coverage_pct === null ? null : Math.min(m.coverage_pct, 100),
        })),
        labels: (d.labels || []).map((m) => ({
          ...m,
          cls: m.shortage ? 'err' : 'ok',
          pct: m.coverage_pct === null ? null : Math.min(m.coverage_pct, 100),
        })),
        alerts: d.shortage_alerts || [],
      });
    } catch (e) {
      this.setData({ loading: false });
      if (e.code === 'VIEW_FORBIDDEN') {
        wx.showModal({ title: '无权限', content: e.message, showCancel: false, success: () => wx.navigateBack() });
        return;
      }
      toastError(e, '加载失败');
    }
  },
});
