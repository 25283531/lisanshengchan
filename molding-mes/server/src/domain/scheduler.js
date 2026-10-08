/**
 * 排产引擎（调度协调器）。
 *
 * 判定口径直接移植自「注塑智造运营专家团」，与 E:\code\lisanshengchan 的 CP-SAT 建模一致：
 *  1. 四类资源互斥：机台 / 模具 / 供料线 / 混料机，任一资源不得时间重叠
 *  2. 硬约束：供料线 FAULT → 其关联机台全部视为不可用（最容易漏的一条）
 *  3. 效率三级回退：机台×模具效率 → 机台默认效率 → 不可用（不编造）
 *  4. 换模三态决策：KEEP_CURRENT_MOLD / CHANGE_MOLD / ACTIVATE_IDLE_MACHINE
 *  5. 开工 = max(机台完工, 供料线占用至, 模具释放) + 换模时长 + 30min 缓冲
 *  6. 排序：SALES 先保交期（逾期 → 换模 → 最早完工）；STOCK 先省换模
 *  7. 集中供料时点：换料指令 = 开工 − 60min，备料到位 = 开工 − 30min
 *
 * v3.1 起改为双引擎：
 *  - 优先：CP-SAT 求解器（独立 Python 服务，全局最优）
 *  - 降级：列表调度（list scheduling，贪心启发式，零依赖、可复现）
 * 求解器不可用 / 超时 / 不可行时自动走列表调度，业务层无感知。
 *
 * 接口契约（v3.0 起稳定）：
 *   输入 ctx = { machines, molds, products, supplyLines, mixers, orders, materials, labels, options }
 *   同步返回 { tasks, materialPlans, alerts, unassigned, summary }
 *   异步入口 runSchedulingAsync 优先走求解器，同步入口 runScheduling 永远走列表调度
 */
import { arr, num, toStr, toDate, addMinutes, round } from '../lib/util.js';
import { materialDemand, labelDemand } from './material.js';
import { buildOptions, callOptimizer } from './optimizer-client.js';

const MIN = 60000;

const effOf = (machine, moldCode) => {
  const map = machine.mold_efficiencies || {};
  if (map && typeof map === 'object' && map[moldCode]) return num(map[moldCode], 0);
  return num(machine.units_per_hour, 0);
};

function canMake(machine, product) {
  if (!machine.enabled) return false;
  if (machine.status !== 'AVAILABLE') return false;
  const skus = arr(machine.product_skus);
  if (skus.length && !skus.includes(product.sku)) return false;
  const mCodes = arr(machine.mold_codes).filter(Boolean);
  const pCodes = arr(product.mold_codes).filter(Boolean);
  if (!pCodes.length) return false;
  return mCodes.some((c) => pCodes.includes(c));
}

/**
 * 同步入口：永远走列表调度。用于求解器未启用、调试、demo。
 */
export function runScheduling(ctx) {
  return listSchedule(ctx);
}

/**
 * 异步入口：优先 CP-SAT 求解器，失败降级列表调度。
 */
export async function runSchedulingAsync(ctx, optimizerCfg = {}) {
  const enabled = optimizerCfg.enabled !== false;
  if (enabled && optimizerCfg.url) {
    const result = await scheduleWithOptimizer(ctx, optimizerCfg);
    if (result) {
      result.summary.algorithm = 'cp-sat-v3.1';
      return result;
    }
    // 求解器不可用 / 超时 / 不可行 → 降级
  }
  const fallback = listSchedule(ctx);
  fallback.summary.algorithm = 'list-schedule-fallback';
  return fallback;
}

/**
 * 调用 CP-SAT 求解器，把结果转回统一契约。
 * 失败返回 null。
 */
