/**
 * 平台侧（软件供应商/运维）：以公司为单位注册租户、配置授权（用户数、期限）。
 * 公司注册后，由该公司的管理员登录后台录入基础数据并授权员工。
 */
import { wrap, ok, fail, AppError } from '../lib/http.js';
import { hashPassword } from '../lib/auth.js';
import { nowStr, toStr, num, randomPassword } from '../lib/util.js';
import { audit } from '../lib/repo.js';
import { readGlobalAi, publicView, envAiConfig, testAiConnection } from '../domain/ai-config.js';
import { readLogs, logStats } from '../lib/logbuf.js';

const PHONE_RE = /^1[3-9]\d{9}$/;

/**
 * 公司列表里的一行：补上管理员账号（= 管理员手机号）与初始密码。
 * 初始密码只在管理员还没自行改密时存在；改过就为 null，界面显示「已自行修改」。
 */
const shapeTenant = (t, admin) => ({
  ...t,
  admin_user_id: admin?.id || null,
  admin_phone: admin?.phone || t.contact_phone || null,
  admin_name: admin?.name || t.contact_name || null,
  admin_status: admin?.status || null,
  admin_initial_password: admin?.initial_password || null,
  admin_last_login_at: admin?.last_login_at || null,
  admin_password_updated_at: admin?.password_updated_at || null,
  has_admin: !!admin,
});

const requirePlatform = (req) => {
  if (!req.user || req.user.role !== 'PLATFORM') {
    throw new AppError('需要平台管理员令牌', 401, 'PLATFORM_REQUIRED');
  }
  return req.user;
};

