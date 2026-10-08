#!/usr/bin/env node
/**
 * 小程序接入端到端验证（开发模式，无需微信凭证）。
 *   node scripts/mp-demo.js
 *
 * 覆盖：登录鉴权、白名单拦截、按角色/勾选分发视图、越权拦截、管理员关闭权限后失效。
 */
import { buildServer } from '../src/index.js';
import { createDb, migrate } from '../src/db/index.js';

const db = await createDb();
await migrate(db);
const { app } = await buildServer({ db, migrate: false });

let pass = 0;
let fail = 0;

const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); } else { fail += 1; console.log(`  ❌ ${name} ${extra}`); }
};

const call = async (method, url, { token, payload } = {}) => {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const r = await app.inject({ method, url, headers, payload });
  let body = {};
  try { body = JSON.parse(r.body); } catch { /* noop */ }
  return { status: r.statusCode, body };
};

/** 开发模式登录 */
const mpLogin = async (phone) => {
  const r = await call('POST', '/api/mp/login', { payload: { code: `dev-${phone}`, phone } });
  return r.body;
};

console.log('\n════ 1. 小程序启动配置 ════');
{
  const r = await call('GET', '/api/mp/config');
  check('接口可达', r.body.code === 0);
  check('开发模式已开启', r.body.data.mode === 'dev', JSON.stringify(r.body.data));
  console.log(`     模式：${r.body.data.mode}　说明：${r.body.data.note}`);
  console.log(`     视图字典：${r.body.data.views.map((v) => v.zh).join('、')}`);
}

console.log('\n════ 2. 权限拦截（未开通 / 未录入）════');
{
  const r1 = await mpLogin('13800000002');           // 张业务：员工但没开小程序
  check('已录入但未开通小程序 → 拒绝', r1.code === 'WX_NOT_ALLOWED', r1.message);
  console.log(`     ${r1.message}`);

  const r2 = await mpLogin('13900000000');           // 完全没录入
  check('未录入手机号 → 拒绝', r2.code === 'NOT_AUTHORIZED', r2.message);
  console.log(`     ${r2.message}`);
}

console.log('\n════ 3. 技术员 13800000005（赵技术）════');
let techToken = null;
{
  const r = await mpLogin('13800000005');
  check('登录成功', r.code === 0, r.message);
  techToken = r.data?.token;
  const views = r.data?.view_keys || [];
  check('默认视图 = 设备与模具', JSON.stringify(views) === JSON.stringify(['equipment']), JSON.stringify(views));
  console.log(`     可见：${(r.data?.views || []).map((v) => v.zh).join('、')}`);

  const eq = await call('GET', '/api/mp/view/equipment', { token: techToken });
  check('设备视图可读', eq.body.code === 0, eq.body.message);
  const s = eq.body.data?.data?.summary || {};
  console.log(`     机台 ${s.machines_total} 台（运行 ${s.machines_running}／异常 ${s.machines_abnormal}）　模具 ${s.molds_total} 套（待保养 ${s.molds_due}）　待换模 ${s.pending_mold_changes}`);
  const molds = eq.body.data?.data?.molds || [];
  for (const m of molds.slice(0, 3)) {
    console.log(`     ${m.mold_code} 累计 ${m.cumulative_shots}/${m.maintenance_at_shots} 模次，剩余 ${m.remaining_shots}${m.eta_days ? `，约 ${m.eta_days} 天到阈值（${m.eta_basis}）` : '，无依据不预估'}`);
  }
  const ch = eq.body.data?.data?.next_mold_changes || [];
  for (const c of ch.slice(0, 3)) {
    console.log(`     ${c.machine_code} 换模 ${c.from_mold_code || '空'} → ${c.to_mold_code}，${c.changeover_start_at} 起 ${c.changeover_minutes} 分钟`);
  }

  const sc = await call('GET', '/api/mp/view/schedule', { token: techToken });
  check('越权访问排产 → 403 拦截', sc.status === 403 && sc.body.code === 'VIEW_FORBIDDEN', sc.body.message);
  console.log(`     ${sc.body.message}`);
}

console.log('\n════ 4. 老板 13800000008（孙老板）════');
{
  const r = await mpLogin('13800000008');
  check('登录成功', r.code === 0, r.message);
  const t = r.data?.token;
  const views = r.data?.view_keys || [];
  check('默认视图 = 库存 + 生产实况', JSON.stringify(views.sort()) === JSON.stringify(['inventory', 'production']), JSON.stringify(views));

  const inv = await call('GET', '/api/mp/view/inventory', { token: t });
  check('库存视图可读', inv.body.code === 0, inv.body.message);
  const is = inv.body.data?.data?.summary || {};
  console.log(`     成品 ${is.finished_total} 个（${is.finished_skus} 个 SKU）　在制 ${is.wip_total}　原料缺料 ${is.material_shortages} 项　标签缺料 ${is.label_shortages} 项`);
  for (const a of (inv.body.data?.data?.shortage_alerts || []).slice(0, 3)) {
    console.log(`     ⚠ ${a.kind === 'LABEL' ? '标签' : '原料'} ${a.name} 缺 ${a.gap_qty} ${a.unit}`);
  }
  for (const m of (inv.body.data?.data?.materials || []).slice(0, 3)) {
    console.log(`     ${m.name} 库存 ${m.stock_qty}${m.unit}／安全 ${m.safety_stock}${m.unit}`);
  }

  const prd = await call('GET', '/api/mp/view/production', { token: t });
  check('生产实况可读', prd.body.code === 0, prd.body.message);
  const ps = prd.body.data?.data?.summary || {};
  console.log(`     在建订单 ${ps.open_orders}　运行机台 ${ps.running_machines}/${ps.machines_total}　交期风险 ${ps.delay_risk_orders}　今日出库 ${ps.outbound_today_qty}`);

  const eq = await call('GET', '/api/mp/view/equipment', { token: t });
  check('越权访问设备 → 403 拦截', eq.status === 403, eq.body.message);
}

