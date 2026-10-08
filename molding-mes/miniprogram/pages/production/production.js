import { mpView, toastError } from '../../utils/api.js';

const app = getApp();
const short = (s) => (s ? String(s).slice(5, 16) : '—');

Page({
  data: { loading: true, summary: null, machines: [], orders: [] },

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
      const r = await mpView('production');
      const d = r.data || {};
      this.setData({
        loading: false,
        summary: d.summary || null,
        machines: (d.machines || []).map((m) => ({
          ...m,
          cls: m.status === 'AVAILABLE' ? 'ok' : 'err',
          run_short: m.running ? `${short(m.running.start_at)} → ${short(m.running.end_at)}` : '',
        })),
        orders: (d.orders || []).map((o) => ({
          ...o,
          end_short: short(o.planned_end_at),
          pct: o.progress_pct || 0,
          cls: o.delay_risk ? 'err' : '',
          due_short: o.due_date ? String(o.due_date).slice(5) : '—',
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
