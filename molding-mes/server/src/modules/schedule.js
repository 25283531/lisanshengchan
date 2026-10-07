/**
 * 排产：运行引擎 → 持久化 → 生成各角色消息。
 */
import { wrap, ok, fail } from '../lib/http.js';
import { nowStr, num, j, toStr, toDate, round } from '../lib/util.js';
import { loadTenantData, normalizeData, audit } from '../lib/repo.js';
import { requirePerm } from '../middleware.js';
import { runScheduling, runSchedulingAsync, shiftPlan } from '../domain/scheduler.js';
import { pushScheduleNotifications, pushShiftPlan } from '../domain/notify.js';

async function loadOrders(db, tenantId, onlyIds = null) {
  const sql = `SELECT * FROM orders WHERE tenant_id = ? AND status IN ('DRAFT','SCHEDULED','RUNNING')`;
  return db.query(sql, [tenantId]);
}

/**
 * 运行排产并落库 + 生成消息。被「手动排产」与「下单后自动排产」共用。
 * @returns {{result, data, savedTasks, savedPlans, notified}}
 */
export async function runAndPersistSchedule(db, ctx, tid, userId, { startFrom = null, notify = true } = {}) {
  const data = normalizeData(await loadTenantData(db, tid));
  const orders = await loadOrders(db, tid);

    const result = await runSchedulingAsync({
      ...data,
      orders,
      options: {
        bufferMinutes: ctx.config.schedule.bufferMinutes,
        feedingOrderLeadMinutes: ctx.config.schedule.feedingOrderLeadMinutes,
        feedingReadyLeadMinutes: ctx.config.schedule.feedingReadyLeadMinutes,
        startFrom: startFrom || toStr(new Date()),
      },
    }, ctx.config.optimizer);

    let savedTasks = 0;
    let savedPlans = 0;

    await db.transaction(async () => {
      // 重排：清除旧的计划任务（保留已开工/已完工）
      await db.run("DELETE FROM schedule_tasks WHERE tenant_id = ? AND status = 'PLANNED'", [tid]);
      const taskIds = await db.query('SELECT id FROM schedule_tasks WHERE tenant_id = ?', [tid]);
      if (taskIds.length) {
        const inList = taskIds.map((t) => t.id).join(',');
        await db.run(`DELETE FROM material_plans WHERE tenant_id = ? AND task_id IN (${inList})`, [tid]);
      }

      for (const t of result.tasks) {
        const r = await db.run(
          `INSERT INTO schedule_tasks
           (tenant_id, order_id, seq, machine_code, mold_code, supply_line_code, mixer_code, decision,
            changeover_minutes, planned_qty, units_per_hour, duration_minutes, start_at, end_at,
            feeding_order_at, feeding_ready_at, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [tid, t.order_id, t.seq, t.machine_code, t.mold_code, t.supply_line_code, t.mixer_code,
            t.decision, t.changeover_minutes, t.planned_qty, t.units_per_hour, t.duration_minutes,
            t.start_at, t.end_at, t.feeding_order_at, t.feeding_ready_at, 'PLANNED', nowStr()],
        );
        const taskId = Number(r.insertId);
        savedTasks += 1;
        t._taskId = taskId;

        for (const p of result.materialPlans.filter((x) => x.task_seq === t.seq)) {
          await db.run(
            `INSERT INTO material_plans (tenant_id, task_id, order_code, material_sku, material_name, kind, qty, unit, use_at, mixer_code, status, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [tid, taskId, p.order_code, p.material_sku, p.material_name || null, p.kind,
              p.qty, p.unit, p.use_at, p.mixer_code, 'PLANNED', nowStr()],
          );
          savedPlans += 1;
        }

        await db.run("UPDATE orders SET status = 'SCHEDULED', updated_at = ? WHERE id = ? AND status = 'DRAFT'",
          [nowStr(), t.order_id]);
      }
    });

    let notified = 0;
    if (notify) notified = await pushScheduleNotifications(db, tid, result, data);

    await audit(db, { tenantId: tid, userId, action: 'schedule.run', detail: result.summary });

    return {
      result, data, savedTasks, savedPlans, notified,
      brief: {
        summary: result.summary,
        saved: { tasks: savedTasks, material_plans: savedPlans, notifications: notified },
        unassigned: result.unassigned.map((u) => ({ order_code: u.order?.code, reason: u.reason })),
        alerts: result.alerts.map((a) => ({ type: a.type, level: a.level, title: a.title })),
        tasks: result.tasks.map((t) => ({
          id: t._taskId, seq: t.seq, order_code: t._order?.code, product: t._product?.name,
          machine_code: t.machine_code, mold_code: t.mold_code, decision: t.decision,
          planned_qty: t.planned_qty, start_at: t.start_at, end_at: t.end_at,
          feeding_order_at: t.feeding_order_at, feeding_ready_at: t.feeding_ready_at,
        })),
      },
    };
}

