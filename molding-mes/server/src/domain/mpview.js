/**
 * 微信小程序视图聚合。
 *
 * 设计原则：
 *  1. 小程序只读，不做写操作（报工/出库仍走 APP）
 *  2. 所有数据严格按 tenant_id 隔离，且只取该成员可见视图需要的数据
 *  3. 不臆测：缺少实测数据时只给"剩余模次"这类确定量，不给拍脑袋的到期日；
 *     能推算的一律标注 estimate_from 说明依据，便于技术员判断可信度
 */
import { arr, num, round, toStr, toDate, addMinutes } from '../lib/util.js';

const OPEN_STATUS = ['DRAFT', 'SCHEDULED', 'PRODUCING'];

const nowSqlStr = () => toStr(new Date());

/* ------------------------------ 设备与模具 ------------------------------ */

/**
 * 技术员视图：机台状态 / 待维护设备 / 保养进度 / 下次换模时间与模具编号
 */
export async function equipmentView(db, ctx, tid) {
  const now = nowSqlStr();
  const bufferMin = num(ctx.config.schedule.bufferMinutes, 30);

  const machines = await db.query(
    `SELECT code, name, status, current_mold_code, feeding_mode, supply_line_code,
            mixer_code, mold_change_minutes, units_per_hour, enabled, mold_codes
     FROM machines WHERE tenant_id = ? ORDER BY code`,
    [tid],
  );
  const molds = await db.query(
    `SELECT code, name, cavities, status, cumulative_shots, maintenance_at_shots,
            last_maintenance_at, note
     FROM molds WHERE tenant_id = ? ORDER BY code`,
    [tid],
  );
  const running = await db.query(
    `SELECT t.*, o.code AS order_code, p.name AS product_name, p.sku AS product_sku
     FROM schedule_tasks t
     LEFT JOIN orders o ON o.id = t.order_id
     LEFT JOIN products p ON p.id = o.product_id
     WHERE t.tenant_id = ? AND t.status = 'PLANNED' AND t.start_at <= ? AND t.end_at >= ?`,
    [tid, now, now],
  );
  const upcoming = await db.query(
    `SELECT t.*, o.code AS order_code, p.name AS product_name, p.sku AS product_sku
     FROM schedule_tasks t
     LEFT JOIN orders o ON o.id = t.order_id
     LEFT JOIN products p ON p.id = o.product_id
     WHERE t.tenant_id = ? AND t.status = 'PLANNED' AND t.start_at > ?
     ORDER BY t.start_at, t.seq`,
    [tid, now],
  );

  const runByMachine = new Map();
  for (const t of running) runByMachine.set(t.machine_code, t);

  /** 每台机台下一次换模（decision=CHANGE_MOLD 的最近一条） */
  const nextChangeByMachine = new Map();
  for (const t of upcoming) {
    if (t.decision !== 'CHANGE_MOLD') continue;
    if (nextChangeByMachine.has(t.machine_code)) continue;
    const workStart = t.start_at;
    const changeEnd = addMinutes(workStart, -bufferMin);
    const changeStart = addMinutes(changeEnd, -num(t.changeover_minutes, 0));
    nextChangeByMachine.set(t.machine_code, {
      machine_code: t.machine_code,
      from_mold_code: runByMachine.get(t.machine_code)?.mold_code || null,
      to_mold_code: t.mold_code,
      changeover_minutes: num(t.changeover_minutes, 0),
      changeover_start_at: changeStart,
      changeover_end_at: changeEnd,
      buffer_minutes: bufferMin,
      work_start_at: workStart,
      order_code: t.order_code,
      product_name: t.product_name,
      /** 换模时间由「开工时间 − 缓冲 − 换模工时」反推，口径与排产引擎一致 */
      derive_note: `由开工时间反推（换模 ${num(t.changeover_minutes, 0)} 分钟 + ${bufferMin} 分钟缓冲）`,
    });
  }

  /** 模具寿命：有最近排产效率才可估算到期，否则只给剩余模次 */
  const effByMold = new Map();
  for (const t of [...upcoming].reverse()) {
    if (!effByMold.has(t.mold_code) && num(t.units_per_hour, 0) > 0) effByMold.set(t.mold_code, num(t.units_per_hour, 0));
  }

  const moldList = molds.map((m) => {
    const at = num(m.maintenance_at_shots, 0);
    const used = num(m.cumulative_shots, 0);
    const remain = at - used;
    const pct = at > 0 ? round((used / at) * 100, 1) : null;
    const cav = num(m.cavities, 1) || 1;
    const eff = effByMold.get(m.code) || 0;
    const shotsPerHour = eff > 0 ? eff / cav : 0;
    let etaDays = null;
    if (shotsPerHour > 0 && remain > 0) etaDays = round(remain / shotsPerHour / 24, 1);
    // 待维护判定：已超阈值 或 剩余不足 10%
    const dueNow = remain <= 0;
    const nearDue = !dueNow && pct !== null && pct >= 90;
    return {
      mold_code: m.code,
      mold_name: m.name,
      cavities: cav,
      status: m.status,
      cumulative_shots: used,
      maintenance_at_shots: at,
      remaining_shots: remain,
      usage_pct: pct,
      last_maintenance_at: m.last_maintenance_at,
      maintenance_due: dueNow,
      maintenance_near: nearDue,
      /** 无排产效率依据时给 null，不编造日期 */
      eta_days: etaDays,
      eta_basis: etaDays === null ? null : `按最近排产效率 ${round(eff, 0)} 件/小时 ÷ ${cav} 穴估算`,
      note: m.note,
    };
  });

  const machineList = machines.map((m) => {
    const run = runByMachine.get(m.code);
    return {
      machine_code: m.code,
      machine_name: m.name,
      status: m.status,
      enabled: !!m.enabled,
      feeding_mode: m.feeding_mode,
      supply_line_code: m.supply_line_code,
      mixer_code: m.mixer_code,
      current_mold_code: run?.mold_code || m.current_mold_code || null,
      mold_change_minutes: num(m.mold_change_minutes, 0),
      running: run ? {
        order_code: run.order_code,
        product_name: run.product_name,
        planned_qty: num(run.planned_qty, 0),
        start_at: run.start_at,
        end_at: run.end_at,
        progress_pct: progressPct(run.start_at, run.end_at, now),
      } : null,
      next_mold_change: nextChangeByMachine.get(m.code) || null,
      available_mold_codes: arr(m.mold_codes),
    };
  });

  return {
    summary: {
      machines_total: machineList.length,
      machines_running: machineList.filter((m) => m.running).length,
      machines_abnormal: machineList.filter((m) => m.status !== 'AVAILABLE' || !m.enabled).length,
      molds_total: moldList.length,
      molds_due: moldList.filter((m) => m.maintenance_due).length,
      molds_near_due: moldList.filter((m) => m.maintenance_near).length,
      pending_mold_changes: nextChangeByMachine.size,
    },
    machines: machineList,
    molds: moldList,
    pending_maintenance: moldList.filter((m) => m.maintenance_due || m.maintenance_near || m.status !== 'AVAILABLE'),
    next_mold_changes: [...nextChangeByMachine.values()].sort((a, b) => String(a.changeover_start_at).localeCompare(String(b.changeover_start_at))),
  };
}

