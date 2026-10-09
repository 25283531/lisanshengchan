/**
 * 登录与身份。
 * 关键约束：
 *  1. **只有管理员录入过的手机号才能登录**——未授权的手机号一律拒绝，
 *     并提示联系本公司管理员，避免任何人拿到 APP 就能进系统。
 *  2. **只认手机号 + 密码**：v3.4 起短信验证码登录下线，改为管理员下发初始密码，
 *     员工凭「手机号 + 初始密码」登录，登录后可自行决定是否修改。
 *  3. **公司第一个管理员（注册者）不需要先在后台授权**——v3.7：
 *     员工授权页面只有登录进去才看得到，若要求注册者先被授权就成死循环。
 *     因此「平台注册公司时登记的手机号」永远可以直接登录：
 *     正常情况由平台注册流程直接建号；万一公司里一个管理员都没有（历史数据、
 *     管理员被停用等），登录时按 `tenants.contact_phone` 自动补建管理员账号（见 bootstrapFirstAdmin）。
 */
import { wrap, ok, fail, AppError } from '../lib/http.js';
import { signJwt, verifyPassword, hashPassword } from '../lib/auth.js';
import { nowStr, toDate, randomPassword } from '../lib/util.js';
import { audit } from '../lib/repo.js';
import { permissionsOf, roleZh, ROLES } from '../lib/rbac.js';

/** 手机号从未被任何公司录入时的提示：顺带说清"第一个管理员不用先授权"，省掉一轮来回 */
const NOT_AUTHORIZED_MSG =
  '该手机号尚未获得授权，请联系贵公司管理员先在后台录入手机号（公司第一个管理员由平台注册时登记，可直接登录）';

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

  /**
   * 按手机号找出该账号所属的公司。
   * tenantHint 允许填**公司编码或公司名称**：多数用户分不清这两个，
   * 早期只认编码，填了名称就报「手机号尚未获得授权」，把人往完全错误的方向带。
   */
  const locate = async (phone, tenantHint) => {
    const common = `SELECT u.*, t.code AS tenant_code, t.name AS tenant_name, t.status AS tenant_status,
                           t.expires_at, t.max_users
                    FROM users u JOIN tenants t ON t.id = u.tenant_id
                    WHERE u.phone = ?`;
    if (tenantHint) {
      return db.query(`${common} AND (t.code = ? OR t.name = ?) ORDER BY u.id`,
        [phone, tenantHint, tenantHint]);
    }
    return db.query(`${common} ORDER BY u.id`, [phone]);
  };

  const pickTenant = async (rows, phone, tenantHint) => {
    if (!rows.length) {
      // 区分三种情况，别把"公司填错了"说成"手机号没授权"
      const elsewhere = await db.query(
        `SELECT t.id, t.code, t.name FROM users u JOIN tenants t ON t.id = u.tenant_id
         WHERE u.phone = ? ORDER BY t.id`,
        [phone],
      );
      if (tenantHint) {
        const hintExists = await db.get('SELECT code, name FROM tenants WHERE code = ? OR name = ?',
          [tenantHint, tenantHint]);
        if (!hintExists) {
          throw new AppError(
            `没有找到编码或名称为「${tenantHint}」的公司，请填写公司编码（不是联系人/管理员姓名）`,
            404, 'TENANT_NOT_FOUND',
          );
        }
        // 手机号在任何公司都没被录入过：这是"没授权"，不是"公司填错"
        if (!elsewhere.length) throw new AppError(NOT_AUTHORIZED_MSG, 403, 'NOT_AUTHORIZED');
        throw new AppError(
          `手机号 ${phone} 不属于公司「${hintExists.name}（${hintExists.code}）」，请确认公司编码是否正确`,
          403, 'TENANT_MISMATCH',
        );
      }
      if (elsewhere.length) {
        // 该手机号在别的公司被授权过：多半是公司选错，直接把可选项抛给客户端
        const err = new AppError('该手机号不属于当前公司，请选择要登录的公司', 300, 'MULTI_TENANT');
        err.extra = { tenants: elsewhere.map((r) => ({ id: r.id, code: r.code, name: r.name })) };
        throw err;
      }
      throw new AppError(NOT_AUTHORIZED_MSG, 403, 'NOT_AUTHORIZED');
    }
    if (rows.length > 1 && !tenantHint) {
      const err = new AppError('该手机号属于多家公司，请选择要登录的公司', 300, 'MULTI_TENANT');
      err.extra = { tenants: rows.map((r) => ({ id: r.tenant_id, code: r.tenant_code, name: r.tenant_name })) };
      throw err;
    }
    return rows[0];
  };

  /**
   * 公司第一个管理员（注册者）自助开箱。
   *
   * 死循环问题：员工授权页面只有登录后才进得去，若注册者也要先被授权，就永远进不来。
   * 所以只要某公司**一个管理员都没有**，而登录手机号正是平台登记的公司联系人手机号，
   * 就直接补建一个 ADMIN 账号——注册者无需任何人先授权。
   *
   * 只认 tenants.contact_phone（仅平台可写），不接受任意手机号，避免变成后门。
   */
  const bootstrapFirstAdmin = async (phone, tenantHint) => {
    const where = tenantHint ? 'AND (t.code = ? OR t.name = ?)' : '';
    const args = tenantHint ? [phone, tenantHint, tenantHint] : [phone];
    const t = await db.get(
      `SELECT t.id, t.code, t.name FROM tenants t
       WHERE t.contact_phone = ? ${where} ORDER BY t.id LIMIT 1`,
      args,
    );
    if (!t) return null;
    const admins = await db.get(
      "SELECT COUNT(*) AS c FROM users WHERE tenant_id = ? AND role = 'ADMIN'", [t.id],
    );
    if (Number(admins?.c || 0) > 0) return null; // 已经有管理员，不自动建号

    const now = nowStr();
    const init = randomPassword();
    const r = await db.run(
      `INSERT INTO users (tenant_id, phone, name, password_hash, must_change_password,
                          initial_password, role, status, machine_code, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [t.id, phone, '管理员', hashPassword(init), 1, init, 'ADMIN', 'ACTIVE', null, now, now],
    );
    await audit(db, {
      tenantId: t.id, action: 'auth.bootstrap_first_admin',
      detail: { phone, user_id: Number(r.insertId), note: '公司无管理员，按平台登记的联系人手机号补建' },
    });
    return { tenantId: t.id, code: t.code, name: t.name, userId: Number(r.insertId), initialPassword: init };
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
    const cleanPhone = String(phone).trim();
    const hint = tenantCode ? String(tenantCode).trim() : '';

    let rows = await locate(cleanPhone, hint);
    if (!rows.length) {
      /** 注册者开箱：公司还没有任何管理员时，平台登记的联系人手机号直接建号，无需先被授权 */
      const boot = await bootstrapFirstAdmin(cleanPhone, hint);
      if (boot) {
        return fail(
          `已为「${boot.name}（${boot.code}）」创建管理员账号，初始密码请向系统管理员索取（平台后台 · 公司列表可查看或重置）`,
          'BOOTSTRAP_CREATED', 403,
        );
      }
    }
    const row = await pickTenant(rows, cleanPhone, hint);
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
    // 员工自行改密后即清除明文初始密码：列表里不再展示，避免明文口令长期留存
    await db.run(
      `UPDATE users SET password_hash = ?, must_change_password = 0, password_updated_at = ?,
                        initial_password = NULL, updated_at = ?
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