async function scheduleWithOptimizer(ctx, optimizerCfg) {
  const startFrom = toDate(ctx.options?.startFrom) || new Date();
  const startMs = startFrom.getTime();
  const bufferMin = num(ctx.options?.bufferMinutes, 30);

  const jobs = buildOptions({ ...ctx, options: { ...ctx.options, startFrom: startMs } }, startMs);
  if (!jobs.length) {
    // 没有可排订单，直接走列表调度以拿到 unassigned 原因
    return null;
  }

  const horizonHours = Math.max(1, Math.ceil((num(optimizerCfg.horizonHours, 24 * 30))));
  const payload = {
    jobs,
    machine_busy: [],
    mold_busy: [],
    line_busy: [],
    mixer_busy: [],
    horizon_hours: horizonHours,
    buffer_minutes: bufferMin,
  };

  const r = await callOptimizer(optimizerCfg.url, payload, num(optimizerCfg.timeoutMs, 30000));
  if (!r) return null;

  // 把求解结果映射回 tasks / materialPlans
  const { machines = [], molds = [], products = [], supplyLines = [], mixers = [], orders = [], materials = [], labels = [], options = {} } = ctx;
  const productMap = new Map(products.map((p) => [p.id, p]));
  const moldMap = new Map(molds.map((m) => [m.code, m]));
  const orderMap = new Map(orders.map((o) => [o.code, o]));

  const feedOrderLead = num(options.feedingOrderLeadMinutes, 60);
  const feedReadyLead = num(options.feedingReadyLeadMinutes, 30);

  const tasks = [];
  const materialPlans = [];
  let seq = 0;

  for (const a of r.assignments) {
    const order = orderMap.get(a.job_code);
    if (!order) continue;
    const product = productMap.get(order.product_id);
    if (!product) continue;
    seq += 1;

    const order_map = {
      order_id: order.id,
      seq,
      machine_code: a.machine_code,
      mold_code: a.mold_code,
      supply_line_code: a.supply_line_code,
      mixer_code: a.mixer_code,
      decision: a.setup_minutes > 0 ? 'CHANGE_MOLD' : 'KEEP_CURRENT_MOLD',
      changeover_minutes: a.setup_minutes,
      planned_qty: num(order.remaining_qty, 0) > 0 ? num(order.remaining_qty) : num(order.quantity, 0),
      units_per_hour: num(a.efficiency, 0),
      duration_minutes: a.duration_minutes,
      start_at: a.work_start,
      end_at: a.scheduled_end,
      feeding_order_at: addMinutes(a.work_start, -feedOrderLead),
      feeding_ready_at: addMinutes(a.work_start, -feedReadyLead),
      status: 'PLANNED',
      _order: order,
      _product: product,
    };
    tasks.push(order_map);

    for (const d of materialDemand(product, order_map.planned_qty)) {
      materialPlans.push({
        task_seq: seq,
        order_code: order.code,
        material_sku: d.material_sku,
        kind: 'MATERIAL',
        qty: d.qty,
        unit: 'kg',
        use_at: order_map.start_at,
        mixer_code: order_map.mixer_code,
        status: 'PLANNED',
      });
    }
    for (const d of labelDemand(product, order_map.planned_qty)) {
      materialPlans.push({
        task_seq: seq,
        order_code: order.code,
        material_sku: d.label_sku,
        kind: 'LABEL',
        qty: d.qty,
        unit: '张',
        use_at: order_map.start_at,
        mixer_code: null,
        status: 'PLANNED',
      });
    }
  }

  // 未排产订单：求解器入参里没出现的（产品未建档 / 无可用机台 / 缺效率）
  const assigned = new Set(r.assignments.map((a) => a.job_code));
  const unassigned = orders
    .filter((o) => !assigned.has(o.code))
    .map((o) => ({ order: o, reason: '无可用机台（机台故障/供料线故障/模具不可用/效率未建档）' }));

  return finalize(ctx, {
    tasks,
    materialPlans,
    unassigned,
    extraSummary: {
      algorithm: 'cp-sat-v3.1',
      objective: r.objective,
      solver_status: r.solver_status,
    },
  });
}

/**
 * 列表调度（list scheduling）：贪心启发式，零依赖、可复现。
 * 作为求解器不可用时的兜底，也用于调试与小规模场景。
 */
