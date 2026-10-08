/**
 * 登录与身份。
 * 关键约束：
 *  1. **只有管理员录入过的手机号才能登录**——未授权的手机号一律拒绝，
 *     并提示联系本公司管理员，避免任何人拿到 APP 就能进系统。
 *  2. **只认手机号 + 密码**：v3.4 起短信验证码登录下线，改为管理员下发初始密码，
 *     员工凭「手机号 + 初始密码」登录，登录后可自行决定是否修改。
 */
import { wrap, ok, fail, AppError } from '../lib/http.js';
import { signJwt, verifyPassword, hashPassword } from '../lib/auth.js';
import { nowStr, toDate } from '../lib/util.js';
import { permissionsOf, roleZh, ROLES } from '../lib/rbac.js';

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
      /** 仍在使用管理员下发的初始密码：客户端弹窗提示，员工可自行选择是否修改 */
      must_change_password: !!user.must_change_password,
      password_hint: user.must_change_password
        ? '当前使用的是管理员下发的初始密码，建议修改为本人密码'
        : null,
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

  /* ------------------------ 手机号 + 密码登录 ------------------------ */
  app.post('/api/auth/login', wrap(async (req) => {
    const { phone, password, tenantCode } = req.body || {};
    if (!phone || !password) return fail('手机号与密码不能为空', 'PARAM_MISSING', 400);
    const row = pickTenant(await locate(String(phone).trim(), tenantCode), tenantCode);
    const tenant = guardTenant(row);
    if (!row.password_hash) {
      return fail('该账号尚未设置初始密码，请联系贵公司管理员在后台设置', 'NO_PASSWORD', 403);
    }
    if (!verifyPassword(String(password), row.password_hash)) {
      return fail('手机号或密码不正确', 'BAD_CREDENTIALS', 401);
    }
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
      must_change_password: !!user.must_change_password,
      password_updated_at: user.password_updated_at || null,
      tenant: { id: tenant.id, code: tenant.code, name: tenant.name, expires_at: tenant.expires_at, max_users: tenant.max_users },
      roles_available: Object.entries(ROLES).map(([k, v]) => ({ role: k, zh: v.zh, desc: v.desc })),
    });
  }));

  /* ------------------------------ 修改密码 ------------------------------ */
  /** 员工自行修改密码：改完即视为已接管账号，不再提示修改 */
  app.post('/api/auth/password', wrap(async (req) => {
    const user = requireUser(req);
    const { oldPassword, newPassword } = req.body || {};
    const np = String(newPassword || '');
    if (np.length < 6) return fail('新密码至少 6 位', 'WEAK_PASSWORD', 400);
    if (user.password_hash) {
      if (!verifyPassword(String(oldPassword || ''), user.password_hash)) {
        return fail('原密码不正确', 'BAD_CREDENTIALS', 400);
      }
      if (verifyPassword(np, user.password_hash)) {
        return fail('新密码不能与当前密码相同', 'SAME_PASSWORD', 400);
      }
    }
    await db.run(
      `UPDATE users SET password_hash = ?, must_change_password = 0, password_updated_at = ?, updated_at = ?
       WHERE id = ?`,
      [hashPassword(np), nowStr(), nowStr(), user.id],
    );
    return ok({ must_change_password: false }, '密码已修改，下次登录请使用新密码');
  }));

  /** 暂不修改：保留管理员下发的初始密码，只关掉本次提醒 */
  app.post('/api/auth/password/later', wrap(async (req) => {
    const user = requireUser(req);
    if (!user.must_change_password) return ok({ must_change_password: false }, '无需处理');
    await db.run('UPDATE users SET must_change_password = 0, updated_at = ? WHERE id = ?', [nowStr(), user.id]);
    return ok({ must_change_password: false }, '已保留初始密码，可在「我的 · 修改密码」随时更改');
  }));

  /** 平台超管：用口令换取平台令牌（仅用于创建公司与调整授权） */
  app.post('/api/platform/login', wrap(async (req) => {
    const { token } = req.body || {};
    if (token !== ctx.config.platformToken) return fail('平台口令不正确', 'BAD_TOKEN', 401);
    const t = signJwt({ uid: 0, tid: 0, role: 'PLATFORM' }, 12);
    return ok({ token: t, role: 'PLATFORM' }, '平台登录成功');
  }));
}