export default function registerScheduleRoutes(app, db, ctx) {
  /** 手动运行排产 */
  app.post('/api/schedule/run', wrap(async (req) => {
    const user = requirePerm(req, 'schedule.run');
    const b = req.body || {};
    const out = await runAndPersistSchedule(db, ctx, user.tenant_id, user.id, {
      startFrom: b.startFrom || null,
      notify: b.notify !== false,
    });
    return ok(out.brief, `排产完成：${out.savedTasks} 个任务`);
  }));

  /** 排产任务列表 */
  app.get('/api/schedule/tasks', wrap(async (req) => {
    const user = requirePerm(req, 'schedule.read');
    const rows = await db.query(
      `SELECT t.*, o.code AS order_code, o.due_date, p.name AS product_name, p.sku AS product_sku
       FROM schedule_tasks t
       LEFT JOIN orders o ON o.id = t.order_id
       LEFT JOIN products p ON p.id = o.product_id
       WHERE t.tenant_id = ?
       ORDER BY t.start_at, t.seq`,
      [user.tenant_id],
    );
    // 生产人员只看到自己绑定机台的任务
    const filtered = user.role === 'PRODUCTION' && user.machine_code
      ? rows.filter((r) => r.machine_code === user.machine_code)
      : rows;
    return ok(filtered);
  }));

  /** 配料计划（配料员视角） */
  app.get('/api/schedule/materials', wrap(async (req) => {
    const user = requirePerm(req, 'material.read');
    const rows = await db.query(
      `SELECT m.*, t.machine_code, t.start_at AS task_start_at, t.mold_code
       FROM material_plans m
       LEFT JOIN schedule_tasks t ON t.id = m.task_id
       WHERE m.tenant_id = ?
       ORDER BY m.use_at, m.id`,
      [user.tenant_id],
    );
    const grouped = {};
    for (const r of rows) {
      const k = `${r.kind}:${r.material_sku}`;
      if (!grouped[k]) {
        grouped[k] = { kind: r.kind, sku: r.material_sku, name: r.material_name, unit: r.unit, total_qty: 0, details: [] };
      }
      grouped[k].total_qty = round(num(grouped[k].total_qty) + num(r.qty), 3);
      grouped[k].details.push({
        order_code: r.order_code, qty: num(r.qty), use_at: r.use_at,
        mixer_code: r.mixer_code, machine_code: r.machine_code,
      });
    }
    return ok({ items: Object.values(grouped), rows });
  }));

  /** 当班计划（交接班用） */
  app.get('/api/schedule/shift', wrap(async (req) => {
    const user = requirePerm(req, 'schedule.read');
    const start = req.query.start || toStr(new Date());
    const hours = num(req.query.hours, ctx.config.schedule.shiftHours);
    const rows = await db.query(
      `SELECT t.*, o.code AS order_code, p.name AS product_name, p.sku AS product_sku
       FROM schedule_tasks t
       LEFT JOIN orders o ON o.id = t.order_id
       LEFT JOIN products p ON p.id = o.product_id
       WHERE t.tenant_id = ? AND t.status = 'PLANNED'`,
      [user.tenant_id],
    );
    const tasks = rows.map((r) => ({ ...r, _order: { code: r.order_code }, _product: { name: r.product_name, sku: r.product_sku } }));
    const plan = shiftPlan(tasks, start, hours);
    const filtered = user.role === 'PRODUCTION' && user.machine_code
      ? plan.filter((p) => p.machine_code === user.machine_code)
      : plan;
    return ok({ shift_start: start, hours, items: filtered });
  }));

  /** 推送交接班消息 */
  app.post('/api/schedule/shift-push', wrap(async (req) => {
    const user = requirePerm(req, 'schedule.run');
    const tid = user.tenant_id;
    const start = (req.body || {}).start || toStr(new Date());
    const hours = num((req.body || {}).hours, ctx.config.schedule.shiftHours);
    const rows = await db.query(
      `SELECT t.*, o.code AS order_code, p.name AS product_name, p.sku AS product_sku
       FROM schedule_tasks t
       LEFT JOIN orders o ON o.id = t.order_id
       LEFT JOIN products p ON p.id = o.product_id
       WHERE t.tenant_id = ? AND t.status = 'PLANNED'`,
      [tid],
    );
    const tasks = rows.map((r) => ({ ...r, _order: { code: r.order_code }, _product: { name: r.product_name, sku: r.product_sku } }));
    const plan = shiftPlan(tasks, start, hours);
    const n = await pushShiftPlan(db, tid, plan, start, hours);
    await audit(db, { tenantId: tid, userId: user.id, action: 'schedule.shift_push', detail: { start, hours, count: n } });
    return ok({ pushed: n, items: plan.length }, `已推送 ${n} 条交接班消息`);
  }));

  /** 更新任务状态（开工/完工/换模完成） */
  app.put('/api/schedule/tasks/:id', wrap(async (req) => {
    const user = requirePerm(req, 'schedule.read');
    const { status } = req.body || {};
    if (!['PLANNED', 'RUNNING', 'DONE', 'CANCELLED'].includes(status)) return fail('状态不合法', 'BAD_STATUS', 400);
    const n = await db.run('UPDATE schedule_tasks SET status = ? WHERE id = ? AND tenant_id = ?',
      [status, Number(req.params.id), user.tenant_id]);
    if (!n) return fail('任务不存在', 'NOT_FOUND', 404);
    return ok(null, '状态已更新');
  }));
}