function listSchedule(ctx) {
  const {
    machines = [], molds = [], products = [], supplyLines = [],
    mixers = [], orders = [], materials = [], labels = [], options = {},
  } = ctx;

  const bufferMin = num(options.bufferMinutes, 30);
  const feedOrderLead = num(options.feedingOrderLeadMinutes, 60);
  const feedReadyLead = num(options.feedingReadyLeadMinutes, 30);
  const startFrom = toDate(options.startFrom) || new Date();
  const startMs = startFrom.getTime();

  const moldMap = new Map(molds.map((m) => [m.code, m]));
  const productMap = new Map(products.map((p) => [p.id, p]));
  const lineMap = new Map(supplyLines.map((l) => [l.code, l]));

  // 供料线故障 → 关联机台全部封锁（硬约束）
  const blockedMachines = new Set();
  for (const line of supplyLines) {
    if (line.status !== 'AVAILABLE') {
      for (const mc of arr(line.machine_codes)) blockedMachines.add(mc);
    }
    if (line.status === 'FAULT') {
      // 双向绑定兜底：机台侧登记了该线的也一并封锁
      for (const m of machines) if (m.supply_line_code === line.code && m.feeding_mode === 'CENTRALIZED') blockedMachines.add(m.code);
    }
  }

  const state = {
    machineFreeAt: new Map(),
    machineMold: new Map(),
    machineTasks: new Map(),
    moldFreeAt: new Map(),
    lineFreeAt: new Map(),
    mixerFreeAt: new Map(),
  };
  for (const m of machines) {
    state.machineFreeAt.set(m.code, startMs);
    state.machineMold.set(m.code, m.current_mold_code || null);
    state.machineTasks.set(m.code, 0);
  }
  for (const line of supplyLines) {
    state.lineFreeAt.set(line.code, Math.max(startMs, toDate(line.occupied_until)?.getTime() || 0));
  }
  for (const mix of mixers) {
    state.mixerFreeAt.set(mix.code, Math.max(startMs, toDate(mix.occupied_until)?.getTime() || 0));
  }

  // ---- 订单排序 ----
  const eligible = orders
    .filter((o) => ['DRAFT', 'SCHEDULED', 'RUNNING'].includes(o.status))
    .map((o) => ({ ...o, _qty: num(o.remaining_qty, 0) > 0 ? num(o.remaining_qty) : num(o.quantity, 0) }))
    .filter((o) => o._qty > 0);

  const dueMs = (o) => (o.due_date ? toDate(`${o.due_date} 23:59:59`)?.getTime() || Infinity : Infinity);
  const moldKey = (o) => arr(productMap.get(o.product_id)?.mold_codes)[0] || '';

  const sorted = [...eligible].sort((a, b) => {
    if (a.order_type !== b.order_type) return a.order_type === 'SALES' ? -1 : 1;
    if (a.order_type === 'SALES') {
      const d = dueMs(a) - dueMs(b);
      if (d) return d;
      return num(b.priority_score) - num(a.priority_score) || a._qty - b._qty;
    }
    // STOCK：同模具聚批，省换模
    const mk = moldKey(a).localeCompare(moldKey(b));
    if (mk) return mk;
    return dueMs(a) - dueMs(b);
  });

  const tasks = [];
  const materialPlans = [];
  const unassigned = [];

  let seq = 0;
  for (const order of sorted) {
    const product = productMap.get(order.product_id);
    const qty = order._qty;
    if (!product) { unassigned.push({ order, reason: '产品不存在或未建档' }); continue; }

    const pMolds = arr(product.mold_codes).filter(Boolean);
    let best = null;

    for (const m of machines) {
      if (blockedMachines.has(m.code)) continue;
      if (!canMake(m, product)) continue;

      // 集中供料机台必须有可用供料线
      let line = null;
      if (m.feeding_mode === 'CENTRALIZED') {
        line = lineMap.get(m.supply_line_code);
        if (!line || line.status !== 'AVAILABLE') continue;
      }

      const availMolds = pMolds.filter((c) => {
        const md = moldMap.get(c);
        if (!md) return false;
        if (md.status === 'RETIRED') return false;
        return arr(m.mold_codes).includes(c);
      });
      if (!availMolds.length) continue;

      const cur = state.machineMold.get(m.code);
      let targetMold = availMolds.includes(cur) ? cur : null;
      if (!targetMold) {
        targetMold = availMolds.reduce((a, b) => (effOf(m, b) > effOf(m, a) ? b : a));
      }
      const mold = moldMap.get(targetMold);
      if (mold && mold.status === 'MAINTENANCE') continue;

      const eff = effOf(m, targetMold);
      if (eff <= 0) continue; // 效率未实测且无默认 → 不编造，跳过

      const changeover = cur === targetMold ? 0 : num(m.mold_change_minutes, 0);
      const ready = Math.max(
        state.machineFreeAt.get(m.code) || startMs,
        line ? state.lineFreeAt.get(line.code) || startMs : 0,
        state.moldFreeAt.get(targetMold) || 0,
        startMs,
      );
      const startMsT = ready + changeover * MIN + bufferMin * MIN;
      const durationMin = Math.ceil((qty / eff) * 60);
      const endMsT = startMsT + durationMin * MIN;

      const idleBefore = (state.machineTasks.get(m.code) || 0) === 0;
      let decision;
      if (cur === targetMold) {
        decision = idleBefore ? 'ACTIVATE_IDLE_MACHINE' : 'KEEP_CURRENT_MOLD';
      } else {
        decision = 'CHANGE_MOLD';
      }

      const cand = {
        machine: m, mold: targetMold, line, eff, changeover,
        startMs: startMsT, endMs: endMsT, durationMin, decision,
      };
      if (!best
        || cand.endMs < best.endMs
        || (cand.endMs === best.endMs && cand.changeover < best.changeover)
        || (cand.endMs === best.endMs && cand.changeover === best.changeover && cand.eff > best.eff)) {
        best = cand;
      }
    }

    if (!best) {
      unassigned.push({ order, reason: '无可用机台（机台故障/供料线故障/模具不可用/效率未建档）' });
      continue;
    }

    const { machine: m, mold: targetMold, line, eff, changeover, startMs: s, endMs: e, durationMin, decision } = best;
    const startAt = toStr(new Date(s));
    const endAt = toStr(new Date(e));
    const mixerCode = m.mixer_code || line?.mixer_code || null;

    seq += 1;
    const task = {
      order_id: order.id,
      seq,
      machine_code: m.code,
      mold_code: targetMold,
      supply_line_code: line?.code || null,
      mixer_code: mixerCode,
      decision,
      changeover_minutes: changeover,
      planned_qty: qty,
      units_per_hour: eff,
      duration_minutes: durationMin,
      start_at: startAt,
      end_at: endAt,
      feeding_order_at: addMinutes(startAt, -feedOrderLead),
      feeding_ready_at: addMinutes(startAt, -feedReadyLead),
      status: 'PLANNED',
      _order: order,
      _product: product,
    };
    tasks.push(task);

    // 资源占用推进
    state.machineFreeAt.set(m.code, e);
    state.machineMold.set(m.code, targetMold);
    state.machineTasks.set(m.code, (state.machineTasks.get(m.code) || 0) + 1);
    state.moldFreeAt.set(targetMold, e);
    if (line) state.lineFreeAt.set(line.code, e);
    if (mixerCode) state.mixerFreeAt.set(mixerCode, e);

    // 物料计划
    for (const d of materialDemand(product, qty)) {
      materialPlans.push({
        task_seq: seq,
        order_code: order.code,
        material_sku: d.material_sku,
        kind: 'MATERIAL',
        qty: d.qty,
        unit: 'kg',
        use_at: startAt,
        mixer_code: mixerCode,
        status: 'PLANNED',
      });
    }
    for (const d of labelDemand(product, qty)) {
      materialPlans.push({
        task_seq: seq,
        order_code: order.code,
        material_sku: d.label_sku,
        kind: 'LABEL',
        qty: d.qty,
        unit: '张',
        use_at: startAt,
        mixer_code: null,
        status: 'PLANNED',
      });
    }
  }

  /* ------------------------------ 告警生成 ------------------------------ */

  const alerts = [];

  // 模具保养：累计模次 + 本次模次 ≥ 阈值
  const shotsByMold = new Map();
  for (const t of tasks) {
    const mold = moldMap.get(t.mold_code);
    const cavities = Math.max(1, num(mold?.cavities, 1));
    shotsByMold.set(t.mold_code, (shotsByMold.get(t.mold_code) || 0) + Math.ceil(t.planned_qty / cavities));
  }
  for (const [code, addShots] of shotsByMold) {
    const mold = moldMap.get(code);
    if (!mold) continue;
    const cum = num(mold.cumulative_shots, 0) + addShots;
    const threshold = num(mold.maintenance_at_shots, 0);
    if (threshold > 0 && cum >= threshold) {
      alerts.push({
        type: 'MOLD_MAINTENANCE', level: 'WARN',
        title: `模具 ${code} 达保养阈值`,
        body: `累计模次 ${cum} / 阈值 ${threshold}，本次排产将增加 ${addShots} 模次，建议安排保养。`,
        payload: { mold_code: code, cumulative_shots: cum, threshold },
      });
    }
  }

  // 换模提醒（技术员）
  for (const t of tasks) {
    if (t.decision === 'CHANGE_MOLD') {
      alerts.push({
        type: 'MOLD_CHANGE', level: 'INFO',
        title: `机台 ${t.machine_code} 换模：→ ${t.mold_code}`,
        body: `换模 ${t.changeover_minutes} 分钟，计划 ${t.start_at} 开工。`,
        payload: { machine_code: t.machine_code, mold_code: t.mold_code, start_at: t.start_at, minutes: t.changeover_minutes },
      });
    }
  }

  // 缺料 / 缺标签
  const agg = new Map();
  for (const p of materialPlans) {
    const k = `${p.kind}:${p.material_sku}`;
    const cur = agg.get(k) || { kind: p.kind, sku: p.material_sku, qty: 0, use_at: p.use_at };
    cur.qty += num(p.qty, 0);
    if (toDate(p.use_at) < toDate(cur.use_at)) cur.use_at = p.use_at;
    agg.set(k, cur);
  }
  for (const { kind, sku, qty, use_at } of agg.values()) {
    const inv = kind === 'LABEL' ? labels.find((l) => l.sku === sku) : materials.find((m) => m.sku === sku);
    if (!inv) {
      alerts.push({
        type: kind === 'LABEL' ? 'LABEL_SHORTAGE' : 'MATERIAL_SHORTAGE', level: 'ERROR',
        title: `${kind === 'LABEL' ? '标签' : '原料'} ${sku} 未建档`,
        body: `排产需求 ${round(qty, 2)}，但台账中无此${kind === 'LABEL' ? '标签' : '原料'}，无法判定齐套。`,
        payload: { sku, qty: round(qty, 2), use_at },
      });
      continue;
    }
    const available = Math.max(0, num(inv.stock_qty, 0) - num(inv.reserved_qty, 0) - num(inv.safety_stock, 0));
    const shortage = round(qty - available, 2);
    if (shortage > 0) {
      alerts.push({
        type: kind === 'LABEL' ? 'LABEL_SHORTAGE' : 'MATERIAL_SHORTAGE', level: 'ERROR',
        title: `${kind === 'LABEL' ? '标签' : '原料'} ${inv.name || sku} 缺口 ${shortage}${kind === 'LABEL' ? '张' : 'kg'}`,
        body: `预计 ${use_at} 使用，需求 ${round(qty, 2)}，可用 ${round(available, 2)}（已扣安全库存），采购提前期 ${num(inv.lead_time_days, 0)} 天。`,
        payload: { sku, qty: round(qty, 2), available: round(available, 2), shortage, use_at, lead_time_days: num(inv.lead_time_days, 0) },
      });
    }
  }

  // 交期风险
  for (const t of tasks) {
    const o = t._order;
    if (!o.due_date) continue;
    const due = toDate(`${o.due_date} 23:59:59`);
    if (!due) continue;
    const lateMs = t.endMs - due.getTime();
    if (lateMs > 0) {
      const lateHours = round(lateMs / 3600000, 1);
      alerts.push({
        type: 'DELAY_RISK', level: 'WARN',
        title: `订单 ${o.code} 预计逾期 ${round(lateHours / 24, 1)} 天`,
        body: `交期 ${o.due_date}，排产完工 ${t.end_at.slice(0, 16)}。`,
        payload: { order_code: o.code, due_date: o.due_date, end_at: t.end_at, late_hours: lateHours },
      });
    }
  }

  // 机台故障（信息）
  for (const m of machines) {
    if (m.status !== 'AVAILABLE') {
      alerts.push({
        type: 'MACHINE_FAULT', level: 'WARN',
        title: `机台 ${m.code} 状态 ${m.status}`,
        body: `${m.name || m.code} 当前不可排产。`,
        payload: { machine_code: m.code, status: m.status },
      });
    }
  }

  const makespanMs = tasks.length ? Math.max(...tasks.map((t) => t.endMs)) - startMs : 0;
  const summary = {
    orders_total: eligible.length,
    orders_scheduled: tasks.length,
    orders_unassigned: unassigned.length,
    total_changeover_minutes: tasks.reduce((s, t) => s + num(t.changeover_minutes, 0), 0),
    total_duration_minutes: tasks.reduce((s, t) => s + num(t.duration_minutes, 0), 0),
    makespan_hours: round(makespanMs / 3600000, 1),
    start_at: toStr(startFrom),
    end_at: tasks.length ? toStr(new Date(Math.max(...tasks.map((t) => t.endMs)))) : null,
    alerts: alerts.length,
    algorithm: 'list-schedule',
  };

  return finalize(ctx, { tasks, materialPlans, alerts, unassigned, summary });
}

