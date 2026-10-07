/**
 * 求解器客户端：把 molding-mes 的主数据 + 订单转成 CP-SAT 服务的入参，
 * 调用 optimizer HTTP 服务，返回求解结果。
 *
 * 失败（连不上 / 超时 / 不可行）一律返回 null，由 scheduler.js 决定是否降级。
 */
import { arr, num, toDate } from '../lib/util.js';

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
 * 为每张订单展开候选资源选项。
 * 每个 option 已预算好 setup_minutes（换模时长）、duration_minutes（净生产时长）、
 * ready_from_minutes（资源最早可用时刻，epoch 分钟）。
 */
export function buildOptions(ctx, epochMs) {
  const { machines = [], molds = [], products = [], supplyLines = [], mixers = [], orders = [], options = {} } = ctx;
  const bufferMin = num(options.bufferMinutes, 30);

  const moldMap = new Map(molds.map((m) => [m.code, m]));
  const lineMap = new Map(supplyLines.map((l) => [l.code, l]));

  const blocked = new Set();
  for (const line of supplyLines) {
    if (line.status !== 'AVAILABLE') for (const mc of arr(line.machine_codes)) blocked.add(mc);
    if (line.status === 'FAULT')
      for (const m of machines)
        if (m.supply_line_code === line.code && m.feeding_mode === 'CENTRALIZED') blocked.add(m.code);
  }

  const machineFreeMin = new Map(machines.map((m) => [m.code, Math.max(0, Math.round((toDate(m.occupied_until)?.getTime() || epochMs) - epochMs) / MIN)]));
  const moldFreeMin = new Map(molds.map((m) => [m.code, Math.max(0, Math.round((toDate(m.occupied_until)?.getTime() || epochMs) - epochMs) / MIN)]));
  const lineFreeMin = new Map(supplyLines.map((l) => [l.code, Math.max(0, Math.round((toDate(l.occupied_until)?.getTime() || epochMs) - epochMs) / MIN)]));
  const mixerFreeMin = new Map(mixers.map((m) => [m.code, Math.max(0, Math.round((toDate(m.occupied_until)?.getTime() || epochMs) - epochMs) / MIN)]));

  const jobs = [];
  const productMap = new Map(products.map((p) => [p.id, p]));

  for (const order of orders) {
    const product = productMap.get(order.product_id);
    if (!product) continue;
    const qty = num(order.remaining_qty, 0) > 0 ? num(order.remaining_qty) : num(order.quantity, 0);
    if (qty <= 0) continue;

    const opts = [];
    for (const m of machines) {
      if (blocked.has(m.code)) continue;
      if (!canMake(m, product)) continue;

      let line = null;
      if (m.feeding_mode === 'CENTRALIZED') {
        line = lineMap.get(m.supply_line_code);
        if (!line || line.status !== 'AVAILABLE') continue;
      }

      const pMolds = arr(product.mold_codes).filter(Boolean);
      const availMolds = pMolds.filter((c) => {
        const md = moldMap.get(c);
        if (!md) return false;
        if (md.status === 'RETIRED') return false;
        return arr(m.mold_codes).includes(c);
      });
      if (!availMolds.length) continue;

      const cur = m.current_mold_code || null;
      let targetMold = availMolds.includes(cur) ? cur : null;

      // 每个候选模具生成一个 option，让 CP-SAT 在多机多模具间选全局最优
      for (const moldCode of availMolds) {
        const mold = moldMap.get(moldCode);
        if (!mold || mold.status === 'MAINTENANCE') continue;

        const eff = effOf(m, moldCode);
        if (eff <= 0) continue;

        const changeover = moldCode === cur ? 0 : num(m.mold_change_minutes, 0);
        const duration = Math.ceil((qty / eff) * 60);

        const ready = Math.max(
          machineFreeMin.get(m.code) || 0,
          line ? lineFreeMin.get(line.code) || 0 : 0,
          moldFreeMin.get(moldCode) || 0,
        );

        opts.push({
          machine_code: m.code,
          supply_line_code: line?.code || null,
          mixer_code: m.mixer_code || line?.mixer_code || null,
          mold_code: moldCode,
          duration_minutes: duration,
          setup_minutes: changeover,
          ready_from_minutes: ready,
          efficiency: eff,
        });
      }
    }

    if (!opts.length) continue;
    jobs.push({
      code: order.code,
      quantity: qty,
      order_type: order.order_type || 'SALES',
      due_date: order.due_date ? `${order.due_date}T23:59:59` : null,
      priority: num(order.priority_score, 0),
      options: opts,
    });
  }
  return jobs;
}

/**
 * 调用 CP-SAT 求解器。
 * @returns {Promise<{feasible, assignments, algorithm, objective, solver_status}|null>}
 */
export async function callOptimizer(url, payload, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/optimize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const json = await res.json();
    return json?.feasible ? json : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}