const progressPct = (start, end, now) => {
  const s = toDate(start)?.getTime();
  const e = toDate(end)?.getTime();
  const n = toDate(now)?.getTime();
  if (!s || !e || !n || e <= s) return null;
  return Math.max(0, Math.min(100, round(((n - s) / (e - s)) * 100, 1)));
};

/* -------------------------------- 库存 --------------------------------- */

/** 老板视图之一：成品库存 / 原料库存 / 标签库存与安全库存预警 */
export async function inventoryView(db, ctx, tid) {
  const products = await db.query(
    `SELECT sku, name, unit, finished_stock_qty, enabled FROM products
     WHERE tenant_id = ? AND enabled = 1 ORDER BY finished_stock_qty DESC`,
    [tid],
  );
  const materials = await db.query(
    `SELECT sku, name, unit, stock_qty, safety_stock, lead_time_days, enabled
     FROM materials WHERE tenant_id = ? AND enabled = 1 ORDER BY sku`,
    [tid],
  );
  const labels = await db.query(
    `SELECT sku, name, category, unit, stock_qty, safety_stock, lead_time_days, enabled
     FROM labels WHERE tenant_id = ? AND enabled = 1 ORDER BY sku`,
    [tid],
  );
  // 在制数量：未完工订单的待生产量，按产品汇总（成品库存不含在制）
  const wip = await db.query(
    `SELECT p.sku, SUM(o.remaining_qty) AS wip_qty
     FROM orders o JOIN products p ON p.id = o.product_id
     WHERE o.tenant_id = ? AND o.status IN (${OPEN_STATUS.map(() => '?').join(',')})
     GROUP BY p.sku`,
    [tid, ...OPEN_STATUS],
  );
  const wipMap = new Map(wip.map((r) => [r.sku, num(r.wip_qty, 0)]));

  const withGap = (rows) => rows.map((r) => {
    const stock = num(r.stock_qty, 0);
    const safe = num(r.safety_stock, 0);
    const gap = round(safe - stock, 3);
    return {
      sku: r.sku, name: r.name, unit: r.unit,
      stock_qty: stock, safety_stock: safe,
      gap_qty: gap > 0 ? gap : 0,
      shortage: gap > 0,
      /** 0 安全库存时不做比率判断，避免除零与误报 */
      coverage_pct: safe > 0 ? round((stock / safe) * 100, 1) : null,
      lead_time_days: num(r.lead_time_days, 0),
    };
  });

  const mat = withGap(materials);
  const lab = withGap(labels.map((l) => ({ ...l, name: `${l.name}${l.category ? `（${l.category}）` : ''}` })));

  return {
    summary: {
      finished_total: round(products.reduce((s, p) => s + num(p.finished_stock_qty, 0), 0), 2),
      finished_skus: products.length,
      material_shortages: mat.filter((m) => m.shortage).length,
      label_shortages: lab.filter((l) => l.shortage).length,
      wip_total: round([...wipMap.values()].reduce((s, v) => s + v, 0), 0),
    },
    finished: products.map((p) => ({
      sku: p.sku, name: p.name, unit: p.unit,
      stock_qty: num(p.finished_stock_qty, 0),
      wip_qty: num(wipMap.get(p.sku) || 0, 0),
    })),
    materials: mat,
    labels: lab,
    shortage_alerts: [
      ...mat.filter((m) => m.shortage).map((m) => ({ kind: 'MATERIAL', ...m })),
      ...lab.filter((l) => l.shortage).map((l) => ({ kind: 'LABEL', ...l })),
    ],
  };
}

