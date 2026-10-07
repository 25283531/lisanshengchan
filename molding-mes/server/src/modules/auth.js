/**
 * 登录与身份。
 * 关键约束：**只有管理员录入过的手机号才能登录**——未授权的手机号一律拒绝，
 * 并提示联系本公司管理员，避免任何人拿到 APP 就能进系统。
 */
import { wrap, ok, fail, AppError } from '../lib/http.js';
import { signJwt, verifyPassword, hashPassword, makeCode } from '../lib/auth.js';
import { nowStr, toDate } from '../lib/util.js';
import { permissionsOf, roleZh, ROLES } from '../lib/rbac.js';

const smsCodes = new Map(); // phone -> { code, exp }

export default function registerAuthRoutes(app, db, ctx) {
  const { requireUser } = ctx;

  const issue = async (user, tenant) => {
    const token = signJwt({ uid: user.id, tid: tenant.id, role: user.role });
    await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowStr(), user.id]);
    return {
      token,
      token_type: 'Bearer',
      expires_in_hours: ctx.config.tokenTtlHours,
      user: {
        id: user.id, phone: user.phone, name: user.name, role: user.role,
        role_zh: roleZh(user.role), machine_code: user.machine_code,
        permissions: permissionsOf(user.role),
      },
      tenant: {
        id: tenant.id, code: tenant.code, name: tenant.name,
        expires_at: tenant.expires_at, max_users: tenant.max_users,
      },
    };
  };

  const locate = async (phone, tenantCode) => {
    let rows;
    if (tenantCode) {
      rows = await db.query(
        `SELECT u.*, t.code AS tenant_code, t.name AS tenant_name, t.status AS tenant_status,
                t.expires_at, t.max_users
         FROM users u JOIN tenants t ON t.id = u.tenant_id
         WHERE u.phone = ? AND t.code = ?`,
        [phone, tenantCode],
      );
    } else {
      rows = await db.query(
        `SELECT u.*, t.code AS tenant_code, t.name AS tenant_name, t.status AS tenant_status,
                t.expires_at, t.max_users
         FROM users u JOIN tenants t ON t.id = u.tenant_id
         WHERE u.phone = ?`,
        [phone],
      );
    }
    return rows;
  };

  const pickTenant = (rows, tenantCode) => {
    if (!rows.length) {
      throw new AppError('该手机号尚未获得授权，请联系贵公司管理员先在后台录入手机号', 403, 'NOT_AUTHORIZED');
    }
    if (rows.length > 1 && !tenantCode) {
      const err = new AppError('该手机号属于多家公司，请选择要登录的公司', 300, 'MULTI_TENANT');
      err.extra = { tenants: rows.map((r) => ({ id: r.tenant_id, code: r.tenant_code, name: r.tenant_name })) };
      throw err;
    }
    return rows[0];
  };

  const guardTenant = (row) => {
    if (row.tenant_status !== 'ACTIVE') throw new AppError(`公司状态为 ${row.tenant_status}，已停止服务`, 403, 'TENANT_INACTIVE');
    if (row.expires_at && toDate(row.expires_at) < new Date()) {
      throw new AppError(`公司授权已于 ${row.expires_at} 到期，请联系管理员续期`, 403, 'TENANT_EXPIRED');
    }
    if (row.status !== 'ACTIVE') throw new AppError('账号已被停用，请联系管理员', 403, 'USER_DISABLED');
    return {
      id: row.tenant_id, code: row.tenant_code, name: row.tenant_name,
      expires_at: row.expires_at, max_users: row.max_users, status: row.tenant_status,
    };
  };

  /* ------------------------------ 密码登录 ------------------------------ */
  app.post('/api/auth/login', wrap(async (req) => {
    const { phone, password, tenantCode } = req.body || {};
    if (!phone || !password) return fail('手机号与密码不能为空', 'PARAM_MISSING', 400);
    const row = pickTenant(await locate(String(phone).trim(), tenantCode), tenantCode);
    const tenant = guardTenant(row);
    if (!row.password_hash) return fail('该账号尚未设置密码，请使用验证码登录', 'NO_PASSWORD', 400);
    if (!verifyPassword(String(password), row.password_hash)) return fail('手机号或密码不正确', 'BAD_CREDENTIALS', 401);
    return ok(await issue(row, tenant), '登录成功');
  }));

  /* --------------------------- 验证码（演示） --------------------------- */
  app.post('/api/auth/sms/send', wrap(async (req) => {
    const { phone, tenantCode } = req.body || {};
    if (!phone) return fail('手机号不能为空', 'PARAM_MISSING', 400);
    const rows = await locate(String(phone).trim(), tenantCode);
    if (!rows.length) return fail('该手机号尚未获得授权，请联系贵公司管理员录入', 'NOT_AUTHORIZED', 403);
    const code = makeCode();
    smsCodes.set(String(phone).trim(), { code, exp: Date.now() + 5 * 60000 });
    const demo = process.env.NODE_ENV !== 'production';
    return ok({ sent: true, /** 演示模式直接返回验证码，生产需接短信网关后删除 */ demo_code: demo ? code : undefined },
      '验证码已发送');
  }));

  app.post('/api/auth/sms/login', wrap(async (req) => {
    const { phone, code, tenantCode } = req.body || {};
    const key = String(phone || '').trim();
    const rec = smsCodes.get(key);
    if (!rec || rec.exp < Date.now()) return fail('验证码不存在或已过期', 'CODE_EXPIRED', 400);
    if (String(rec.code) !== String(code)) return fail('验证码不正确', 'CODE_WRONG', 400);
    smsCodes.delete(key);
    const row = pickTenant(await locate(key, tenantCode), tenantCode);
    const tenant = guardTenant(row);
    return ok(await issue(row, tenant), '登录成功');
  }));

  /* -------------------------------- 我的 -------------------------------- */
  app.get('/api/auth/me', wrap(async (req) => {
    const user = requireUser(req);
    const tenant = req.tenant;
    return ok({
      id: user.id, phone: user.phone, name: user.name, role: user.role,
      role_zh: roleZh(user.role), machine_code: user.machine_code,
      permissions: permissionsOf(user.role),
      tenant: { id: tenant.id, code: tenant.code, name: tenant.name, expires_at: tenant.expires_at, max_users: tenant.max_users },
      roles_available: Object.entries(ROLES).map(([k, v]) => ({ role: k, zh: v.zh, desc: v.desc })),
    });
  }));

  /* ------------------------------ 修改密码 ------------------------------ */
  app.post('/api/auth/password', wrap(async (req) => {
    const user = requireUser(req);
    const { oldPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 6) return fail('新密码至少 6 位', 'WEAK_PASSWORD', 400);
    if (user.password_hash && !verifyPassword(String(oldPassword || ''), user.password_hash)) {
      return fail('原密码不正确', 'BAD_CREDENTIALS', 400);
    }
    await db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
      [hashPassword(String(newPassword)), nowStr(), user.id]);
    return ok(null, '密码已修改');
  }));

  /** 平台超管：用口令换取平台令牌（仅用于创建公司与调整授权） */
  app.post('/api/platform/login', wrap(async (req) => {
    const { token } = req.body || {};
    if (token !== ctx.config.platformToken) return fail('平台口令不正确', 'BAD_TOKEN', 401);
    const t = signJwt({ uid: 0, tid: 0, role: 'PLATFORM' }, 12);
    return ok({ token: t, role: 'PLATFORM' }, '平台登录成功');
  }));
}