console.log('\n════ 5. PMC 13800000009（周计划）════');
{
  const r = await mpLogin('13800000009');
  check('登录成功', r.code === 0, r.message);
  const t = r.data?.token;
  const views = r.data?.view_keys || [];
  check('默认视图 = 排产计划', JSON.stringify(views) === JSON.stringify(['schedule']), JSON.stringify(views));

  const sc = await call('GET', '/api/mp/view/schedule', { token: t });
  check('排产视图可读', sc.body.code === 0, sc.body.message);
  const ss = sc.body.data?.data?.summary || {};
  console.log(`     任务 ${ss.tasks} 个　机台 ${ss.machines} 台　总工时 ${ss.total_duration_hours}h　换模 ${ss.changeovers} 次　交期风险 ${ss.delay_risk}`);
  for (const t2 of (sc.body.data?.data?.tasks || []).slice(0, 5)) {
    console.log(`     ${t2.seq}. ${t2.machine_code} 模具${t2.mold_code} ${t2.product_name} ${t2.planned_qty}个 ${String(t2.start_at).slice(5, 16)} → ${String(t2.end_at).slice(5, 16)}（${t2.decision}）`);
  }
  for (const l of (sc.body.data?.data?.machine_load || []).slice(0, 3)) {
    console.log(`     ${l.machine_code} 负载 ${l.planned_hours}h`);
  }

  const inv = await call('GET', '/api/mp/view/inventory', { token: t });
  check('越权访问库存 → 403 拦截', inv.status === 403, inv.body.message);
}

console.log('\n════ 6. 管理员逐人覆盖视图 ════');
{
  const admin = await call('POST', '/api/auth/login', {
    payload: { phone: '13800000001', password: '123456', tenantCode: 'DEMO' },
  });
  const at = admin.body.data?.token;
  const list = await call('GET', '/api/admin/wx-access', { token: at });
  check('白名单列表可读', list.body.code === 0, list.body.message);
  console.log(`     已开通 ${list.body.data?.items?.length} 人`);
  for (const it of list.body.data?.items || []) {
    console.log(`     ${it.phone} ${it.name || ''} ${it.role_zh || '非员工'} → ${(it.effective_views || []).join('/') || '—'} ${it.enabled ? '' : '（已关闭）'}`);
  }

  // 给技术员额外开排产视图
  const up = await call('POST', '/api/admin/wx-access', {
    token: at, payload: { phone: '13800000005', views: ['equipment', 'schedule'] },
  });
  check('覆盖视图成功', up.body.code === 0, up.body.message);
  console.log(`     ${up.body.message} → ${(up.body.data?.effective_views || []).join(' / ')}`);

  const again = await mpLogin('13800000005');
  check('重新登录后视图已扩展', (again.data?.view_keys || []).includes('schedule'), JSON.stringify(again.data?.view_keys));
  const sc = await call('GET', '/api/mp/view/schedule', { token: again.data.token });
  check('技术员现在可读排产', sc.body.code === 0, sc.body.message);

  // 关闭权限
  const item = (list.body.data?.items || []).find((i) => i.phone === '13800000005');
  const off = await call('PUT', `/api/admin/wx-access/${item.id}`, { token: at, payload: { enabled: false } });
  check('关闭权限成功', off.body.code === 0, off.body.message);
  const after = await mpLogin('13800000005');
  check('关闭后无法登录', after.code === 'WX_DISABLED', after.message);
  console.log(`     ${after.message}`);

  // 恢复
  await call('PUT', `/api/admin/wx-access/${item.id}`, { token: at, payload: { enabled: true, views: null } });
  const back = await mpLogin('13800000005');
  check('恢复后视图回到角色默认', JSON.stringify(back.data?.view_keys || []) === JSON.stringify(['equipment']), JSON.stringify(back.data?.view_keys));

  // 未录入员工直接开通 → 应拒绝
  const bad = await call('POST', '/api/admin/wx-access', { token: at, payload: { phone: '13911112222' } });
  check('给非员工开通 → 拒绝', bad.body.code === 'NOT_EMPLOYEE', bad.body.message);
  console.log(`     ${bad.body.message}`);
}

console.log(`\n════ 结果：通过 ${pass} 项，失败 ${fail} 项 ════\n`);

await app.close();
db.close();
process.exit(fail ? 1 : 0);
