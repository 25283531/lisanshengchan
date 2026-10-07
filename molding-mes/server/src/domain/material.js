/**
 * 物料与标签核算。
 * 口径与专家团一致：
 *   原料需求 = 数量 × 单件克重 / 1000 × (1 + 损耗率%)
 *   标签需求 = 数量 × 单件张数 × (1 + 标签损耗率%)
 */
import { arr, num, round } from '../lib/util.js';

/** 原料需求明细 */
export function materialDemand(product, qty) {
  const recipe = arr(product.recipe);
  const loss = num(product.loss_rate, 0);
  return recipe.map((r) => ({
    material_sku: r.material_sku,
    qty: round(qty * num(r.grams_per_unit, 0) * (1 + loss / 100) / 1000, 3),
    unit: 'kg',
  }));
}

/** 标签（标志）需求明细 */
export function labelDemand(product, qty) {
  if (!product.needs_label) return [];
  const per = num(product.labels_per_unit, 1);
  const waste = num(product.label_waste_rate, 0);
  return arr(product.label_skus).map((sku) => ({
    label_sku: sku,
    qty: Math.ceil(qty * per * (1 + waste / 100)),
    unit: '张',
  }));
}

/**
 * 齐套判定。
 * @returns { items, shortages } item: {sku,name,kind,demand,available,stock,safety,shortage,coverDays }
 */
export function checkAvailability(demands, inventory, kind = 'MATERIAL') {
  const items = [];
  for (const d of demands) {
    const inv = inventory.find((x) => x.sku === (d.material_sku || d.label_sku));
    const stock = num(inv?.stock_qty, 0);
    const safety = num(inv?.safety_stock, 0);
    const reserved = num(inv?.reserved_qty, 0);
    const available = Math.max(0, stock - reserved - safety);
    const demand = num(d.qty, 0);
    const shortage = Math.max(0, round(demand - available, 3));
    items.push({
      kind,
      sku: d.material_sku || d.label_sku,
      name: inv?.name || (d.material_sku || d.label_sku),
      unit: d.unit || inv?.unit || (kind === 'LABEL' ? '张' : 'kg'),
      demand: round(demand, 3),
      stock,
      safety,
      available: round(available, 3),
      shortage,
      enough: shortage === 0,
      lead_time_days: num(inv?.lead_time_days, 0),
    });
  }
  return { items, shortages: items.filter((i) => !i.enough) };
}

/** 再订货点 ROP = 日均耗用 × 采购提前期 + 安全库存 */
export function reorderPoint(dailyUsage, leadTimeDays, safetyStock) {
  return round(dailyUsage * leadTimeDays + safetyStock, 3);
}

/** 库存可用天数（按当前库存 / 日均耗用） */
export function coverDays(stock, dailyUsage) {
  if (!dailyUsage) return null;
  return round(stock / dailyUsage, 1);
}
