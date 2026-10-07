/** 租户作用域的通用仓储助手：JSON 列序列化/反序列化、软字段过滤 */

import { j, arr, nowStr } from './util.js';
import { AppError } from './http.js';

/** 把 JSON 列解析成对象 */
export function hydrate(row, jsonFields = []) {
  if (!row) return row;
  const out = { ...row };
  for (const f of jsonFields) out[f] = j(out[f], Array.isArray(row[f]) ? [] : null);
  for (const k of Object.keys(out)) {
    if (typeof out[k] === 'number' && Number.isNaN(out[k])) out[k] = null;
  }
  return out;
}

export async function findAll(db, table, { tenantId, where = '', params = [], jsonFields = [], orderBy = '' } = {}) {
  const w = [`tenant_id = ?`, ...(where ? [where] : [])].join(' AND ');
  const sql = `SELECT * FROM \`${table}\` WHERE ${w}${orderBy ? ` ORDER BY ${orderBy}` : ''}`;
  const rows = await db.query(sql, [tenantId, ...params]);
  return rows.map((r) => hydrate(r, jsonFields));
}

export async function findOne(db, table, id, { tenantId, jsonFields = [] } = {}) {
  const row = await db.get(
    `SELECT * FROM \`${table}\` WHERE tenant_id = ? AND id = ?`,
    [tenantId, id],
  );
  return hydrate(row, jsonFields);
}

export async function insertRow(db, table, data, { tenantId, jsonFields = [] } = {}) {
  const payload = { ...data };
  for (const f of jsonFields) {
    if (payload[f] !== undefined && typeof payload[f] !== 'string') payload[f] = JSON.stringify(payload[f] ?? null);
  }
  payload.tenant_id = tenantId;
  const keys = Object.keys(payload);
  const sql = `INSERT INTO \`${table}\` (${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  const r = await db.run(sql, keys.map((k) => payload[k]));
  return Number(r.insertId);
}

export async function updateRow(db, table, id, patch, { tenantId, jsonFields = [] } = {}) {
  const payload = { ...patch };
  delete payload.id;
  delete payload.tenant_id;
  for (const f of jsonFields) {
    if (payload[f] !== undefined && typeof payload[f] !== 'string') payload[f] = JSON.stringify(payload[f] ?? null);
  }
  const keys = Object.keys(payload).filter((k) => payload[k] !== undefined);
  if (!keys.length) return 0;
  const sql = `UPDATE \`${table}\` SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`;
  const r = await db.run(sql, [...keys.map((k) => payload[k]), tenantId, id]);
  return Number(r.changes);
}

export async function deleteRow(db, table, id, { tenantId } = {}) {
  const r = await db.run(`DELETE FROM \`${table}\` WHERE tenant_id = ? AND id = ?`, [tenantId, id]);
  return Number(r.changes);
}

export async function mustGet(db, table, id, opts) {
  const row = await findOne(db, table, id, opts);
  if (!row) throw new AppError(`${opts?.zh || table} 不存在：${id}`, 404, 'NOT_FOUND');
  return row;
}

export async function audit(db, { tenantId, userId, action, detail, ip }) {
  await db.run(
    `INSERT INTO audit_logs (tenant_id, user_id, action, detail, ip, created_at) VALUES (?,?,?,?,?,?)`,
    [tenantId ?? null, userId ?? null, action, JSON.stringify(detail ?? null), ip ?? null, nowStr()],
  );
}

/** 取租户全部主数据（排产与 AI 解析的输入） */
export async function loadTenantData(db, tenantId) {
  const [customers, materials, labels, molds, machines, supplyLines, mixers, products] = await Promise.all([
    findAll(db, 'customers', { tenantId, jsonFields: ['aliases'], orderBy: 'id' }),
    findAll(db, 'materials', { tenantId, orderBy: 'id' }),
    findAll(db, 'labels', { tenantId, orderBy: 'id' }),
    findAll(db, 'molds', { tenantId, orderBy: 'id' }),
    findAll(db, 'machines', { tenantId, jsonFields: ['product_skus', 'mold_codes', 'mold_efficiencies'], orderBy: 'id' }),
    findAll(db, 'supply_lines', { tenantId, jsonFields: ['machine_codes'], orderBy: 'id' }),
    findAll(db, 'mixers', { tenantId, orderBy: 'id' }),
    findAll(db, 'products', { tenantId, jsonFields: ['aliases', 'label_skus', 'recipe', 'mold_codes'], orderBy: 'id' }),
  ]);
  return { customers, materials, labels, molds, machines, supplyLines, mixers, products };
}

/** 归一化：确保主数据里的空数组为 [] 而非 null */
export function normalizeData(d) {
  for (const m of d.machines) {
    m.product_skus = arr(m.product_skus);
    m.mold_codes = arr(m.mold_codes);
    m.mold_efficiencies = j(m.mold_efficiencies, {}) || {};
  }
  for (const p of d.products) {
    p.aliases = arr(p.aliases);
    p.label_skus = arr(p.label_skus);
    p.recipe = arr(p.recipe);
    p.mold_codes = arr(p.mold_codes);
  }
  for (const l of d.supplyLines) l.machine_codes = arr(l.machine_codes);
  for (const c of d.customers) c.aliases = arr(c.aliases);
  return d;
}
