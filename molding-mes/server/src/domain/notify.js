/**
 * 消息生成与分发。
 * 分发规则：按角色（audience_roles）+ 机台（machine_code）定向。
 *  - 生产人员绑定了机台 → 只收该机台的定向消息 + 广播消息
 *  - 生产人员未绑定机台 → 收全部生产类消息（通用性要求）
 */
import { nowStr, num, round } from '../lib/util.js';

export async function push(db, n) {
  const r = await db.run(
    `INSERT INTO notifications (tenant_id, type, title, body, payload, audience_roles, machine_code, ref_type, ref_id, level, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      n.tenantId, n.type, n.title, n.body || null,
      JSON.stringify(n.payload ?? null),
      JSON.stringify(n.audienceRoles ?? []),
      n.machineCode || null, n.refType || null, n.refId || null,
      n.level || 'INFO', nowStr(),
    ],
  );
  return Number(r.insertId);
}

/**
 * 由排产结果生成各角色消息。
 * @returns {number} 生成的消息条数
 */
export async function pushScheduleNotifications(db, tenantId, result, data) {
  const { tasks = [], materialPlans = [], alerts = [] } = result;
  const productMap = new Map((data.products || []).map((p) => [p.id, p]));
  const materialMap = new Map((data.materials || []).map((m) => [m.sku, m]));
  const labelMap = new Map((data.labels || []).map((l) => [l.sku, l]));
  let count = 0;

  /* 1) 配料员：每种原料的预估用量、预计使用时间、使用几号混料器 */
  const byTask = new Map();
  for (const p of materialPlans) {
    if (p.kind !== 'MATERIAL') continue;
    const key = p.task_seq ?? p.order_code;
    if (!byTask.has(key)) byTask.set(key, []);
    byTask.get(key).push(p);
  }
  for (const [seq, plans] of byTask) {
    const task = tasks.find((t) => t.seq === seq) || tasks[0];
    if (!task) continue;
    const order = task._order;
    const product = task._product;
    const lines = plans.map((p) => {
      const mat = materialMap.get(p.material_sku);
      const name = mat?.name || p.material_sku;
      const mixer = p.mixer_code ? `混料机 ${p.mixer_code}` : '机边桶/人工供料（无需混料）';
      return `${name}（${p.material_sku}） ${round(num(p.qty), 2)} ${p.unit}　预计 ${String(p.use_at).slice(5, 16)} 使用　${mixer}`;
    });
    // 标签需求一并提示：盒子做出来没标签同样发不了货
    const labels = materialPlans.filter((p) => p.kind === 'LABEL' && (p.task_seq ?? p.order_code) === seq);
    for (const lp of labels) {
      const lb = labelMap.get(lp.material_sku);
      lines.push(`标签 ${lb?.name || lp.material_sku} ${Math.ceil(num(lp.qty))} 张　随生产领用`);
    }
    await push(db, {
      tenantId, type: 'MATERIAL_PLAN',
      title: `配料任务 · ${order?.code || ''} ${product?.name || ''} ${task.planned_qty} 个`,
      body: lines.join('\n'),
      payload: {
        order_code: order?.code, machine_code: task.machine_code, mold_code: task.mold_code,
        start_at: task.start_at, mixer_code: task.mixer_code,
        items: plans.map((p) => ({ sku: p.material_sku, qty: round(num(p.qty), 2), unit: p.unit, use_at: p.use_at, mixer_code: p.mixer_code })),
        labels: labels.map((p) => ({ sku: p.material_sku, qty: num(p.qty), unit: '张' })),
      },
      audienceRoles: ['MIXER', 'ADMIN'], machineCode: null,
      refType: 'SCHEDULE_TASK', level: 'INFO',
    });
    count += 1;

    /* 2) 生产人员：新增了哪个订单、多少数量 */
    await push(db, {
      tenantId, type: 'ORDER_CREATED',
      title: `新增生产任务 · ${product?.name || ''} ${task.planned_qty} 个`,
      body: `订单 ${order?.code || '-'}\n机台 ${task.machine_code}　模具 ${task.mold_code}\n计划开工 ${String(task.start_at).slice(5, 16)}　预计完工 ${String(task.end_at).slice(5, 16)}\n换模决策：${decisionZh(task.decision)}${task.changeover_minutes ? `（${task.changeover_minutes} 分钟）` : ''}`,
      payload: {
        order_code: order?.code, product_sku: product?.sku, product_name: product?.name,
        quantity: task.planned_qty, machine_code: task.machine_code, mold_code: task.mold_code,
        start_at: task.start_at, end_at: task.end_at, decision: task.decision,
      },
      audienceRoles: ['PRODUCTION', 'ADMIN'], machineCode: task.machine_code,
      refType: 'SCHEDULE_TASK', level: 'INFO',
    });
    count += 1;
  }

  /* 3) 技术员：换模提醒 */
  for (const t of tasks.filter((x) => x.decision === 'CHANGE_MOLD')) {
    await push(db, {
      tenantId, type: 'MOLD_CHANGE',
      title: `换模提醒 · 机台 ${t.machine_code} → 模具 ${t.mold_code}`,
      body: `换模时长 ${t.changeover_minutes} 分钟，需在 ${String(t.start_at).slice(5, 16)} 前完成并调机。`,
      payload: { machine_code: t.machine_code, mold_code: t.mold_code, start_at: t.start_at, minutes: t.changeover_minutes },
      audienceRoles: ['TECHNICIAN', 'ADMIN'], machineCode: t.machine_code,
      refType: 'SCHEDULE_TASK', level: 'WARN',
    });
    count += 1;
  }

  /* 4) 其余告警按类型定向 */
  const roleMap = {
    MOLD_MAINTENANCE: ['TECHNICIAN', 'ADMIN'],
    MACHINE_FAULT: ['TECHNICIAN', 'ADMIN', 'PRODUCTION'],
    MATERIAL_SHORTAGE: ['WAREHOUSE', 'MIXER', 'ADMIN'],
    LABEL_SHORTAGE: ['WAREHOUSE', 'ADMIN'],
    DELAY_RISK: ['SALES', 'ADMIN'],
  };
  for (const a of alerts) {
    if (a.type === 'MOLD_CHANGE') continue; // 已单独下发
    await push(db, {
      tenantId, type: a.type, title: a.title, body: a.body,
      payload: a.payload, audienceRoles: roleMap[a.type] || ['ADMIN'],
      machineCode: a.payload?.machine_code || null,
      refType: 'ALERT', level: a.level || 'WARN',
    });
    count += 1;
  }

  return count;
}

/** 交接班：按机台下发当班生产任务 */
export async function pushShiftPlan(db, tenantId, rows, shiftStart, hours) {
  const byMachine = new Map();
  for (const r of rows) {
    if (!byMachine.has(r.machine_code)) byMachine.set(r.machine_code, []);
    byMachine.get(r.machine_code).push(r);
  }
  let count = 0;
  for (const [machine, list] of byMachine) {
    const body = list.map((r) =>
      `${r.product_name || r.product_sku || '-'}　${r.planned_qty} 个　模具 ${r.mold_code}　${String(r.window_start).slice(5, 16)}~${String(r.window_end).slice(5, 16)}`,
    ).join('\n');
    await push(db, {
      tenantId, type: 'SHIFT_PLAN',
      title: `${String(shiftStart).slice(5, 16)} 班次 · 机台 ${machine}（${hours} 小时）`,
      body: `本班共 ${list.length} 项：\n${body}`,
      payload: { machine_code: machine, shift_start: shiftStart, hours, items: list },
      audienceRoles: ['PRODUCTION', 'ADMIN'], machineCode: machine,
      refType: 'SHIFT', level: 'INFO',
    });
    count += 1;
  }
  return count;
}

export const decisionZh = (d) => ({
  KEEP_CURRENT_MOLD: '沿用机上模具',
  CHANGE_MOLD: '需要换模',
  ACTIVATE_IDLE_MACHINE: '启用空闲机台（已装该模具）',
}[d] || d);
