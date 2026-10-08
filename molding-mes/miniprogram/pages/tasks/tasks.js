import { mpView, toastError } from '../../utils/api.js';

const app = getApp();
const short = (s) => (s ? String(s).slice(5, 16) : '—');

Page({
  data: { loading: true, summary: null, items: [] },

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
      const r = await mpView('tasks');
      const d = r.data || {};
      this.setData({
        loading: false,
        summary: d.summary || null,
        items: (d.items || []).map((t) => ({
          ...t,
          window: `${short(t.window_start)} — ${short(t.window_end)}`,
          change: t.changeover_minutes ? `换模 ${t.changeover_minutes} 分钟` : '',
        })),
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
