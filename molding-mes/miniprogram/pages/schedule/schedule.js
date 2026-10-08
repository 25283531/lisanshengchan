import { mpView, toastError } from '../../utils/api.js';

const app = getApp();
const short = (s) => (s ? String(s).slice(5, 16) : '—');

const DECISION = {
  KEEP_CURRENT_MOLD: { zh: '沿用现模具', cls: 'ok' },
  CHANGE_MOLD: { zh: '需换模', cls: 'warn' },
  ACTIVATE_IDLE_MACHINE: { zh: '启用闲置机台', cls: 'brand' },
};

Page({
  data: { loading: true, summary: null, tasks: [], loads: [] },

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
      const r = await mpView('schedule');
      const d = r.data || {};
      this.setData({
        loading: false,
        summary: d.summary || null,
        tasks: (d.tasks || []).map((t) => {
          const dec = DECISION[t.decision] || { zh: t.decision, cls: '' };
          return {
            ...t,
            decision_zh: dec.zh,
            decision_cls: dec.cls,
            start_short: short(t.start_at),
            end_short: short(t.end_at),
            feed_order_short: short(t.feeding_order_at),
            feed_ready_short: short(t.feeding_ready_at),
            hours: t.duration_minutes ? (t.duration_minutes / 60).toFixed(1) : '—',
          };
        }),
        loads: d.machine_load || [],
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
