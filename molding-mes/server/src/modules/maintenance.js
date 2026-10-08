/**
 * 设备维修 / 保养计划（v3.5）。
 *
 * 技术员在手机上提交计划、推进状态；机台与模具状态随之联动，
 * 状态变更自动推送给生产与排产相关角色——避免"设备停了但排产还在往前排"。
 *
 * 状态机：PLANNED 待安排 → DOING 进行中（设备置为维护/故障） → DONE 已完成（设备恢复可用）
 *        任意状态 → CANCELED 已取消（设备恢复可用）
 */
import { wrap, ok, fail, AppError } from '../lib/http.js';
import { nowStr, num, arr, j } from '../lib/util.js';
import { findAll, audit } from '../lib/repo.js';
import { requirePerm } from '../middleware.js';
import { push } from '../domain/notify.js';

const STATUSES = ['PLANNED', 'DOING', 'DONE', 'CANCELED'];
const STATUS_ZH = { PLANNED: '待安排', DOING: '进行中', DONE: '已完成', CANCELED: '已取消' };
const KINDS = ['REPAIR', 'MAINTAIN', 'MOLD_CHANGE'];
const KIND_ZH = { REPAIR: '故障维修', MAINTAIN: '预防保养', MOLD_CHANGE: '换模检修' };
const TYPES = ['MACHINE', 'MOLD'];
const TYPE_ZH = { MACHINE: '机台', MOLD: '模具' };

/** 状态 → 设备应置为什么状态（null 表示不动） */
const DEVICE_STATUS_ON = { DOING: 'MAINTENANCE', DONE: 'AVAILABLE', CANCELED: 'AVAILABLE', PLANNED: null };

