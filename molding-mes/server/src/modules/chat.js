/**
 * 自然语言入口（AI 助手）。
 * 员工说一句话 → AI 解析成内部数据 → 自动匹配机台/模具/原料/标签 → 排产 → 通知相关角色。
 *
 * 解析失败或实体匹配不上时，一律返回候选让用户确认，不猜测、不静默填充。
 */
import { wrap, ok, fail, AppError } from '../lib/http.js';
import { nowStr, num, arr, round, toStr, toDate, j } from '../lib/util.js';
import { loadTenantData, normalizeData, audit } from '../lib/repo.js';
import { requireUser, requirePerm } from '../middleware.js';
import { parseUtterance } from '../domain/nlp.js';
import { materialDemand, labelDemand, checkAvailability } from '../domain/material.js';
import { push, decisionZh } from '../domain/notify.js';
import { runAndPersistSchedule } from './schedule.js';
import { can } from '../lib/rbac.js';
import { resolveAiConfig } from '../domain/ai-config.js';

const fmtTime = (s) => (s ? String(s).slice(5, 16) : '-');

export default function registerChatRoutes(app, db, ctx) {
  /** 解析并执行 */
  app.post('/api/chat', wrap(async (req) => {
    const user = requireUser(req);
    const tid = user.tenant_id;
    const { text, confirm } = req.body || {};
    const raw = String(text || '').trim();
    if (!raw) return fail('请输入内容', 'PARAM_MISSING', 400);
    if (!can(user.role, 'chat.use')) return fail('当前角色无权使用助手', 'FORBIDDEN', 403);

    const data = normalizeData(await loadTenantData(db, tid));
    const aiConfig = (await resolveAiConfig(db, tid)).config;

    const parsed = await parseUtterance(raw, {
      ...data,
      aiConfig,
      today: toStr(new Date()).slice(0, 10),
    });

    let result;
    try {
      result = await dispatch(db, ctx, user, data, parsed, { raw, confirm });
    } catch (e) {
      await logParse(db, { tid, userId: user.id, raw, parsed, result: 'ERROR', message: e.message });
      throw e;
    }

    await logParse(db, {
      tid, userId: user.id, raw, parsed,
      result: result?.status || 'OK', message: result?.message || null,
    });

    return ok({
      intent: parsed.intent,
      message: result.message,
      confidence: round(parsed.confidence ?? 0, 2),
      used_fallback: !!parsed.usedFallback,
      needs_confirm: !!result.needsConfirm,
      candidates: result.candidates || [],
      data: result.data ?? null,
      parsed: parsed.payload,
      error: parsed.error || null,
    });
  }));

  /** 只解析不执行（用于 APP 预览确认） */
  app.post('/api/chat/parse', wrap(async (req) => {
    const user = requireUser(req);
    const tid = user.tenant_id;
    const raw = String((req.body || {}).text || '').trim();
    if (!raw) return fail('请输入内容', 'PARAM_MISSING', 400);
    const data = normalizeData(await loadTenantData(db, tid));
    const aiConfig = (await resolveAiConfig(db, tid)).config;
    const parsed = await parseUtterance(raw, { ...data, aiConfig, today: toStr(new Date()).slice(0, 10) });
    return ok({
      intent: parsed.intent, payload: parsed.payload, confidence: round(parsed.confidence ?? 0, 2),
      needs_confirm: parsed.needsConfirm, candidates: parsed.candidates,
      used_fallback: !!parsed.usedFallback, error: parsed.error || null,
    });
  }));

  /** 解析留痕 */
  app.get('/api/chat/logs', wrap(async (req) => {
    const user = requireUser(req);
    const rows = await db.query(
      'SELECT id, raw_text, intent, payload, provider, used_fallback, confidence, result, created_at FROM ai_parse_logs WHERE tenant_id = ? ORDER BY id DESC LIMIT 50',
      [user.tenant_id],
    );
    return ok(rows.map((r) => ({ ...r, payload: j(r.payload, null) })));
  }));
}