/* ------------------------------- 生产实况 ------------------------------- */

/** 老板视图之一：当前生产状态 */
export async function productionView(db, ctx, tid) {
  const now = nowSqlStr();
  const orders = await db.query(
    `SELECT o.id, o.code, o.quantity, o.remaining_qty, o.completed_qty, o.due_date, o.status, o.order_type,
            p.sku AS product_sku, p.name AS product_name, p.unit,
            c.name AS customer_name
     FROM orders o
     JOIN products p ON p.id = o.product_id
     LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.tenant_id = ? AND o.status IN (${OPEN_STATUS.map(() => '?').join(',')})
     ORDER BY o.due_date, o.id`,
    [tid, ...OPEN_STATUS],
  );
  const tasks = await db.query(
    `SELECT t.*, o.code AS order_code, o.due_date, p.name AS product_name, p.sku AS product_sku
     FROM schedule_tasks t
     LEFT JOIN orders o ON o.id = t.order_id
     LEFT JOIN products p ON p.id = o.product_id
     WHERE t.tenant_id = ? AND t.status = 'PLANNED' ORDER BY t.start_at, t.seq`,
    [tid],
  );
  const machines = await db.query(
    'SELECT code, name, status FROM machines WHERE tenant_id = ? ORDER BY code', [tid],
  );
  const outToday = await db.query(
    "SELECT COUNT(*) AS batches, COALESCE(SUM(qty),0) AS qty FROM outbound_records WHERE tenant_id = ? AND created_at >= ?",
    [tid, `${nowSqlStr().slice(0, 10)} 00:00:00`],
  );

  const endById = new Map();
  for (const t of tasks) if (!endById.has(t.order_id)) endById.set(t.order_id, t.end_at);

  const running = tasks.filter((t) => String(t.start_at) <= now && String(t.end_at) >= now);
  const machineStatus = machines.map((m) => {
    const run = running.find((t) => t.machine_code === m.code);
    return {
      machine_code: m.code, machine_name: m.name, status: m.status,
      running: run ? {
        order_code: run.order_code, product_name: run.product_name,
        mold_code: run.mold_code, planned_qty: num(run.planned_qty, 0),
        start_at: run.start_at, end_at: run.end_at,
        progress_pct: progressPct(run.start_at, run.end_at, now),
      } : null,
    };
  });

  const list = orders.map((o) => {
    const end = endById.get(o.id) || null;
    const due = o.due_date ? `${o.due_date} 23:59:59` : null;
    const late = due && end ? toDate(end).getTime() > toDate(due).getTime() : false;
    return {
      order_code: o.code,
      customer_name: o.customer_name,
      product_name: o.product_name,
      product_sku: o.product_sku,
      quantity: num(o.quantity, 0),
      completed_qty: num(o.completed_qty, 0),
      remaining_qty: num(o.remaining_qty, 0),
      progress_pct: num(o.quantity, 0) > 0 ? round((num(o.completed_qty, 0) / num(o.quantity, 0)) * 100, 1) : null,
      due_date: o.due_date,
      planned_end_at: end,
      delay_risk: late,
      status: o.status,
      order_type: o.order_type,
    };
  });

  return {
    summary: {
      open_orders: list.length,
      running_machines: running.length,
      machines_total: machines.length,
      machines_idle: machines.length - running.length,
      delay_risk_orders: list.filter((o) => o.delay_risk).length,
      outbound_today_qty: num(outToday[0]?.qty, 0),
      outbound_today_batches: num(outToday[0]?.batches, 0),
      generated_at: now,
    },
    orders: list,
    machines: machineStatus,
  };
}

