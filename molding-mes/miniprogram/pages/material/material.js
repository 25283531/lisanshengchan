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
      const r = await mpView('material');
      const d = r.data || {};
      this.setData({
        loading: false,
        summary: d.summary || null,
        items: (d.items || []).map((it) => ({
          ...it,
          kind_zh: it.kind === 'LABEL' ? '标签' : '原料',
          details: (it.details || []).map((x) => ({ ...x, use_short: short(x.use_at) })),
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
