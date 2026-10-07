/**
 * 订单：创建、调整、报工、出库。
 * 出库/报工都会回扣「待生产数量」，这是生产人员语音报数的落点。
 */
import { wrap, ok, fail, AppError } from '../lib/http.js';
import { nowStr, num, toStr, arr } from '../lib/util.js';
import { audit } from '../lib/repo.js';
import { requirePerm } from '../middleware.js';
import { push } from '../domain/notify.js';

async function genCode(db, tenantId, prefix) {
  for (let i = 0; i < 20; i += 1) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const code = `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const dup = await db.get('SELECT id FROM orders WHERE tenant_id = ? AND code = ?', [tenantId, code]);
    if (!dup) return code;
  }
  return `${prefix}-${Date.now()}`;
}

export default function registerOrderRoutes(app, db, ctx) {
  app.get('/api/orders', wrap(async (req) => {
    const user = requirePerm(req, 'order.read');
    const { status, customerId, productId, keyword } = req.query || {};
    const where = [];
    const params = [user.tenant_id];
    if (status) { where.push('o.status = ?'); params.push(String(status).toUpperCase()); }
    if (customerId) { where.push('o.customer_id = ?'); params.push(Number(customerId)); }
    if (productId) { where.push('o.product_id = ?'); params.push(Number(productId)); }
    if (keyword) {
      where.push('(o.code LIKE ? OR p.name LIKE ? OR c.name LIKE ?)');
      const k = `%${keyword}%`;
      params.push(k, k, k);
    }
    const rows = await db.query(
      `SELECT o.*, p.name AS product_name, p.sku AS product_sku, c.name AS customer_name
       FROM orders o
       LEFT JOIN products p ON p.id = o.product_id
       LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.tenant_id = ? ${where.length ? `AND ${where.join(' AND ')}` : ''}
       ORDER BY o.due_date IS NULL, o.due_date, o.id DESC
       LIMIT 500`,
      params,
    );
    return ok(rows);
  }));

  app.get('/api/orders/:id', wrap(async (req) => {
    const user = requirePerm(req, 'order.read');
    const row = await db.get(
      `SELECT o.*, p.name AS product_name, c.name AS customer_name
       FROM orders o LEFT JOIN products p ON p.id = o.product_id LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.tenant_id = ? AND o.id = ?`,
      [user.tenant_id, Number(req.params.id)],
    );
    if (!row) return fail('订单不存在', 'NOT_FOUND', 404);
    const tasks = await db.query('SELECT * FROM schedule_tasks WHERE order_id = ? ORDER BY start_at', [row.id]);
    return ok({ ...row, tasks });
  }));

  app.post('/api/orders', wrap(async (req) => {
    const user = requirePerm(req, 'order.create');
    const tid = user.tenant_id;
    const b = req.body || {};
    if (!b.productId) return fail('产品不能为空', 'PARAM_MISSING', 400);
    const qty = num(b.quantity, 0);
    if (qty <= 0) return fail('数量必须大于 0', 'BAD_QUANTITY', 400);
    const product = await db.get('SELECT * FROM products WHERE tenant_id = ? AND id = ?', [tid, b.productId]);
    if (!product) return fail('产品不存在', 'NOT_FOUND', 404);
    const code = b.code || await genCode(db, tid, 'ORD');
    const id = await db.run(
      `INSERT INTO orders (tenant_id, code, customer_id, product_id, quantity, remaining_qty, completed_qty,
        due_date, order_type, priority_score, status, source, created_by, note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [tid, code, b.customerId || null, b.productId, qty, qty, 0,
        b.dueDate || null, b.orderType || 'SALES', num(b.priorityScore, 0), 'DRAFT',
        b.source || 'APP', user.id, b.note || null, nowStr(), nowStr()],
    );
    await audit(db, { tenantId: tid, userId: user.id, action: 'order.create', detail: { code, qty } });
    return ok({ id: Number(id.insertId), code }, `订单 ${code} 已创建`);
  }));

  app.put('/api/orders/:id', wrap(async (req) => {
    const user = requirePerm(req, 'order.update');
    const tid = user.tenant_id;
    const id = Number(req.params.id);
    const b = req.body || {};
    const patch = { updated_at: nowStr() };
    if (b.quantity !== undefined) {
      const q = num(b.quantity, 0);
      if (q <= 0) return fail('数量必须大于 0', 'BAD_QUANTITY', 400);
      patch.quantity = q;
      // 改单后待生产数量同步调整（已完工部分不动）
      const cur = await db.get('SELECT * FROM orders WHERE id = ? AND tenant_id = ?', [id, tid]);
      if (!cur) return fail('订单不存在', 'NOT_FOUND', 404);
      patch.remaining_qty = Math.max(0, q - num(cur.completed_qty, 0));
    }
    if (b.dueDate !== undefined) patch.due_date = b.dueDate || null;
    if (b.priorityScore !== undefined) patch.priority_score = num(b.priorityScore, 0);
    if (b.status !== undefined) patch.status = String(b.status).toUpperCase();
    if (b.note !== undefined) patch.note = b.note;
    if (b.customerId !== undefined) patch.customer_id = b.customerId || null;
    const keys = Object.keys(patch);
    await db.run(`UPDATE orders SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ? AND tenant_id = ?`,
      [...keys.map((k) => patch[k]), id, tid]);
    await audit(db, { tenantId: tid, userId: user.id, action: 'order.update', detail: { id, ...patch } });
    return ok(null, '订单已更新');
  }));

  /** 出库/发货：回扣待生产数量 */
  app.post('/api/orders/:id/outbound', wrap(async (req) => {
    const user = requirePerm(req, 'order.outbound');
    const tid = user.tenant_id;
    const id = Number(req.params.id);
    const qty = num((req.body || {}).qty ?? (req.body || {}).quantity, 0);
    if (qty <= 0) return fail('出库数量必须大于 0', 'BAD_QUANTITY', 400);

    const r = await db.transaction(async () => {
      const order = await db.get('SELECT * FROM orders WHERE id = ? AND tenant_id = ?', [id, tid]);
      if (!order) throw new AppError('订单不存在', 404, 'NOT_FOUND');
      const remaining = num(order.remaining_qty, 0);
      const actual = Math.min(qty, remaining);
      const newRemaining = Math.max(0, remaining - actual);
      await db.run(
        `UPDATE orders SET remaining_qty = ?, status = ?, updated_at = ? WHERE id = ?`,
        [newRemaining, newRemaining === 0 ? 'COMPLETED' : order.status, nowStr(), id],
      );
      await db.run(
        `INSERT INTO outbound_records (tenant_id, order_id, qty, operator_id, source, raw_text, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [tid, id, actual, user.id, (req.body || {}).source || 'APP', (req.body || {}).rawText || null, nowStr()],
      );
      return { order, actual, newRemaining, over: qty > remaining };
    });

    await push(db, {
      tenantId: tid, type: 'OUTBOUND_DONE',
      title: `出库 ${r.actual} 个 · ${r.order.code}`,
      body: `待生产数量由 ${num(r.order.remaining_qty, 0)} 降至 ${r.newRemaining}${r.newRemaining === 0 ? '，订单已完成' : ''}。${r.over ? '（本次申报数量超出待生产数量，已按待生产数量扣减）' : ''}`,
      payload: { order_id: id, order_code: r.order.code, qty: r.actual, remaining: r.newRemaining },
      audienceRoles: ['WAREHOUSE', 'ADMIN', 'PRODUCTION', 'SALES'],
      refType: 'ORDER', refId: id, level: 'INFO',
    });
    await audit(db, { tenantId: tid, userId: user.id, action: 'order.outbound', detail: { id, qty: r.actual } });
    return ok({ order_code: r.order.code, deducted: r.actual, remaining: r.newRemaining, over_declared: r.over },
      `已出库 ${r.actual} 个，待生产剩余 ${r.newRemaining}`);
  }));

  /** 报工：完工数增加，待生产数量减少 */
  app.post('/api/orders/:id/progress', wrap(async (req) => {
    const user = requirePerm(req, 'order.outbound');
    const tid = user.tenant_id;
    const id = Number(req.params.id);
    const qty = num((req.body || {}).qty ?? (req.body || {}).quantity, 0);
    if (qty <= 0) return fail('报工数量必须大于 0', 'BAD_QUANTITY', 400);
    const order = await db.get('SELECT * FROM orders WHERE id = ? AND tenant_id = ?', [id, tid]);
    if (!order) return fail('订单不存在', 'NOT_FOUND', 404);
    const actual = Math.min(qty, num(order.remaining_qty, 0));
    const completed = num(order.completed_qty, 0) + actual;
    const remaining = num(order.remaining_qty, 0) - actual;
    await db.run('UPDATE orders SET completed_qty = ?, remaining_qty = ?, status = ?, updated_at = ? WHERE id = ?',
      [completed, remaining, remaining === 0 ? 'COMPLETED' : 'RUNNING', nowStr(), id]);
    await audit(db, { tenantId: tid, userId: user.id, action: 'order.progress', detail: { id, qty: actual } });
    return ok({ completed_qty: completed, remaining_qty: remaining }, `已报工 ${actual} 个`);
  }));
}