async function logParse(db, { tid, userId, raw, parsed, result, message }) {
  await db.run(
    `INSERT INTO ai_parse_logs (tenant_id, user_id, raw_text, intent, payload, provider, used_fallback, confidence, result, message, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [tid, userId, raw.slice(0, 1000), parsed.intent, JSON.stringify(parsed.payload ?? null),
      parsed.usedFallback ? 'FALLBACK' : 'AI', parsed.usedFallback ? 1 : 0,
      round(parsed.confidence ?? 0, 2), result, message ? String(message).slice(0, 255) : null, nowStr()],
  );
}

async function dispatch(db, ctx, user, data, parsed, { raw, confirm }) {
  const tid = user.tenant_id;
  const product = parsed.resolved?.product || null;
  const customer = parsed.resolved?.customer || null;
  const qty = parsed.payload?.quantity ? Number(parsed.payload.quantity) : null;
  const dueDate = parsed.payload?.due_date || null;

  switch (parsed.intent) {
    /* ------------------------------ 下单 ------------------------------ */
    case 'CREATE_ORDER': {
      if (!can(user.role, 'order.create')) {
        throw new AppError('当前角色无权下单（需要业务员或管理员）', 403, 'FORBIDDEN');
      }
      if (!product) {
        return {
          status: 'NEED_CONFIRM', needsConfirm: true,
          message: `没匹配到产品${parsed.payload?.product ? `「${parsed.payload.product}」` : ''}。请从下列产品中选择，或用后台补齐产品别名。`,
          candidates: parsed.candidates,
        };
      }
      if (!qty || qty <= 0) {
        return { status: 'NEED_CONFIRM', needsConfirm: true, message: '没识别出数量，请补充，例如「下 2 万个」。', candidates: [] };
      }
      if (!dueDate) {
        return { status: 'NEED_CONFIRM', needsConfirm: true, message: '没识别出交期，请补充，例如「13 号交货」。', candidates: [] };
      }

      const code = await newOrderCode(db, tid);
      const r = await db.run(
        `INSERT INTO orders (tenant_id, code, customer_id, product_id, quantity, remaining_qty, completed_qty,
          due_date, order_type, priority_score, status, source, created_by, note, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [tid, code, customer?.id || null, product.id, qty, qty, 0, dueDate, 'SALES', 0,
          'DRAFT', 'AI', user.id, raw.slice(0, 255), nowStr(), nowStr()],
      );
      const orderId = Number(r.insertId);
      await audit(db, { tenantId: tid, userId: user.id, action: 'chat.order.create', detail: { code, qty, dueDate, text: raw } });

      // 自动匹配机台/模具/原料/标签并排产
      const out = await runAndPersistSchedule(db, ctx, tid, user.id, { notify: true });
      const task = out.result.tasks.find((t) => t.order_id === orderId);

      const lines = [];
      lines.push(`已下单：${code}`);
      lines.push(`${customer?.name ? `${customer.name} · ` : ''}${product.name} ${qty} 个，交期 ${dueDate}`);
      if (task) {
        lines.push(`匹配机台 ${task.machine_code}（模具 ${task.mold_code}，${decisionZh(task.decision)}）`);
        lines.push(`计划 ${fmtTime(task.start_at)} 开工，${fmtTime(task.end_at)} 完工`);
        if (task.mixer_code) lines.push(`混料机 ${task.mixer_code}`);
      } else {
        lines.push('⚠️ 未找到可排机台：请检查机台状态、模具可用性或「机台×模具」效率是否已建档');
      }
      const shortage = out.result.alerts.filter((a) => a.type === 'MATERIAL_SHORTAGE' || a.type === 'LABEL_SHORTAGE');
      if (shortage.length) lines.push(`⚠️ ${shortage.length} 项物料/标签缺口，已通知仓库`);
      const delay = out.result.alerts.find((a) => a.type === 'DELAY_RISK' && a.payload?.order_code === code);
      if (delay) lines.push(`⚠️ ${delay.title}`);
      lines.push(`已通知：生产人员 / 配料员 / 技术员（共 ${out.notified} 条）`);

      return {
        status: 'OK', message: lines.join('\n'),
        data: { order_id: orderId, order_code: code, task: task ? { ...task, _order: undefined, _product: undefined } : null, schedule: out.brief },
      };
    }

    /* ------------------------------ 出库 ------------------------------ */
    case 'OUTBOUND': {
      if (!can(user.role, 'order.outbound')) {
        throw new AppError('当前角色无权出库', 403, 'FORBIDDEN');
      }
      if (!product) {
        return {
          status: 'NEED_CONFIRM', needsConfirm: true,
          message: `没匹配到产品${parsed.payload?.product ? `「${parsed.payload.product}」` : ''}，请确认后再出库。`,
          candidates: parsed.candidates,
        };
      }
      if (!qty || qty <= 0) {
        return { status: 'NEED_CONFIRM', needsConfirm: true, message: '没识别出出库数量，例如「出库 5000 个」。', candidates: [] };
      }

      const orders = await db.query(
        `SELECT o.*, c.name AS customer_name FROM orders o
         LEFT JOIN customers c ON c.id = o.customer_id
         WHERE o.tenant_id = ? AND o.product_id = ? AND o.status <> 'COMPLETED' AND o.remaining_qty > 0
         ORDER BY (o.customer_id = ?) DESC, o.due_date IS NULL, o.due_date, o.id`,
        [tid, product.id, customer?.id ?? -1],
      );
      if (!orders.length) {
        return { status: 'NOT_FOUND', message: `产品「${product.name}」当前没有待生产的订单。`, data: null };
      }
      if (orders.length > 1 && !customer && !confirm) {
        return {
          status: 'NEED_CONFIRM', needsConfirm: true,
          message: `产品「${product.name}」有 ${orders.length} 张在制订单，请确认是哪一张：`,
          candidates: [{
            field: 'order',
            options: orders.slice(0, 8).map((o) => ({
              id: o.id, name: `${o.code}｜${o.customer_name || '无客户'}｜待生产 ${num(o.remaining_qty)}｜交期 ${o.due_date || '未定'}`,
            })),
          }],
        };
      }

      const order = orders[0];
      const remaining = num(order.remaining_qty, 0);
      const actual = Math.min(qty, remaining);
      const newRemaining = Math.max(0, remaining - actual);
      await db.run('UPDATE orders SET remaining_qty = ?, status = ?, updated_at = ? WHERE id = ?',
        [newRemaining, newRemaining === 0 ? 'COMPLETED' : order.status, nowStr(), order.id]);
      await db.run(
        `INSERT INTO outbound_records (tenant_id, order_id, qty, operator_id, source, raw_text, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [tid, order.id, actual, user.id, 'AI', raw.slice(0, 255), nowStr()],
      );
      await push(db, {
        tenantId: tid, type: 'OUTBOUND_DONE',
        title: `出库 ${actual} 个 · ${order.code}`,
        body: `${product.name}${order.customer_name ? `（${order.customer_name}）` : ''}　待生产由 ${remaining} 降至 ${newRemaining}${newRemaining === 0 ? '，订单完成' : ''}`,
        payload: { order_id: order.id, order_code: order.code, qty: actual, remaining: newRemaining },
        audienceRoles: ['WAREHOUSE', 'ADMIN', 'PRODUCTION', 'SALES'],
        refType: 'ORDER', refId: order.id, level: 'INFO',
      });
      await audit(db, { tenantId: tid, userId: user.id, action: 'chat.outbound', detail: { order_code: order.code, qty: actual, text: raw } });

      return {
        status: 'OK',
        message: `已出库 ${actual} 个（${order.code} ${product.name}）\n待生产数量：${remaining} → ${newRemaining}${newRemaining === 0 ? '\n该订单已完成' : ''}${qty > remaining ? `\n注意：申报数量 ${qty} 超出待生产数，已按 ${actual} 扣减` : ''}`,
        data: { order_id: order.id, order_code: order.code, deducted: actual, remaining: newRemaining },
      };
    }

    /* ------------------------------ 报工 ------------------------------ */
    case 'PROGRESS': {
      if (!can(user.role, 'order.outbound')) throw new AppError('当前角色无权报工', 403, 'FORBIDDEN');
      if (!product) return { status: 'NEED_CONFIRM', needsConfirm: true, message: '没匹配到产品，请确认后报工。', candidates: parsed.candidates };
      if (!qty || qty <= 0) return { status: 'NEED_CONFIRM', needsConfirm: true, message: '没识别出报工数量。', candidates: [] };
      const order = await db.get(
        `SELECT * FROM orders WHERE tenant_id = ? AND product_id = ? AND status <> 'COMPLETED' AND remaining_qty > 0
         ORDER BY due_date IS NULL, due_date LIMIT 1`,
        [tid, product.id],
      );
      if (!order) return { status: 'NOT_FOUND', message: `产品「${product.name}」没有在制订单。`, data: null };
      const actual = Math.min(qty, num(order.remaining_qty, 0));
      const completed = num(order.completed_qty, 0) + actual;
      const remaining = num(order.remaining_qty, 0) - actual;
      await db.run('UPDATE orders SET completed_qty = ?, remaining_qty = ?, status = ?, updated_at = ? WHERE id = ?',
        [completed, remaining, remaining === 0 ? 'COMPLETED' : 'RUNNING', nowStr(), order.id]);
      return {
        status: 'OK',
        message: `已报工 ${actual} 个（${order.code} ${product.name}）\n累计完工 ${completed}，待生产 ${remaining}`,
        data: { order_code: order.code, completed_qty: completed, remaining_qty: remaining },
      };
    }

    /* ------------------------------ 查库存 ---------------------------- */
    case 'QUERY_STOCK': {
      const out = [];
      if (product) {
        const open = await db.query(
          `SELECT COALESCE(SUM(remaining_qty),0) AS s FROM orders WHERE tenant_id = ? AND product_id = ? AND status <> 'COMPLETED'`,
          [tid, product.id],
        );
        const openQty = Number(open[0]?.s || 0);
        const md = materialDemand(product, openQty);
        const chk = checkAvailability(md, data.materials, 'MATERIAL');
        out.push(`产品：${product.name}（${product.sku}）`);
        out.push(`成品库存：${num(product.finished_stock_qty, 0)} ${product.unit || '个'}`);
        out.push(`在制待生产：${openQty} 个`);
        for (const it of chk.items) {
          out.push(`原料 ${it.name}：库存 ${round(it.stock, 1)}${it.unit}，安全库存 ${round(it.safety, 1)}，${it.enough ? '齐套' : `缺口 ${it.shortage}${it.unit}`}`);
        }
        const lb = labelDemand(product, openQty);
        if (lb.length) {
          const lchk = checkAvailability(lb, data.labels, 'LABEL');
          for (const it of lchk.items) {
            out.push(`标签 ${it.name}：库存 ${round(it.stock, 0)} 张，${it.enough ? '齐套' : `缺口 ${it.shortage} 张`}`);
          }
        }
      } else {
        for (const m of data.materials) {
          const available = Math.max(0, num(m.stock_qty, 0) - num(m.reserved_qty, 0) - num(m.safety_stock, 0));
          out.push(`${m.name}（${m.sku}）：库存 ${round(num(m.stock_qty), 1)}kg，安全库存 ${round(num(m.safety_stock), 1)}kg，可用 ${round(available, 1)}kg`);
        }
        for (const l of data.labels) {
          out.push(`标签 ${l.name}（${l.sku}）：${round(num(l.stock_qty), 0)} 张`);
        }
      }
      return { status: 'OK', message: out.join('\n') || '暂无库存数据', data: null };
    }

    /* ------------------------------ 查排产 ---------------------------- */
    case 'QUERY_SCHEDULE': {
      const rows = await db.query(
        `SELECT t.*, o.code AS order_code, p.name AS product_name
         FROM schedule_tasks t LEFT JOIN orders o ON o.id = t.order_id LEFT JOIN products p ON p.id = o.product_id
         WHERE t.tenant_id = ? AND t.status = 'PLANNED' ORDER BY t.start_at LIMIT 10`,
        [tid],
      );
      if (!rows.length) return { status: 'OK', message: '当前没有排产计划，可由管理员或技术员触发排产。', data: { tasks: [] } };
      const lines = rows.map((r) => `${fmtTime(r.start_at)} 机台 ${r.machine_code}｜模具 ${r.mold_code}｜${r.product_name || ''} ${num(r.planned_qty)} 个`);
      return { status: 'OK', message: `近期排产：\n${lines.join('\n')}`, data: { tasks: rows } };
    }

    default:
      return {
        status: 'UNKNOWN',
        message: '没理解这句话。可以这样说：\n· 河北的魔辣面筋下 2 万个订单，13 号交货\n· 河北麻辣面筋出库 5000 个\n· 麻辣面筋报工 3000 个\n· PP 库存还有多少',
        candidates: [],
      };
  }
}

async function newOrderCode(db, tid) {
  for (let i = 0; i < 20; i += 1) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const code = `ORD-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
    if (!await db.get('SELECT id FROM orders WHERE tenant_id = ? AND code = ?', [tid, code])) return code;
  }
  return `ORD-${Date.now()}`;
}
