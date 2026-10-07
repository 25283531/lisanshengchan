/**
 * 基础数据（主数据）：客户 / 原料 / 标签 / 模具 / 机台 / 供料线 / 混料机 / 产品。
 * 采用同一套通用 CRUD，减少重复代码；JSON 列自动序列化。
 * 另提供 onboardingReport：告诉管理员「还缺什么、缺了就不能干什么」。
 */
import { wrap, ok, fail, AppError } from '../lib/http.js';
import { nowStr, arr, num } from '../lib/util.js';
import { findAll, findOne, insertRow, updateRow, deleteRow, audit, loadTenantData, normalizeData } from '../lib/repo.js';
import { requirePerm } from '../middleware.js';

export const RESOURCES = {
  customers: { table: 'customers', json: ['aliases'], zh: '客户', orderBy: 'code' },
  materials: { table: 'materials', json: [], zh: '原料', orderBy: 'sku' },
  labels: { table: 'labels', json: [], zh: '标签', orderBy: 'sku' },
  molds: { table: 'molds', json: [], zh: '模具', orderBy: 'code' },
  machines: { table: 'machines', json: ['product_skus', 'mold_codes', 'mold_efficiencies'], zh: '机台', orderBy: 'code' },
  supply_lines: { table: 'supply_lines', json: ['machine_codes'], zh: '供料线', orderBy: 'code' },
  mixers: { table: 'mixers', json: [], zh: '混料机', orderBy: 'code' },
  products: { table: 'products', json: ['aliases', 'label_skus', 'recipe', 'mold_codes'], zh: '产品', orderBy: 'sku' },
};

const defaultsFor = (res, body) => {
  const now = nowStr();
  if (res === 'machines') {
    return { status: 'AVAILABLE', mold_change_minutes: 45, feeding_mode: 'HOPPER', enabled: 1, units_per_hour: 0, updated_at: now, ...body };
  }
  if (res === 'molds') return { status: 'AVAILABLE', cavities: 1, cumulative_shots: 0, maintenance_at_shots: 100000, updated_at: now, ...body };
  if (res === 'products') return { loss_rate: 3, unit: '个', needs_label: 0, labels_per_unit: 1, label_waste_rate: 2, finished_stock_qty: 0, enabled: 1, updated_at: now, ...body };
  if (res === 'materials') return { unit: 'kg', stock_qty: 0, safety_stock: 0, reserved_qty: 0, lead_time_days: 3, enabled: 1, updated_at: now, ...body };
  if (res === 'labels') return { unit: '张', stock_qty: 0, safety_stock: 0, lead_time_days: 5, enabled: 1, updated_at: now, ...body };
  if (res === 'supply_lines') return { status: 'AVAILABLE', min_changeover_minutes: 60, enabled: 1, updated_at: now, ...body };
  if (res === 'mixers') return { status: 'AVAILABLE', capacity_kg: 0, enabled: 1, updated_at: now, ...body };
  if (res === 'customers') return { enabled: 1, created_at: now, ...body };
  return { ...body };
};

async function validateResource(db, res, body, tenantId) {
  if (res === 'machines') {
    if (body.feeding_mode === 'CENTRALIZED' && !body.supply_line_code) {
      throw new AppError('集中供料机台必须指定供料线编号（supply_line_code）', 400, 'NEED_SUPPLY_LINE');
    }
    if (body.feeding_mode === 'CENTRALIZED' && body.supply_line_code) {
      const line = await db.get('SELECT id FROM supply_lines WHERE tenant_id = ? AND code = ?', [tenantId, body.supply_line_code]);
      if (!line) throw new AppError(`供料线 ${body.supply_line_code} 不存在，请先建档供料线`, 400, 'LINE_NOT_FOUND');
    }
  }
  if (res === 'products' && body.needs_label && !arr(body.label_skus).length) {
    throw new AppError('该产品需要贴标，但未绑定标签 SKU（label_skus）', 400, 'NEED_LABEL');
  }
}

