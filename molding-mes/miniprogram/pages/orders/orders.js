import { mpView, toastError } from '../../utils/api.js';

const app = getApp();

const STATUS = {
  DRAFT: { zh: '待排产', cls: 'warn' },
  SCHEDULED: { zh: '已排产', cls: 'brand' },
  PRODUCING: { zh: '生产中', cls: 'ok' },
  COMPLETED: { zh: '已完成', cls: 'ok' },
  CANCELLED: { zh: '已取消', cls: 'err' },
};

Page({
  data: { loading: true, summary: null, orders: [] },

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
      const r = await mpView('orders');
      const d = r.data || {};
      this.setData({
        loading: false,
        summary: d.summary || null,
        orders: (d.orders || []).map((o) => {
          const st = STATUS[o.status] || { zh: o.status, cls: '' };
          return {
            ...o,
            status_zh: st.zh,
            status_cls: st.cls,
            pct: o.quantity ? Math.round((o.completed_qty / o.quantity) * 100) : 0,
          };
        }),
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