async function genCode(db, tenantId) {
  for (let i = 0; i < 20; i += 1) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const code = `MP-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
    if (!await db.get('SELECT id FROM maintenance_plans WHERE tenant_id = ? AND code = ?', [tenantId, code])) return code;
  }
  return `MP-${Date.now()}`;
}

export default function registerMaintenanceRoutes(app, db, ctx) {
  /** 设备维护总览：机台/模具状态 + 待处理计划 + 保养临界 */
  app.get('/api/maintenance/overview', wrap(async (req) => {
    const user = requirePerm(req, 'maintenance.read');
    const tid = user.tenant_id;
    const machines = await findAll(db, 'machines', { tenantId: tid, jsonFields: ['mold_codes', 'product_skus', 'mold_efficiencies'], orderBy: 'code' });
    const molds = await findAll(db, 'molds', { tenantId: tid, orderBy: 'code' });
    // 排序用 CASE 而非 FIELD()：SQLite 没有 FIELD()，保持双方言一致
    const plans = await db.query(
      `SELECT * FROM maintenance_plans WHERE tenant_id = ?
       ORDER BY CASE status WHEN 'DOING' THEN 0 WHEN 'PLANNED' THEN 1 WHEN 'DONE' THEN 2 ELSE 3 END, id DESC LIMIT 200`,
      [tid],
    );
    const open = plans.filter((p) => p.status === 'PLANNED' || p.status === 'DOING');

    const moldDue = molds
      .filter((m) => num(m.maintenance_at_shots, 0) > 0 && num(m.cumulative_shots, 0) >= num(m.maintenance_at_shots, 0) * 0.9)
      .map((m) => ({
        code: m.code, name: m.name || m.code,
        cumulative_shots: num(m.cumulative_shots, 0), maintenance_at_shots: num(m.maintenance_at_shots, 0),
        remaining_shots: Math.max(0, num(m.maintenance_at_shots, 0) - num(m.cumulative_shots, 0)),
        overdue: num(m.cumulative_shots, 0) >= num(m.maintenance_at_shots, 0),
      }));

    return ok({
      machines: machines.map((m) => ({
        code: m.code, name: m.name || m.code, status: m.status, feeding_mode: m.feeding_mode,
        current_mold_code: m.current_mold_code || null, enabled: !!m.enabled,
        mold_codes: arr(m.mold_codes),
      })),
      molds: molds.map((m) => ({
        code: m.code, name: m.name || m.code, status: m.status,
        cavities: num(m.cavities, 1), cumulative_shots: num(m.cumulative_shots, 0),
        maintenance_at_shots: num(m.maintenance_at_shots, 0),
      })),
      mold_due: moldDue,
      plans: plans.map(fmtPlan),
      counts: {
        planned: plans.filter((p) => p.status === 'PLANNED').length,
        doing: plans.filter((p) => p.status === 'DOING').length,
        machine_fault: machines.filter((m) => m.status === 'FAULT').length,
        mold_maintenance: molds.filter((m) => m.status === 'MAINTENANCE').length,
      },
      open_count: open.length,
      status_zh: STATUS_ZH, kind_zh: KIND_ZH, type_zh: TYPE_ZH,
    });
  }));

  /** 计划列表（支持按状态/设备筛选） */
  app.get('/api/maintenance/plans', wrap(async (req) => {
    const user = requirePerm(req, 'maintenance.read');
    const { status, targetType, targetCode, mine } = req.query || {};
    const where = ['tenant_id = ?'];
    const args = [user.tenant_id];
    if (status) { where.push('status = ?'); args.push(String(status).toUpperCase()); }
    if (targetType) { where.push('target_type = ?'); args.push(String(targetType).toUpperCase()); }
    if (targetCode) { where.push('target_code = ?'); args.push(String(targetCode)); }
    if (mine === '1') { where.push('created_by = ?'); args.push(user.id); }
    const rows = await db.query(
      `SELECT * FROM maintenance_plans WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 200`, args,
    );
    return ok(rows.map(fmtPlan));
  }));

  app.get('/api/maintenance/plans/:id', wrap(async (req) => {
    const user = requirePerm(req, 'maintenance.read');
    const row = await db.get('SELECT * FROM maintenance_plans WHERE id = ? AND tenant_id = ?', [Number(req.params.id), user.tenant_id]);
    if (!row) return fail('计划不存在', 'NOT_FOUND', 404);
    return ok(fmtPlan(row));
  }));

  /** 提交维修/保养计划 */
  app.post('/api/maintenance/plans', wrap(async (req) => {
    const user = requirePerm(req, 'maintenance.write');
    const tid = user.tenant_id;
    const b = req.body || {};
    const targetType = String(b.targetType || 'MACHINE').toUpperCase();
    const targetCode = String(b.targetCode || '').trim();
    const kind = String(b.kind || 'REPAIR').toUpperCase();
    if (!TYPES.includes(targetType)) return fail('设备类型只能是 MACHINE / MOLD', 'BAD_TYPE', 400);
    if (!KINDS.includes(kind)) return fail(`计划类型只能是 ${KINDS.join(' / ')}`, 'BAD_KIND', 400);
    if (!targetCode) return fail('设备编号不能为空', 'PARAM_MISSING', 400);

    const device = await findDevice(db, tid, targetType, targetCode);
    if (!device) return fail(`${TYPE_ZH[targetType]} ${targetCode} 不存在，请先在基础数据里建档`, 'DEVICE_NOT_FOUND', 404);

    const code = await genCode(db, tid);
    const id = await db.run(
      `INSERT INTO maintenance_plans (tenant_id, code, target_type, target_code, target_name, kind, fault_desc,
        plan_start_at, plan_finish_at, duration_minutes, status, created_by, created_by_name, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [tid, code, targetType, targetCode, device.name || targetCode, kind, b.faultDesc || null,
        b.planStartAt || null, b.planFinishAt || null, num(b.durationMinutes, 0),
        'PLANNED', user.id, user.name || null, nowStr(), nowStr()],
    );
    await audit(db, { tenantId: tid, userId: user.id, action: 'maintenance.plan.create', detail: { code, targetCode, kind } });

    await push(db, {
      tenantId: tid, type: targetType === 'MOLD' ? 'MOLD_MAINTENANCE' : 'MACHINE_FAULT',
      title: `${KIND_ZH[kind]}计划 · ${targetCode}`,
      body: `${user.name || '技术员'}提交了${TYPE_ZH[targetType]} ${targetCode} 的${KIND_ZH[kind]}计划${b.faultDesc ? `：${b.faultDesc}` : ''}。计划时长 ${num(b.durationMinutes, 0)} 分钟。`,
      payload: { plan_id: Number(id.insertId), plan_code: code, target_type: targetType, target_code: targetCode, kind },
      audienceRoles: ['ADMIN', 'PMC', 'PRODUCTION', 'TECHNICIAN'],
      refType: 'MAINTENANCE', refId: Number(id.insertId), level: 'WARN',
    });

    return ok({ id: Number(id.insertId), code }, `${KIND_ZH[kind]}计划 ${code} 已提交`);
  }));

  /** 修改计划内容（仅待安排/进行中可改） */
  app.put('/api/maintenance/plans/:id', wrap(async (req) => {
    const user = requirePerm(req, 'maintenance.write');
    const tid = user.tenant_id;
    const id = Number(req.params.id);
    const cur = await db.get('SELECT * FROM maintenance_plans WHERE id = ? AND tenant_id = ?', [id, tid]);
    if (!cur) return fail('计划不存在', 'NOT_FOUND', 404);
    if (cur.status === 'DONE' || cur.status === 'CANCELED') return fail('已结束的计划不能再改', 'PLAN_CLOSED', 400);

    const b = req.body || {};
    const patch = { updated_at: nowStr() };
    if (b.kind !== undefined) {
      const k = String(b.kind).toUpperCase();
      if (!KINDS.includes(k)) return fail(`计划类型只能是 ${KINDS.join(' / ')}`, 'BAD_KIND', 400);
      patch.kind = k;
    }
    if (b.faultDesc !== undefined) patch.fault_desc = b.faultDesc;
    if (b.planStartAt !== undefined) patch.plan_start_at = b.planStartAt || null;
    if (b.planFinishAt !== undefined) patch.plan_finish_at = b.planFinishAt || null;
    if (b.durationMinutes !== undefined) patch.duration_minutes = num(b.durationMinutes, 0);
    const keys = Object.keys(patch);
    await db.run(`UPDATE maintenance_plans SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`,
      [...keys.map((k) => patch[k]), id]);
    await audit(db, { tenantId: tid, userId: user.id, action: 'maintenance.plan.update', detail: { id, ...patch } });
    return ok(null, '计划已更新');
  }));

  /** 状态流转：同步设备状态并通知相关角色 */
  app.post('/api/maintenance/plans/:id/status', wrap(async (req) => {
    const user = requirePerm(req, 'maintenance.write');
    const tid = user.tenant_id;
    const id = Number(req.params.id);
    const status = String((req.body || {}).status || '').toUpperCase();
    const note = (req.body || {}).note || null;
    if (!STATUSES.includes(status)) return fail(`状态只能是 ${STATUSES.join(' / ')}`, 'BAD_STATUS', 400);

    const cur = await db.get('SELECT * FROM maintenance_plans WHERE id = ? AND tenant_id = ?', [id, tid]);
    if (!cur) return fail('计划不存在', 'NOT_FOUND', 404);

    const patch = { status, updated_at: nowStr() };
    if (status === 'DONE') { patch.finished_at = nowStr(); patch.result_note = note || cur.result_note; }
    if (note && status !== 'DONE') patch.result_note = note;

    await db.transaction(async () => {
      const keys = Object.keys(patch);
      await db.run(`UPDATE maintenance_plans SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`,
        [...keys.map((k) => patch[k]), id]);

      // 设备状态联动：开始维修/保养 → 置为维护中；完成或取消 → 恢复可用
      const deviceStatus = DEVICE_STATUS_ON[status];
      if (deviceStatus) {
        const table = cur.target_type === 'MOLD' ? 'molds' : 'machines';
        await db.run(`UPDATE \`${table}\` SET status = ?, updated_at = ? WHERE tenant_id = ? AND code = ?`,
          [deviceStatus, nowStr(), tid, cur.target_code]);
      }
      // 模具保养完成：累计模次归零，重新开始计数
      if (status === 'DONE' && cur.target_type === 'MOLD' && cur.kind === 'MAINTAIN') {
        await db.run('UPDATE molds SET cumulative_shots = 0, last_maintenance_at = ?, updated_at = ? WHERE tenant_id = ? AND code = ?',
          [nowStr(), nowStr(), tid, cur.target_code]);
      }
    });

    await audit(db, {
      tenantId: tid, userId: user.id, action: 'maintenance.plan.status',
      detail: { id, code: cur.code, from: cur.status, to: status, target_code: cur.target_code },
    });

    await push(db, {
      tenantId: tid, type: cur.target_type === 'MOLD' ? 'MOLD_MAINTENANCE' : 'MACHINE_FAULT',
      title: `${TYPE_ZH[cur.target_type]} ${cur.target_code} · ${STATUS_ZH[status]}`,
      body: `${KIND_ZH[cur.kind] || '维修'}计划 ${cur.code} 状态更新为「${STATUS_ZH[status]}」${note ? `：${note}` : ''}。${
        status === 'DOING' ? '该设备已置为维护中，排产将避开。' : status === 'DONE' ? '设备已恢复可用。' : ''}`,
      payload: { plan_id: id, plan_code: cur.code, target_type: cur.target_type, target_code: cur.target_code, status },
      audienceRoles: ['ADMIN', 'PMC', 'PRODUCTION', 'TECHNICIAN'],
      refType: 'MAINTENANCE', refId: id, level: status === 'DONE' ? 'INFO' : 'WARN',
    });

    return ok({ id, status, status_zh: STATUS_ZH[status] }, `${cur.code} 已置为「${STATUS_ZH[status]}」`);
  }));

  /** 设备清单（供手机端下拉选择） */
  app.get('/api/maintenance/devices', wrap(async (req) => {
    const user = requirePerm(req, 'maintenance.read');
    const tid = user.tenant_id;
    const machines = await findAll(db, 'machines', { tenantId: tid, orderBy: 'code' });
    const molds = await findAll(db, 'molds', { tenantId: tid, orderBy: 'code' });
    return ok({
      machines: machines.map((m) => ({ code: m.code, name: m.name || m.code, status: m.status })),
      molds: molds.map((m) => ({ code: m.code, name: m.name || m.code, status: m.status })),
    });
  }));
}

/* ------------------------------- 内部函数 ------------------------------ */

async function findDevice(db, tenantId, type, code) {
  const table = type === 'MOLD' ? 'molds' : 'machines';
  return db.get(`SELECT * FROM \`${table}\` WHERE tenant_id = ? AND code = ?`, [tenantId, code]);
}

function fmtPlan(r) {
  return {
    id: r.id, code: r.code, target_type: r.target_type, target_type_zh: TYPE_ZH[r.target_type] || r.target_type,
    target_code: r.target_code, target_name: r.target_name, kind: r.kind, kind_zh: KIND_ZH[r.kind] || r.kind,
    fault_desc: r.fault_desc, plan_start_at: r.plan_start_at, plan_finish_at: r.plan_finish_at,
    duration_minutes: num(r.duration_minutes, 0), status: r.status, status_zh: STATUS_ZH[r.status] || r.status,
    result_note: r.result_note, finished_at: r.finished_at,
    created_by: r.created_by, created_by_name: r.created_by_name,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}
