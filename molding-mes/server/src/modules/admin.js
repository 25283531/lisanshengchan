/**
 * 公司管理员后台：
 *  - 员工授权（录入手机号后该手机号才能登录）、分配角色、绑定机台
 *  - 授权信息查看（用户数 / 到期日）
 *  - AI 接口配置（BaseURL / APIKey / 模型）
 */
import { wrap, ok, fail, AppError } from '../lib/http.js';
import { hashPassword } from '../lib/auth.js';
import { nowStr, num, randomPassword } from '../lib/util.js';
import { audit } from '../lib/repo.js';
import { checkSeat, requirePerm } from '../middleware.js';
import { ALL_ROLES, ROLES, roleZh } from '../lib/rbac.js';
import { onboardingReport } from './master.js';
import { resolveAiConfig, readGlobalAi, publicView, testAiConnection } from '../domain/ai-config.js';

const PHONE_RE = /^1[3-9]\d{9}$/;

export default function registerAdminRoutes(app, db, ctx) {
  const adminOnly = (req) => requirePerm(req, 'employee.manage');

  /* ------------------------------ 概览 ------------------------------- */
  app.get('/api/admin/overview', wrap(async (req) => {
    const user = adminOnly(req);
    const tid = user.tenant_id;
    const tenant = req.tenant;
    const seats = await db.get("SELECT COUNT(*) AS c FROM users WHERE tenant_id = ? AND status = 'ACTIVE'", [tid]);
    const counts = {};
    for (const t of ['customers', 'materials', 'labels', 'molds', 'machines', 'supply_lines', 'mixers', 'products']) {
      const r = await db.get(`SELECT COUNT(*) AS c FROM \`${t}\` WHERE tenant_id = ?`, [tid]);
      counts[t] = Number(r?.c || 0);
    }
    const orders = await db.get("SELECT COUNT(*) AS c FROM orders WHERE tenant_id = ? AND status <> 'COMPLETED'", [tid]);
    const aiEff = await resolveAiConfig(db, tid);
    const onboarding = await onboardingReport(db, tid);
    return ok({
      tenant: {
        id: tenant.id, code: tenant.code, name: tenant.name,
        status: tenant.status, expires_at: tenant.expires_at,
        max_users: tenant.max_users, used_users: Number(seats?.c || 0),
      },
      master_counts: counts,
      open_orders: Number(orders?.c || 0),
      ai: {
        ...publicView(aiEff.config),
        source: aiEff.source, source_zh: aiEff.source_zh,
        allow_tenant_override: aiEff.allow_tenant_override,
      },
      onboarding,
    });
  }));

  /* ---------------------------- 员工授权 ---------------------------- */
  app.get('/api/admin/employees', wrap(async (req) => {
    const user = adminOnly(req);
    const rows = await db.query(
      `SELECT id, phone, name, role, status, machine_code, last_login_at, created_at,
              password_hash, must_change_password, password_updated_at, initial_password
       FROM users WHERE tenant_id = ? ORDER BY role, id`,
      [user.tenant_id],
    );
    return ok(rows.map((r) => ({
      id: r.id, phone: r.phone, name: r.name, role: r.role, role_zh: roleZh(r.role),
      status: r.status, machine_code: r.machine_code, last_login_at: r.last_login_at, created_at: r.created_at,
      has_password: !!r.password_hash,
      must_change_password: !!r.must_change_password,
      password_updated_at: r.password_updated_at || null,
      /** 管理员下发的初始密码（员工自行改密后清空） */
      initial_password: r.initial_password || null,
      /** 初始密码 / 已自行修改 / 未设置 */
      password_state: !r.password_hash ? 'NONE' : (r.must_change_password ? 'INITIAL' : 'CHANGED'),
    })));
  }));

  /** 录入手机号 = 授权该号码可登录，同时下发初始密码 */
  app.post('/api/admin/employees', wrap(async (req) => {
    const user = adminOnly(req);
    const tid = user.tenant_id;
    const b = req.body || {};
    const phone = String(b.phone || '').trim();
    if (!PHONE_RE.test(phone)) return fail('手机号格式不正确（需 11 位中国大陆号码）', 'BAD_PHONE', 400);
    if (!ALL_ROLES.includes(b.role)) return fail(`角色不合法，可选：${ALL_ROLES.join(' / ')}`, 'BAD_ROLE', 400);
    if (await db.get('SELECT id FROM users WHERE tenant_id = ? AND phone = ?', [tid, phone])) {
      return fail(`手机号 ${phone} 已授权，请勿重复录入`, 'DUPLICATE', 409);
    }
    await checkSeat(db, req.tenant);

    const init = resolveInitialPassword(b);
    const id = await db.run(
      `INSERT INTO users (tenant_id, phone, name, password_hash, must_change_password,
                          initial_password, role, status, machine_code, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [tid, phone, String(b.name || '').trim() || '未命名', hashPassword(init), 1, init,
        b.role, 'ACTIVE', b.machineCode || null, nowStr(), nowStr()],
    );
    await audit(db, { tenantId: tid, userId: user.id, action: 'employee.authorize', detail: { phone, role: b.role } });
    return ok(
      { id: Number(id.insertId), phone, initial_password: init, must_change_password: true },
      `已授权 ${phone}（${roleZh(b.role)}），初始密码 ${init}，请告知本人`,
    );
  }));

  app.put('/api/admin/employees/:id', wrap(async (req) => {
    const user = adminOnly(req);
    const tid = user.tenant_id;
    const id = Number(req.params.id);
    const target = await db.get('SELECT * FROM users WHERE id = ? AND tenant_id = ?', [id, tid]);
    if (!target) return fail('员工不存在', 'NOT_FOUND', 404);
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) patch.name = String(b.name);
    if (b.role !== undefined) {
      if (!ALL_ROLES.includes(b.role)) return fail('角色不合法', 'BAD_ROLE', 400);
      patch.role = b.role;
    }
    if (b.status !== undefined) patch.status = String(b.status).toUpperCase();
    if (b.machineCode !== undefined) patch.machine_code = b.machineCode || null;
    patch.updated_at = nowStr();
    const keys = Object.keys(patch);
    if (keys.length) {
      await db.run(`UPDATE users SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ? AND tenant_id = ?`,
        [...keys.map((k) => patch[k]), id, tid]);
    }
    await audit(db, { tenantId: tid, userId: user.id, action: 'employee.update', detail: { id, ...patch } });
    return ok(patch, '已更新');
  }));

  app.delete('/api/admin/employees/:id', wrap(async (req) => {
    const user = adminOnly(req);
    const tid = user.tenant_id;
    const id = Number(req.params.id);
    const target = await db.get('SELECT * FROM users WHERE id = ? AND tenant_id = ?', [id, tid]);
    if (!target) return fail('员工不存在', 'NOT_FOUND', 404);
    if (target.role === 'ADMIN') {
      const admins = await db.get("SELECT COUNT(*) AS c FROM users WHERE tenant_id = ? AND role = 'ADMIN' AND status = 'ACTIVE'", [tid]);
      if (Number(admins?.c || 0) <= 1) return fail('至少要保留一名管理员', 'LAST_ADMIN', 400);
    }
    // 停用而非物理删除：保留历史报工与出库的归属
    await db.run('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', ['DISABLED', nowStr(), id]);
    await audit(db, { tenantId: tid, userId: user.id, action: 'employee.disable', detail: { id, phone: target.phone } });
    return ok(null, '已停用该账号');
  }));

  /**
   * 单人重置 / 下发初始密码。
   * 不传 password 时由系统随机生成；返回明文一次（服务端只存散列，明文仅此一回）。
   */
  app.post('/api/admin/employees/:id/password', wrap(async (req) => {
    const user = adminOnly(req);
    const tid = user.tenant_id;
    const id = Number(req.params.id);
    const target = await db.get('SELECT id, phone, name FROM users WHERE id = ? AND tenant_id = ?', [id, tid]);
    if (!target) return fail('员工不存在', 'NOT_FOUND', 404);
    const init = resolveInitialPassword(req.body || {});
    await db.run(
      `UPDATE users SET password_hash = ?, must_change_password = 1, password_updated_at = NULL,
                        initial_password = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
      [hashPassword(init), init, nowStr(), id, tid],
    );
    await audit(db, { tenantId: tid, userId: user.id, action: 'employee.reset_password', detail: { id, phone: target.phone } });
    return ok({ id, phone: target.phone, name: target.name, initial_password: init, must_change_password: true },
      `已为 ${target.phone} 下发初始密码 ${init}`);
  }));

  /**
   * 批量初始化密码：为本公司全部在职员工（或指定 id 列表）统一下发初始密码。
   * 不传 password 时每人各自随机生成，互不相同的明文只在本次响应中返回一次。
   */
  app.post('/api/admin/employees/init-passwords', wrap(async (req) => {
    const user = adminOnly(req);
    const tid = user.tenant_id;
    const b = req.body || {};
    const shared = b.password ? String(b.password) : null;
    if (shared && shared.length < 6) return fail('密码至少 6 位', 'WEAK_PASSWORD', 400);

    let rows;
    let args = [tid];
    let where = "tenant_id = ? AND status = 'ACTIVE'";
    if (Array.isArray(b.ids) && b.ids.length) {
      where += ` AND id IN (${b.ids.map(() => '?').join(',')})`;
      args = [...args, ...b.ids.map(Number)];
    }
    rows = await db.query(`SELECT id, phone, name FROM users WHERE ${where} ORDER BY id`, args);
    if (!rows.length) return fail('没有需要初始化的在职员工', 'NOT_FOUND', 404);

    const issued = [];
    for (const r of rows) {
      const pwd = shared || randomPassword();
      await db.run(
        `UPDATE users SET password_hash = ?, must_change_password = 1, password_updated_at = NULL,
                          initial_password = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
        [hashPassword(pwd), pwd, nowStr(), r.id, tid],
      );
      issued.push({ id: r.id, phone: r.phone, name: r.name, initial_password: pwd });
    }
    await audit(db, {
      tenantId: tid, userId: user.id, action: 'employee.init_passwords',
      detail: { count: issued.length, shared: !!shared, ids: issued.map((i) => i.id) },
    });
    return ok({ count: issued.length, items: issued },
      `已为 ${issued.length} 名员工下发初始密码，请逐一通知本人（明文仅本次返回）`);
  }));

  /* ------------------------------ AI 配置 ------------------------------ */
  /**
   * 层级说明：AI 接口由系统管理员在平台后台统一配置；
   * 平台放开覆盖开关时，各公司可在本页填写自己的 Key（只影响本公司）。
   */
  const readAi = async (tid) => (await db.get('SELECT * FROM ai_configs WHERE tenant_id = ?', [tid])) || null;

  app.get('/api/admin/ai-config', wrap(async (req) => {
    const user = adminOnly(req);
    const tid = user.tenant_id;
    const eff = await resolveAiConfig(db, tid);
    const mine = await readAi(tid);
    const g = await readGlobalAi(db);
    const effView = publicView(eff.config);
    return ok({
      /** 当前实际生效的配置（脱敏） */
      ...effView,
      /** 平台的接口地址/模型/密钥不属于本公司信息，公司侧一律不给：
       *  生效来源是平台时 base_url / model 置空，只有公司自己填的配置才回显 */
      base_url: eff.source === 'tenant' ? effView.base_url : null,
      model: eff.source === 'tenant' ? effView.model : null,
      source: eff.source,
      source_zh: eff.source_zh,
      /** 平台配置只给状态（是否启用/是否配了 Key），不给任何具体配置值 */
      platform: g
        ? { enabled: !!num(g.enabled, 0), api_key_set: !!String(g.api_key || '').trim(), allow_fallback: !!num(g.allow_fallback, 1) }
        : { enabled: false, api_key_set: false, allow_fallback: true },
      /** 本公司自己填的那份（可能为空 = 用平台配置） */
      mine: publicView(mine),
      allow_tenant_override: eff.allow_tenant_override,
      tenant_override: eff.tenant_override,
      last_test_ok: mine ? !!num(mine.last_test_ok, 0) : (g ? !!num(g.last_test_ok, 0) : false),
      last_test_msg: (eff.source === 'tenant' ? mine?.last_test_msg : g?.last_test_msg) || null,
      fallback_note: eff.config.api_key ? null : '未配置 API Key，自然语言将走确定性兜底解析器（无需联网）',
      /** 界面上直接展示的文字说明，避免管理员误解配置归属 */
      explain: eff.allow_tenant_override
        ? 'AI 接口由系统管理员在平台后台统一配置；本公司留空即使用平台配置，填写则只在本公司生效。'
        : '系统管理员已锁定 AI 接口配置，全平台统一生效；本公司不可修改。',
    });
  }));

  app.put('/api/admin/ai-config', wrap(async (req) => {
    const user = adminOnly(req);
    const b = req.body || {};
    const g = await readGlobalAi(db);
    if (g && !num(g.allow_tenant_override, 1)) {
      return fail('系统管理员已锁定 AI 接口配置，公司不可修改', 'AI_LOCKED_BY_PLATFORM', 403);
    }
    const patch = { updated_at: nowStr() };
    if (b.provider !== undefined) patch.provider = String(b.provider);
    if (b.baseUrl !== undefined) patch.base_url = String(b.baseUrl);
    if (b.apiKey !== undefined) patch.api_key = b.apiKey ? String(b.apiKey) : null;
    if (b.model !== undefined) patch.model = String(b.model);
    if (b.temperature !== undefined) patch.temperature = Number(b.temperature);
    if (b.timeoutMs !== undefined) patch.timeout_ms = Number(b.timeoutMs);
    if (b.enabled !== undefined) patch.enabled = b.enabled ? 1 : 0;
    if (b.allowFallback !== undefined) patch.allow_fallback = b.allow_fallback ? 1 : 0;
    /** 填了 Key 就是要用它：未显式指定启用开关时自动启用，避免"配了却没生效" */
    if (b.apiKey && b.enabled === undefined) patch.enabled = 1;
    const keys = Object.keys(patch);
    const n = await db.run(`UPDATE ai_configs SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE tenant_id = ?`,
      [...keys.map((k) => patch[k]), user.tenant_id]);
    if (!n.changes) {
      // 公司建租户时就有一条记录，理论上不会走到这里；兜底补一条
      await db.run(
        `INSERT INTO ai_configs (tenant_id, provider, base_url, api_key, model, temperature, timeout_ms, enabled, allow_fallback, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [user.tenant_id, patch.provider || 'OPENAI_COMPAT', patch.base_url || 'https://api.deepseek.com/v1',
          patch.api_key ?? null, patch.model || 'deepseek-chat', patch.temperature ?? 0.1,
          patch.timeout_ms ?? 20000, patch.enabled ?? 1, patch.allow_fallback ?? 1, nowStr()],
      );
    }
    await audit(db, { tenantId: user.tenant_id, userId: user.id, action: 'ai_config.update', detail: { ...b, apiKey: b.apiKey ? '***' : null } });
    return ok(null, '本公司 AI 配置已保存');
  }));

  /** 放弃本公司自定义，回落平台统一配置 */
  app.delete('/api/admin/ai-config', wrap(async (req) => {
    const user = adminOnly(req);
    const g = await readGlobalAi(db);
    if (g && !num(g.allow_tenant_override, 1)) {
      return fail('系统管理员已锁定 AI 接口配置，公司不可修改', 'AI_LOCKED_BY_PLATFORM', 403);
    }
    await db.run('UPDATE ai_configs SET api_key = NULL, enabled = 0, updated_at = ? WHERE tenant_id = ?',
      [nowStr(), user.tenant_id]);
    await audit(db, { tenantId: user.tenant_id, userId: user.id, action: 'ai_config.reset' });
    return ok(null, '已恢复使用平台统一配置');
  }));

  /** 联通性测试：按当前生效配置真发一条最小请求 */
  app.post('/api/admin/ai-config/test', wrap(async (req) => {
    const user = adminOnly(req);
    const eff = await resolveAiConfig(db, user.tenant_id);
    if (eff.source !== 'tenant') {
      // 生效的是平台配置：测试结果不写公司记录（公司无权改平台配置）
      return ok(await testAiConnection(eff.config));
    }
    const r = await testAiConnection(eff.config, async (okFlag, msg) => {
      await db.run('UPDATE ai_configs SET last_test_ok = ?, last_test_msg = ?, updated_at = ? WHERE tenant_id = ?',
        [okFlag ? 1 : 0, msg, nowStr(), user.tenant_id]);
    });
    return ok(r);
  }));

  /* ------------------------------ 角色字典 ---------------------------- */
  app.get('/api/admin/roles', wrap(async (req) => {
    requirePerm(req, 'employee.manage');
    return ok(Object.entries(ROLES).map(([k, v]) => ({ role: k, ...v })));
  }));

  /* ------------------------------ 审计日志 ---------------------------- */
  app.get('/api/admin/audit', wrap(async (req) => {
    const user = requirePerm(req, 'audit.read');
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const rows = await db.query(
      'SELECT id, user_id, action, detail, created_at FROM audit_logs WHERE tenant_id = ? ORDER BY id DESC LIMIT ?',
      [user.tenant_id, limit],
    );
    return ok(rows);
  }));
}

/**
 * 初始密码取值：管理员显式指定则用之（不足 6 位直接报错），未指定则随机生成 6 位数字。
 * 明文只在接口响应里出现一次，库里只存 scrypt 散列。
 */
function resolveInitialPassword(b) {
  const given = b.password === undefined || b.password === null || b.password === '' ? null : String(b.password);
  if (given === null) return randomPassword();
  if (given.length < 6) throw new AppError('初始密码至少 6 位', 400, 'WEAK_PASSWORD');
  return given;
}

