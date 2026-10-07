/**
 * 平台侧（软件供应商/运维）：以公司为单位注册租户、配置授权（用户数、期限）。
 * 公司注册后，由该公司的管理员登录后台录入基础数据并授权员工。
 */
import { wrap, ok, fail, AppError } from '../lib/http.js';
import { hashPassword } from '../lib/auth.js';
import { nowStr, toStr } from '../lib/util.js';
import { audit } from '../lib/repo.js';

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

  /** 注册公司 */
  app.post('/api/platform/tenants', wrap(async (req) => {
    requirePlatform(req);
    const b = req.body || {};
    const code = String(b.code || '').trim();
    const name = String(b.name || '').trim();
    const adminPhone = String(b.adminPhone || '').trim();
    if (!code || !name || !adminPhone) return fail('公司编码、名称、管理员手机号必填', 'PARAM_MISSING', 400);
    if (await db.get('SELECT id FROM tenants WHERE code = ?', [code])) {
      return fail(`公司编码 ${code} 已存在`, 'DUPLICATE', 409);
    }

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
        `INSERT INTO users (tenant_id, phone, name, password_hash, role, status, machine_code, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [tid, adminPhone, b.adminName || '管理员', hashPassword(String(b.adminPassword || '123456')),
          'ADMIN', 'ACTIVE', null, now, now],
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
    return ok({ id: tenantId, code, name, adminPhone }, `公司「${name}」已注册，管理员可用手机号 ${adminPhone} 登录`);
  }));

  app.get('/api/platform/tenants', wrap(async (req) => {
    requirePlatform(req);
    const rows = await db.query(
      `SELECT t.*, (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.status='ACTIVE') AS used_users
       FROM tenants t ORDER BY t.id DESC`,
    );
    return ok(rows);
  }));

  app.get('/api/platform/tenants/:id', wrap(async (req) => {
    requirePlatform(req);
    const t = await db.get('SELECT * FROM tenants WHERE id = ?', [req.params.id]);
    if (!t) return fail('公司不存在', 'NOT_FOUND', 404);
    const users = await db.query('SELECT id, phone, name, role, status, machine_code FROM users WHERE tenant_id = ? ORDER BY id', [t.id]);
    return ok({ ...t, users });
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

  /** 重置公司管理员密码 */
  app.post('/api/platform/tenants/:id/reset-admin', wrap(async (req) => {
    requirePlatform(req);
    const id = Number(req.params.id);
    const pwd = String((req.body || {}).password || '123456');
    const admin = await db.get("SELECT * FROM users WHERE tenant_id = ? AND role = 'ADMIN' ORDER BY id LIMIT 1", [id]);
    if (!admin) return fail('该公司没有管理员账号', 'NOT_FOUND', 404);
    await db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [hashPassword(pwd), nowStr(), admin.id]);
    await audit(db, { tenantId: id, action: 'platform.admin.reset_password', detail: { user_id: admin.id } });
    return ok({ phone: admin.phone }, '管理员密码已重置');
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