export default function registerMasterRoutes(app, db, ctx) {
  /** 一次性取全部主数据（安卓端可缓存） */
  app.get('/api/master', wrap(async (req) => {
    const user = requirePerm(req, 'master.read');
    const data = normalizeData(await loadTenantData(db, user.tenant_id));
    return ok(data);
  }));

  app.get('/api/master/:res', wrap(async (req) => {
    const user = requirePerm(req, 'master.read');
    const cfg = RESOURCES[req.params.res];
    if (!cfg) return fail(`未知资源：${req.params.res}`, 'NOT_FOUND', 404);
    const rows = await findAll(db, cfg.table, {
      tenantId: user.tenant_id, jsonFields: cfg.json, orderBy: cfg.orderBy,
    });
    return ok(rows);
  }));

  app.post('/api/master/:res', wrap(async (req) => {
    const user = requirePerm(req, 'master.write');
    const cfg = RESOURCES[req.params.res];
    if (!cfg) return fail(`未知资源：${req.params.res}`, 'NOT_FOUND', 404);
    const body = defaultsFor(req.params.res, { ...(req.body || {}) });
    await validateResource(db, req.params.res, body, user.tenant_id);
    const id = await insertRow(db, cfg.table, body, { tenantId: user.tenant_id, jsonFields: cfg.json });
    await audit(db, { tenantId: user.tenant_id, userId: user.id, action: `master.${req.params.res}.create`, detail: { id, ...body } });
    return ok({ id }, `${cfg.zh}已新增`);
  }));

  /** 批量导入：建档期一次性录入多条 */
  app.post('/api/master/:res/bulk', wrap(async (req) => {
    const user = requirePerm(req, 'master.write');
    const cfg = RESOURCES[req.params.res];
    if (!cfg) return fail(`未知资源：${req.params.res}`, 'NOT_FOUND', 404);
    const items = arr((req.body || {}).items);
    if (!items.length) return fail('items 不能为空', 'PARAM_MISSING', 400);
    const ids = [];
    await db.transaction(async () => {
      for (const it of items) {
        const body = defaultsFor(req.params.res, { ...it });
        ids.push(await insertRow(db, cfg.table, body, { tenantId: user.tenant_id, jsonFields: cfg.json }));
      }
    });
    await audit(db, { tenantId: user.tenant_id, userId: user.id, action: `master.${req.params.res}.bulk`, detail: { count: ids.length } });
    return ok({ ids }, `已导入 ${ids.length} 条${cfg.zh}`);
  }));

  app.put('/api/master/:res/:id', wrap(async (req) => {
    const user = requirePerm(req, 'master.write');
    const cfg = RESOURCES[req.params.res];
    if (!cfg) return fail(`未知资源：${req.params.res}`, 'NOT_FOUND', 404);
    const id = Number(req.params.id);
    const patch = { ...(req.body || {}), updated_at: nowStr() };
    await validateResource(db, req.params.res, patch, user.tenant_id);
    const n = await updateRow(db, cfg.table, id, patch, { tenantId: user.tenant_id, jsonFields: cfg.json });
    if (!n) return fail('记录不存在或无变更', 'NOT_FOUND', 404);
    await audit(db, { tenantId: user.tenant_id, userId: user.id, action: `master.${req.params.res}.update`, detail: { id, ...patch } });
    return ok(null, '已更新');
  }));

  /** 清空某一类主数据（建档重置用，谨慎） */
  app.delete('/api/master/:res/clear', wrap(async (req) => {
    const user = requirePerm(req, 'master.write');
    const cfg = RESOURCES[req.params.res];
    if (!cfg) return fail(`未知资源：${req.params.res}`, 'NOT_FOUND', 404);
    const r = await db.run(`DELETE FROM \`${cfg.table}\` WHERE tenant_id = ?`, [user.tenant_id]);
    await audit(db, { tenantId: user.tenant_id, userId: user.id, action: `master.${req.params.res}.clear`, detail: { deleted: Number(r.changes) } });
    return ok({ deleted: Number(r.changes) }, `已清空${cfg.zh} ${r.changes} 条`);
  }));

  app.delete('/api/master/:res/:id', wrap(async (req) => {
    const user = requirePerm(req, 'master.write');
    const cfg = RESOURCES[req.params.res];
    if (!cfg) return fail(`未知资源：${req.params.res}`, 'NOT_FOUND', 404);
    const n = await deleteRow(db, cfg.table, Number(req.params.id), { tenantId: user.tenant_id });
    if (!n) return fail('记录不存在', 'NOT_FOUND', 404);
    await audit(db, { tenantId: user.tenant_id, userId: user.id, action: `master.${req.params.res}.delete`, detail: { id: Number(req.params.id) } });
    return ok(null, '已删除');
  }));

  /** 建档完成度：缺什么、缺了影响什么 */
  app.get('/api/master/onboarding', wrap(async (req) => {
    const user = requirePerm(req, 'master.read');
    return ok(await onboardingReport(db, user.tenant_id));
  }));
}