/* ------------------------------- 排产计划 ------------------------------- */

/** PMC 视图：排产计划时间轴 */
export async function scheduleView(db, ctx, tid) {
  const now = nowSqlStr();
  const tasks = await db.query(
    `SELECT t.*, o.code AS order_code, o.due_date, o.quantity, o.remaining_qty,
            p.name AS product_name, p.sku AS product_sku, c.name AS customer_name
     FROM schedule_tasks t
     LEFT JOIN orders o ON o.id = t.order_id
     LEFT JOIN products p ON p.id = o.product_id
     LEFT JOIN customers c ON c.id = o.customer_id
     WHERE t.tenant_id = ? AND t.status = 'PLANNED'
     ORDER BY t.start_at, t.seq`,
    [tid],
  );
  const delay = tasks.filter((t) => {
    if (!t.due_date) return false;
    return toDate(t.end_at).getTime() > toDate(`${t.due_date} 23:59:59`).getTime();
  });
  const totalMinutes = tasks.reduce((s, t) => s + num(t.duration_minutes, 0), 0);
  const byMachine = {};
  for (const t of tasks) {
    byMachine[t.machine_code] = (byMachine[t.machine_code] || 0) + num(t.duration_minutes, 0);
  }
  return {
    summary: {
      tasks: tasks.length,
      machines: Object.keys(byMachine).length,
      total_duration_hours: round(totalMinutes / 60, 1),
      changeovers: tasks.filter((t) => t.decision === 'CHANGE_MOLD').length,
      changeover_minutes: tasks.reduce((s, t) => s + num(t.changeover_minutes, 0), 0),
      first_start_at: tasks.length ? tasks[0].start_at : null,
      last_end_at: tasks.length ? tasks[tasks.length - 1].end_at : null,
      delay_risk: delay.length,
      generated_at: now,
    },
    tasks: tasks.map((t) => ({
      seq: num(t.seq, 0),
      machine_code: t.machine_code,
      mold_code: t.mold_code,
      supply_line_code: t.supply_line_code,
      mixer_code: t.mixer_code,
      decision: t.decision,
      order_code: t.order_code,
      customer_name: t.customer_name,
      product_name: t.product_name,
      planned_qty: num(t.planned_qty, 0),
      units_per_hour: num(t.units_per_hour, 0),
      duration_minutes: num(t.duration_minutes, 0),
      changeover_minutes: num(t.changeover_minutes, 0),
      start_at: t.start_at,
      end_at: t.end_at,
      feeding_order_at: t.feeding_order_at,
      feeding_ready_at: t.feeding_ready_at,
      due_date: t.due_date,
      delay_risk: !!t.due_date && toDate(t.end_at).getTime() > toDate(`${t.due_date} 23:59:59`).getTime(),
    })),
    machine_load: Object.entries(byMachine).map(([code, minutes]) => ({
      machine_code: code, planned_minutes: minutes, planned_hours: round(minutes / 60, 1),
    })).sort((a, b) => b.planned_minutes - a.planned_minutes),
  };
}