/**
 * 统一收尾：补全告警（缺料/换模/保养/逾期/故障），返回最终结果。
 * listSchedule 已自带告警；scheduleWithOptimizer 调用此函数补全告警。
 */
function finalize(ctx, partial) {
  const { tasks } = partial;
  const extraSummary = partial.extraSummary || { algorithm: 'list-schedule' };

  // listSchedule 已生成告警；求解器路径不生成，这里补
  if (!partial.alerts || partial.alerts.length === 0) {
    // 这里复用 listSchedule 的告警生成逻辑不现实，用简化版
    const alerts = [];
    const moldMap = new Map((ctx.molds || []).map((m) => [m.code, m]));
    const shotsByMold = new Map();
    for (const t of tasks) {
      const mold = moldMap.get(t.mold_code);
      const cavities = Math.max(1, num(mold?.cavities, 1));
      shotsByMold.set(t.mold_code, (shotsByMold.get(t.mold_code) || 0) + Math.ceil(t.planned_qty / cavities));
    }
    for (const [code, addShots] of shotsByMold) {
      const mold = moldMap.get(code);
      if (!mold) continue;
      const cum = num(mold.cumulative_shots, 0) + addShots;
      const threshold = num(mold.maintenance_at_shots, 0);
      if (threshold > 0 && cum >= threshold) {
        alerts.push({ type: 'MOLD_MAINTENANCE', level: 'WARN', title: `模具 ${code} 达保养阈值`, body: `累计模次 ${cum} / 阈值 ${threshold}，本次排产将增加 ${addShots} 模次。`, payload: { mold_code: code, cumulative_shots: cum, threshold } });
      }
    }
    for (const t of tasks) {
      if (t.decision === 'CHANGE_MOLD') {
        alerts.push({ type: 'MOLD_CHANGE', level: 'INFO', title: `机台 ${t.machine_code} 换模：→ ${t.mold_code}`, body: `换模 ${t.changeover_minutes} 分钟，计划 ${t.start_at} 开工。`, payload: { machine_code: t.machine_code, mold_code: t.mold_code, start_at: t.start_at } });
      }
      const o = t._order;
      if (o?.due_date) {
        const due = toDate(`${o.due_date} 23:59:59`);
        const lateMs = toDate(t.end_at).getTime() - due.getTime();
        if (lateMs > 0) {
          alerts.push({ type: 'DELAY_RISK', level: 'WARN', title: `订单 ${o.code} 预计逾期 ${round(lateMs / 86400000, 1)} 天`, body: `交期 ${o.due_date}，排产完工 ${t.end_at.slice(0, 16)}。`, payload: { order_code: o.code, due_date: o.due_date, end_at: t.end_at } });
        }
      }
    }
    partial.alerts = alerts;
  }

  const summary = partial.summary || {
    orders_total: 0,
    orders_scheduled: tasks.length,
    orders_unassigned: (partial.unassigned || []).length,
    total_changeover_minutes: tasks.reduce((s, t) => s + num(t.changeover_minutes, 0), 0),
    total_duration_minutes: tasks.reduce((s, t) => s + num(t.duration_minutes, 0), 0),
    makespan_hours: 0,
    start_at: null,
    end_at: tasks.length ? tasks[tasks.length - 1].end_at : null,
    alerts: (partial.alerts || []).length,
    algorithm: extraSummary.algorithm,
    ...extraSummary,
  };
  Object.assign(summary, extraSummary);

  return {
    tasks,
    materialPlans: partial.materialPlans || [],
    alerts: partial.alerts || [],
    unassigned: partial.unassigned || [],
    summary,
  };
}

/**
 * 当班计划：把排产任务按班次窗口切分，得到每个机台本班应产的产品与数量。
 * 跨班次的任务按时间重叠比例折算数量。
 */
export function shiftPlan(tasks, shiftStart, hours = 12) {
  const s = toDate(shiftStart).getTime();
  const e = s + hours * 3600000;
  const rows = [];
  for (const t of tasks) {
    const ts = toDate(t.start_at).getTime();
    const te = toDate(t.end_at).getTime();
    const os = Math.max(ts, s);
    const oe = Math.min(te, e);
    if (oe <= os) continue;
    const ratio = (oe - os) / (te - ts);
    rows.push({
      machine_code: t.machine_code,
      mold_code: t.mold_code,
      order_code: t._order?.code || null,
      product_name: t._product?.name || null,
      product_sku: t._product?.sku || null,
      spec: t._product?.spec || t._product?.name || null,
      planned_qty: Math.round(num(t.planned_qty, 0) * ratio),
      window_start: toStr(new Date(os)),
      window_end: toStr(new Date(oe)),
      decision: t.decision,
      changeover_minutes: ts >= s ? num(t.changeover_minutes, 0) : 0,
    });
  }
  return rows;
}