/**
 * 建档完成度报告（对应专家团 Stage A~E）。
 * @returns {{stage:string, ready:boolean, completeness:number, groups:Array}}
 */
export async function onboardingReport(db, tenantId) {
  const d = normalizeData(await loadTenantData(db, tenantId));
  const g = [];

  // Stage A：机台与供料线
  const noMold = d.machines.filter((m) => !arr(m.mold_codes).length).map((m) => m.code);
  const central = d.machines.filter((m) => m.feeding_mode === 'CENTRALIZED');
  const noLine = central.filter((m) => !m.supply_line_code).map((m) => m.code);
  const noEff = d.machines.filter((m) => !num(m.units_per_hour, 0) && !Object.keys(m.mold_efficiencies || {}).length).map((m) => m.code);
  g.push({
    stage: 'A', title: '机台与供料方式',
    items: [
      { label: '机台已建档', done: d.machines.length > 0, detail: d.machines.length ? `${d.machines.length} 台` : '尚未录入', required: true },
      { label: '每台机可用模具编号', done: !noMold.length, detail: noMold.length ? `缺失：${noMold.join('、')}` : '已登记', required: true, applicable: d.machines.length > 0 },
      { label: '机台供料方式', done: d.machines.every((m) => m.feeding_mode), detail: `${central.length} 台集中供料`, required: true, applicable: d.machines.length > 0 },
      { label: '集中供料机台已绑供料线', done: !noLine.length, detail: noLine.length ? `未绑定：${noLine.join('、')}` : '已绑定', required: central.length > 0 },
      { label: '机台效率（件/小时）', done: !noEff.length, detail: noEff.length ? `缺失：${noEff.join('、')}` : '已登记', required: true, applicable: d.machines.length > 0 },
      { label: '供料线已建档', done: d.supplyLines.length > 0, detail: d.supplyLines.length ? `${d.supplyLines.length} 条` : '未使用集中供料则可选', required: central.length > 0 },
    ],
  });

  // Stage B：模具
  const noCav = d.molds.filter((m) => !num(m.cavities, 0)).map((m) => m.code);
  g.push({
    stage: 'B', title: '模具',
    items: [
      { label: '模具已建档', done: d.molds.length > 0, detail: d.molds.length ? `${d.molds.length} 副` : '尚未录入', required: true },
      { label: '模具穴数', done: !noCav.length, detail: noCav.length ? `缺失：${noCav.join('、')}` : '已登记', required: true, applicable: d.molds.length > 0 },
      { label: '保养阈值模次', done: d.molds.every((m) => num(m.maintenance_at_shots, 0) > 0), detail: '用于触发保养提醒', required: false, applicable: d.molds.length > 0 },
    ],
  });

  // Stage C：产品与标签
  const noRecipe = d.products.filter((p) => !arr(p.recipe).length).map((p) => p.sku);
  const noProductMold = d.products.filter((p) => !arr(p.mold_codes).length).map((p) => p.sku);
  const labelled = d.products.filter((p) => p.needs_label);
  const noLabelBind = labelled.filter((p) => !arr(p.label_skus).length).map((p) => p.sku);
  g.push({
    stage: 'C', title: '产品与标签',
    items: [
      { label: '产品已建档', done: d.products.length > 0, detail: d.products.length ? `${d.products.length} 个` : '尚未录入', required: true },
      { label: '产品配方（克重）', done: !noRecipe.length, detail: noRecipe.length ? `缺失：${noRecipe.join('、')}` : '已登记', required: true, applicable: d.products.length > 0 },
      { label: '产品可用模具', done: !noProductMold.length, detail: noProductMold.length ? `缺失：${noProductMold.join('、')}` : '已登记', required: true, applicable: d.products.length > 0 },
      { label: '贴标产品已绑标签', done: !noLabelBind.length, detail: noLabelBind.length ? `缺失：${noLabelBind.join('、')}` : `${labelled.length} 个已绑定`, required: labelled.length > 0 },
      { label: '标签台账（品类/库存张数）', done: d.labels.length > 0, detail: d.labels.length ? `${d.labels.length} 种` : '尚无标签台账', required: labelled.length > 0 },
    ],
  });

  // Stage D：原料
  g.push({
    stage: 'D', title: '原料库存',
    items: [
      { label: '原料已建档', done: d.materials.length > 0, detail: d.materials.length ? `${d.materials.length} 种` : '尚未录入', required: true },
      { label: '原料库存与安全库存', done: d.materials.every((m) => num(m.stock_qty, 0) > 0 || num(m.safety_stock, 0) > 0), detail: '用于齐套与缺料预警', required: true, applicable: d.materials.length > 0 },
    ],
  });

  // Stage E：效率矩阵
  const missingPairs = [];
  for (const m of d.machines) {
    for (const mc of arr(m.mold_codes)) {
      if (!num(m.mold_efficiencies?.[mc], 0)) missingPairs.push(`${m.code}×${mc}`);
    }
  }
  g.push({
    stage: 'E', title: '机台×模具效率矩阵',
    items: [
      {
        label: '逐组合效率（件/小时）', done: !missingPairs.length,
        detail: missingPairs.length ? `缺失 ${missingPairs.length} 组：${missingPairs.slice(0, 6).join('、')}${missingPairs.length > 6 ? '…' : ''}` : '已完整',
        required: false, applicable: d.machines.length > 0,
      },
    ],
  });

  const all = g.flatMap((x) => x.items);
  // applicable：主体清单为空时该检查项不适用（不显示、不计分）
  const shown = all.filter((i) => i.applicable !== false);
  // 只有必填项驱动完成度；选填项单独提示，避免「已齐全」与百分比自相矛盾
  const required = shown.filter((i) => i.required !== false);
  const done = required.filter((i) => i.done).length;
  const completeness = required.length ? Math.round((done / required.length) * 100) : 0;
  const optionalPending = shown.filter((i) => i.required === false && !i.done).length;

  const firstUndone = g.find((x) => x.items.some((i) => i.applicable !== false && i.required !== false && !i.done));
  return {
    completeness,
    ready: completeness === 100,
    /** 未达到 100% 前，排产结论要标注「按默认效率估算」 */
    caution: completeness < 100 ? '基础数据未齐全，排产与齐套结论精度存疑，请尽快补齐' : null,
    optional_pending: optionalPending,
    optional_hint: optionalPending
      ? `另有 ${optionalPending} 项选填未完成（多为机台×模具实测效率），缺失时按机台默认效率估算`
      : null,
    next_stage: firstUndone ? firstUndone.stage : null,
    next_hint: firstUndone ? `下一步采集【${firstUndone.stage}】${firstUndone.title}` : '必填项已齐全，可以开始排产',
    groups: g,
  };
}