export default function registerPlatformRoutes(app, db, ctx) {
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/platform')) return;
    const raw = req.headers.authorization || '';
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : (req.headers['x-token'] || '');
    if (!token) return;
    const { verifyJwt } = await import('../lib/auth.js');
    const p = verifyJwt(token);
    if (p && p.role === 'PLATFORM') {
      req.user = { id: 0, tenant_id: 0, role: 'PLATFORM', name: '平台管理员', status: 'ACTIVE' };
    }
  });

  /** 注册公司：同时建好第一个管理员账号（注册者不需要再被任何人授权） */
  app.post('/api/platform/tenants', wrap(async (req) => {
    requirePlatform(req);
    const b = req.body || {};
    const code = String(b.code || '').trim();
    const name = String(b.name || '').trim();
    const adminPhone = String(b.adminPhone || '').trim();
    if (!code || !name || !adminPhone) return fail('公司编码、名称、管理员手机号必填', 'PARAM_MISSING', 400);
    if (!PHONE_RE.test(adminPhone)) {
      return fail('管理员手机号格式不正确（需 11 位中国大陆号码）', 'BAD_PHONE', 400);
    }
    if (await db.get('SELECT id FROM tenants WHERE code = ?', [code])) {
      return fail(`公司编码 ${code} 已存在`, 'DUPLICATE', 409);
    }
    if (await db.get('SELECT id FROM tenants WHERE name = ?', [name])) {
      return fail(`公司名称 ${name} 已存在`, 'DUPLICATE', 409);
    }

    /** 初始密码：不填就随机 6 位数字；明文存一份，平台列表里要能直接看到并告知本人 */
    const init = b.adminPassword ? String(b.adminPassword) : randomPassword();
    if (init.length < 6) return fail('初始密码至少 6 位', 'WEAK_PASSWORD', 400);

    const tenantId = await db.transaction(async () => {
      const now = nowStr();
      const r = await db.run(
        `INSERT INTO tenants (code, name, status, max_users, expires_at, contact_name, contact_phone, industry_note, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [code, name, 'ACTIVE', Number(b.maxUsers || 20), b.expiresAt || null,
          b.adminName || null, adminPhone, b.industryNote || null, now, now],
      );
      const tid = Number(r.insertId);

      await db.run(
        `INSERT INTO users (tenant_id, phone, name, password_hash, must_change_password,
                            initial_password, role, status, machine_code, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [tid, adminPhone, String(b.adminName || '').trim() || '管理员', hashPassword(init), 1,
          init, 'ADMIN', 'ACTIVE', null, now, now],
      );

      await db.run(
        `INSERT INTO ai_configs (tenant_id, provider, base_url, api_key, model, temperature, timeout_ms, enabled, allow_fallback, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [tid, 'OPENAI_COMPAT', ctx.config.ai.baseUrl, ctx.config.ai.apiKey || null,
          ctx.config.ai.model, ctx.config.ai.temperature, ctx.config.ai.timeoutMs, 1, 1, now],
      );
      return tid;
    });

    await audit(db, { action: 'platform.tenant.create', detail: { code, name, adminPhone, maxUsers: b.maxUsers } });
    return ok(
      { id: tenantId, code, name, adminPhone, admin_user_id: null, initial_password: init },
      `公司「${name}」已注册：管理员账号 ${adminPhone}，初始密码 ${init}（请告知本人，登录后建议修改）`,
    );
  }));

  app.get('/api/platform/tenants', wrap(async (req) => {
    requirePlatform(req);
    const rows = await db.query(
      `SELECT t.*, (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.status='ACTIVE') AS used_users
       FROM tenants t ORDER BY t.id DESC`,
    );
    // 管理员单独取一次再拼：避免 LEFT JOIN + GROUP BY 在 MySQL 的 ONLY_FULL_GROUP_BY 下报错
    const admins = await db.query(
      `SELECT tenant_id, id, phone, name, status, initial_password, last_login_at, password_updated_at
       FROM users WHERE role = 'ADMIN' ORDER BY id`,
    );
    const byTenant = new Map();
    for (const a of admins) if (!byTenant.has(a.tenant_id)) byTenant.set(a.tenant_id, a);
    return ok(rows.map((r) => shapeTenant(r, byTenant.get(r.id))));
  }));

  app.get('/api/platform/tenants/:id', wrap(async (req) => {
    requirePlatform(req);
    const t = await db.get('SELECT * FROM tenants WHERE id = ?', [req.params.id]);
    if (!t) return fail('公司不存在', 'NOT_FOUND', 404);
    const users = await db.query(
      'SELECT id, phone, name, role, status, machine_code, initial_password FROM users WHERE tenant_id = ? ORDER BY id',
      [t.id],
    );
    const admin = users.find((u) => u.role === 'ADMIN') || null;
    return ok({
      ...t,
      admin_phone: admin?.phone || t.contact_phone || null,
      admin_name: admin?.name || t.contact_name || null,
      admin_initial_password: admin?.initial_password || null,
      users,
    });
  }));

  /**
   * 改公司管理员（注册者）的手机号 / 姓名。
   * 平台经常要在开账号后修正号码（录错、换人），而公司自己没人能改管理员手机号。
   */
  app.put('/api/platform/tenants/:id/admin', wrap(async (req) => {
    requirePlatform(req);
    const id = Number(req.params.id);
    const b = req.body || {};
    const t = await db.get('SELECT * FROM tenants WHERE id = ?', [id]);
    if (!t) return fail('公司不存在', 'NOT_FOUND', 404);
    const phone = b.adminPhone === undefined ? null : String(b.adminPhone || '').trim();
    if (phone !== null && !PHONE_RE.test(phone)) {
      return fail('管理员手机号格式不正确（需 11 位中国大陆号码）', 'BAD_PHONE', 400);
    }
    const admin = await db.get("SELECT * FROM users WHERE tenant_id = ? AND role = 'ADMIN' ORDER BY id LIMIT 1", [id]);
    if (!admin) return fail('该公司没有管理员账号', 'NOT_FOUND', 404);

    const now = nowStr();
    if (phone && phone !== admin.phone) {
      if (await db.get('SELECT id FROM users WHERE tenant_id = ? AND phone = ? AND id <> ?', [id, phone, admin.id])) {
        return fail(`本公司已存在手机号 ${phone}`, 'DUPLICATE', 409);
      }
    }
    await db.run('UPDATE users SET phone = ?, name = ?, updated_at = ? WHERE id = ?',
      [phone || admin.phone, b.adminName ? String(b.adminName) : admin.name, now, admin.id]);
    await db.run('UPDATE tenants SET contact_phone = ?, contact_name = ?, updated_at = ? WHERE id = ?',
      [phone || admin.phone, b.adminName ? String(b.adminName) : (t.contact_name || admin.name), now, id]);
    await audit(db, { tenantId: id, action: 'platform.admin.update', detail: { id: admin.id, phone, name: b.adminName } });
    return ok({ id: admin.id, phone: phone || admin.phone, name: b.adminName || admin.name }, '管理员账号已更新');
  }));

  /** 调整授权：用户数、期限、状态 */
  app.put('/api/platform/tenants/:id/license', wrap(async (req) => {
    requirePlatform(req);
    const b = req.body || {};
    const id = Number(req.params.id);
    const t = await db.get('SELECT * FROM tenants WHERE id = ?', [id]);
    if (!t) return fail('公司不存在', 'NOT_FOUND', 404);
    const patch = {};
    if (b.maxUsers !== undefined) patch.max_users = Number(b.maxUsers);
    if (b.expiresAt !== undefined) patch.expires_at = b.expiresAt || null;
    if (b.status !== undefined) patch.status = String(b.status).toUpperCase();
    if (b.name !== undefined) patch.name = String(b.name);
    patch.updated_at = nowStr();
    const keys = Object.keys(patch);
    await db.run(`UPDATE tenants SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`,
      [...keys.map((k) => patch[k]), id]);
    await audit(db, { tenantId: id, action: 'platform.license.update', detail: patch });
    return ok(patch, '授权已更新');
  }));

  /** 重置公司管理员密码：不传则随机 6 位；明文同步入库，列表里可直接看到 */
  app.post('/api/platform/tenants/:id/reset-admin', wrap(async (req) => {
    requirePlatform(req);
    const id = Number(req.params.id);
    const b = req.body || {};
    const pwd = b.password ? String(b.password) : randomPassword();
    if (pwd.length < 6) return fail('密码至少 6 位', 'WEAK_PASSWORD', 400);
    const admin = await db.get("SELECT * FROM users WHERE tenant_id = ? AND role = 'ADMIN' ORDER BY id LIMIT 1", [id]);
    if (!admin) return fail('该公司没有管理员账号', 'NOT_FOUND', 404);
    await db.run(
      `UPDATE users SET password_hash = ?, must_change_password = 1, password_updated_at = NULL,
                        initial_password = ?, updated_at = ?
       WHERE id = ?`,
      [hashPassword(pwd), pwd, nowStr(), admin.id],
    );
    await audit(db, { tenantId: id, action: 'platform.admin.reset_password', detail: { user_id: admin.id } });
    return ok(
      { id: admin.id, phone: admin.phone, name: admin.name, initial_password: pwd },
      `管理员 ${admin.phone} 密码已重置为 ${pwd}（请告知本人）`,
    );
  }));

  /* ------------------- 平台级 AI 接口配置（系统管理员） ------------------- */

  app.get('/api/platform/ai-config', wrap(async (req) => {
    requirePlatform(req);
    const g = await readGlobalAi(db);
    // 哪些公司自己覆盖了配置：平台要能一眼看到，避免"公司配错了来找平台"
    const overrides = await db.query(
      `SELECT t.id, t.code, t.name, a.model, a.base_url, a.enabled
       FROM ai_configs a JOIN tenants t ON t.id = a.tenant_id
       WHERE a.api_key IS NOT NULL AND a.api_key <> '' ORDER BY t.id`,
    );
    return ok({
      ...(publicView(g) || publicView(envAiConfig())),
      allow_tenant_override: g ? !!num(g.allow_tenant_override, 1) : true,
      last_test_ok: g ? !!num(g.last_test_ok, 0) : false,
      last_test_msg: g?.last_test_msg || null,
      updated_by: g?.updated_by || null,
      updated_at: g?.updated_at || null,
      source: g ? 'platform' : 'env',
      tenant_overrides: overrides,
    });
  }));

  app.put('/api/platform/ai-config', wrap(async (req) => {
    requirePlatform(req);
    const b = req.body || {};
    const g = await readGlobalAi(db);
    const patch = { updated_at: nowStr(), updated_by: '平台管理员' };
    if (b.provider !== undefined) patch.provider = String(b.provider);
    if (b.baseUrl !== undefined) patch.base_url = String(b.baseUrl);
    if (b.apiKey !== undefined) patch.api_key = b.apiKey ? String(b.apiKey) : null;
    if (b.model !== undefined) patch.model = String(b.model);
    if (b.temperature !== undefined) patch.temperature = Number(b.temperature);
    if (b.timeoutMs !== undefined) patch.timeout_ms = Number(b.timeoutMs);
    if (b.enabled !== undefined) patch.enabled = b.enabled ? 1 : 0;
    if (b.allowFallback !== undefined) patch.allow_fallback = b.allow_fallback ? 1 : 0;
    if (b.allowTenantOverride !== undefined) patch.allow_tenant_override = b.allowTenantOverride ? 1 : 0;
    /** 同上：填了 Key 就默认启用 */
    if (b.apiKey && b.enabled === undefined) patch.enabled = 1;

    if (g) {
      const keys = Object.keys(patch);
      await db.run(`UPDATE ai_global_configs SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`,
        [...keys.map((k) => patch[k]), g.id]);
    } else {
      const e = envAiConfig();
      const keys = Object.keys(patch);
      await db.run(
        `INSERT INTO ai_global_configs (${keys.map((k) => `\`${k}\``).join(', ')}, provider, base_url, api_key, model, temperature, timeout_ms, enabled, allow_fallback)
         VALUES (${keys.map(() => '?').join(', ')}, ?,?,?,?,?,?,?,?)`,
        [...keys.map((k) => patch[k]), patch.provider ?? e.provider, patch.base_url ?? e.base_url,
          patch.api_key !== undefined ? patch.api_key : e.api_key, patch.model ?? e.model,
          patch.temperature ?? e.temperature, patch.timeout_ms ?? e.timeout_ms,
          patch.enabled ?? e.enabled, patch.allow_fallback ?? e.allow_fallback],
      );
    }
    await audit(db, { action: 'platform.ai_config.update', detail: { ...b, apiKey: b.apiKey ? '***' : null } });
    return ok(null, '平台 AI 配置已保存');
  }));

  app.post('/api/platform/ai-config/test', wrap(async (req) => {
    requirePlatform(req);
    const g = await readGlobalAi(db);
    if (!g) return fail('尚未初始化平台 AI 配置', 'NOT_FOUND', 404);
    const r = await testAiConnection(g, async (okFlag, msg) => {
      await db.run('UPDATE ai_global_configs SET last_test_ok = ?, last_test_msg = ?, updated_at = ? WHERE id = ?',
        [okFlag ? 1 : 0, msg, nowStr(), g.id]);
    });
    return ok(r);
  }));

  /**
   * 运行日志：直接读服务端内存里的环形缓冲（最新 500 条），省掉 SSH + docker logs。
   * level 传 warn / error 可只看告警及以上。
   */
  app.get('/api/platform/logs', wrap(async (req) => {
    requirePlatform(req);
    const q = req.query || {};
    const limit = Math.min(Number(q.limit || 200), 500);
    const level = q.level ? String(q.level) : null;
    /** requests=0 时滤掉 Fastify 的请求日志（每条请求两行，最容易把业务日志挤掉） */
    const hideRequests = String(q.requests ?? '1') === '0';
    return ok({
      log_level: ctx.config.logLevel,
      stats: logStats(),
      hide_requests: hideRequests,
      items: readLogs({ limit, level, hideRequests }),
    });
  }));

  app.get('/api/platform/stats', wrap(async (req) => {
    requirePlatform(req);
    const tenants = await db.get('SELECT COUNT(*) AS c FROM tenants');
    const users = await db.get("SELECT COUNT(*) AS c FROM users WHERE role <> 'ADMIN'");
    const orders = await db.get('SELECT COUNT(*) AS c FROM orders');
    const expiring = await db.query(
      `SELECT id, code, name, expires_at FROM tenants
       WHERE expires_at IS NOT NULL AND expires_at < ? ORDER BY expires_at LIMIT 20`,
      [toStr(new Date(Date.now() + 30 * 86400000))],
    );
    return ok({
      tenants: Number(tenants?.c || 0),
      employees: Number(users?.c || 0),
      orders: Number(orders?.c || 0),
      expiring_soon: expiring,
    });
  }));
}
