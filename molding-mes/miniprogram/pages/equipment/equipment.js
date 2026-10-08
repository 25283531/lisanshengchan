import { mpView, toastError } from '../../utils/api.js';

const app = getApp();
const short = (s) => (s ? String(s).slice(5, 16) : '—');

Page({
  data: {
    loading: true,
    summary: null,
    machines: [],
    molds: [],
    pending: [],
    changes: [],
    generatedAt: '',
  },

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
      const r = await mpView('equipment');
      const d = r.data || {};
      this.setData({
        loading: false,
        summary: d.summary || null,
        generatedAt: short(r.generated_at),
        machines: (d.machines || []).map((m) => ({
          ...m,
          status_cls: m.status === 'AVAILABLE' && m.enabled ? 'ok' : 'err',
          status_text: m.enabled ? m.status : '已停用',
          run_short: m.running ? `${short(m.running.start_at)} → ${short(m.running.end_at)}` : '',
          change_short: m.next_mold_change ? short(m.next_mold_change.changeover_start_at) : '',
        })),
        molds: (d.molds || []).map((m) => ({
          ...m,
          pct: m.usage_pct === null ? 0 : m.usage_pct,
          pct_cls: m.maintenance_due ? 'err' : (m.maintenance_near ? 'warn' : ''),
          status_tag: m.maintenance_due ? '已到保养阈值' : (m.maintenance_near ? '接近保养' : '正常'),
          last_short: m.last_maintenance_at ? String(m.last_maintenance_at).slice(0, 10) : '未记录',
        })),
        pending: d.pending_maintenance || [],
        changes: (d.next_mold_changes || []).map((c) => ({
          ...c,
          start_short: short(c.changeover_start_at),
          end_short: short(c.changeover_end_at),
          work_short: short(c.work_start_at),
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