/* ------------------------------- 配料计划 ------------------------------- */

export async function materialView(db, ctx, tid) {
  const rows = await db.query(
    `SELECT m.*, t.machine_code, t.mold_code, t.start_at AS task_start_at
     FROM material_plans m
     LEFT JOIN schedule_tasks t ON t.id = m.task_id
     WHERE m.tenant_id = ? AND m.status = 'PLANNED'
     ORDER BY m.use_at, m.id`,
    [tid],
  );
  const grouped = {};
  for (const r of rows) {
    const k = `${r.kind}:${r.material_sku}`;
    if (!grouped[k]) {
      grouped[k] = {
        kind: r.kind, sku: r.material_sku, name: r.material_name || r.material_sku,
        unit: r.unit, total_qty: 0, details: [],
      };
    }
    grouped[k].total_qty = round(num(grouped[k].total_qty) + num(r.qty), 3);
    grouped[k].details.push({
      order_code: r.order_code, qty: num(r.qty), use_at: r.use_at,
      mixer_code: r.mixer_code, machine_code: r.machine_code,
    });
  }
  return {
    summary: { items: Object.keys(grouped).length, rows: rows.length },
    items: Object.values(grouped),
  };
}

/* --------------------------------- 订单 --------------------------------- */

export async function ordersView(db, ctx, tid) {
  const rows = await db.query(
    `SELECT o.code, o.quantity, o.remaining_qty, o.completed_qty, o.due_date, o.status, o.order_type, o.created_at,
            p.sku AS product_sku, p.name AS product_name, c.name AS customer_name
     FROM orders o
     JOIN products p ON p.id = o.product_id
     LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.tenant_id = ? ORDER BY o.created_at DESC LIMIT 100`,
    [tid],
  );
  return {
    summary: { total: rows.length, open: rows.filter((r) => OPEN_STATUS.includes(r.status)).length },
    orders: rows,
  };
}

/* ------------------------------- 当班任务 ------------------------------- */

export async function tasksView(db, ctx, tid, user) {
  const now = new Date();
  const hours = num(ctx.config.schedule.shiftHours, 12);
  const rows = await db.query(
    `SELECT t.*, o.code AS order_code, p.name AS product_name, p.sku AS product_sku
     FROM schedule_tasks t
     LEFT JOIN orders o ON o.id = t.order_id
     LEFT JOIN products p ON p.id = o.product_id
     WHERE t.tenant_id = ? AND t.status = 'PLANNED' ORDER BY t.start_at, t.seq`,
    [tid],
  );
  const s = toStr(now);
  const e = toStr(new Date(now.getTime() + hours * 3600000));
  const items = [];
  for (const t of rows) {
    const ts = toDate(t.start_at).getTime();
    const te = toDate(t.end_at).getTime();
    const os = Math.max(ts, now.getTime());
    const oe = Math.min(te, now.getTime() + hours * 3600000);
    if (oe <= os) continue;
    if (user.role === 'PRODUCTION' && user.machine_code && t.machine_code !== user.machine_code) continue;
    const ratio = (oe - os) / (te - ts);
    items.push({
      machine_code: t.machine_code,
      mold_code: t.mold_code,
      order_code: t.order_code,
      product_name: t.product_name,
      product_sku: t.product_sku,
      planned_qty: Math.round(num(t.planned_qty, 0) * ratio),
      window_start: toStr(new Date(os)),
      window_end: toStr(new Date(oe)),
      decision: t.decision,
      changeover_minutes: ts >= now.getTime() ? num(t.changeover_minutes, 0) : 0,
    });
  }
  return { summary: { shift_start: s, shift_end: e, hours, items: items.length }, items };
}

/* -------------------------------- 分发 --------------------------------- */

const BUILDERS = {
  equipment: equipmentView,
  inventory: inventoryView,
  production: productionView,
  schedule: scheduleView,
  material: materialView,
  orders: ordersView,
  tasks: tasksView,
};

export async function buildMpView(db, ctx, { tenantId, view, user }) {
  const fn = BUILDERS[view];
  if (!fn) return null;
  return fn(db, ctx, tenantId, user);
}

export const MP_VIEW_BUILDERS = Object.keys(BUILDERS);
