/**
 * 微信小程序接入（v3.2）
 *
 * 权限判定链条（缺一不可，任一步不过都拒绝并说明原因）：
 *   1. 微信身份：jscode2session 换 openid（开发模式可用手机号直登）
 *   2. 手机号归属：必须是该公司已录入的员工（users 表存在且 ACTIVE）
 *   3. 小程序白名单：wx_access(tenant_id, phone) 存在且 enabled=1 —— 由公司管理员开通
 *   4. 可见视图：wx_access.views 覆盖优先，否则取角色默认视图（ROLE_VIEWS）
 *
 * 小程序只做只读查询，不做写操作，避免与 APP 的报工/出库产生双写冲突。
 */
import { wrap, ok, fail, AppError } from '../lib/http.js';
import { signJwt } from '../lib/auth.js';
import { nowStr, j, arr, num } from '../lib/util.js';
import { audit } from '../lib/repo.js';
import { requireUser, requirePerm } from '../middleware.js';
import {
  MP_VIEWS, ALL_MP_VIEWS, ROLE_VIEWS, resolveViews, roleZh, ROLES,
} from '../lib/rbac.js';
import { jscode2session, getPhoneNumber, modeInfo, isConfigured, devModeAvailable } from '../lib/wechat.js';
import { buildMpView } from '../domain/mpview.js';

const PHONE_RE = /^1[3-9]\d{9}$/;

export default function registerMpRoutes(app, db, ctx) {
  /* ------------------------- 启动配置（免鉴权） ------------------------- */
  app.get('/api/mp/config', wrap(async () => ok({
    ...modeInfo(),
    views: Object.entries(MP_VIEWS).map(([k, v]) => ({ view: k, ...v })),
  })));

  /* --------------------------- 登录 / 绑定 --------------------------- */

  /**
   * 微信登录。
   * 已绑定 → 直接签发令牌；未绑定 → 返回 need_bind，小程序弹出手机号授权。
   */
  app.post('/api/mp/login', wrap(async (req) => {
    const b = req.body || {};
    const { openid, appid, unionid } = await resolveOpenid(b);

    const bind = await db.get(
      'SELECT * FROM wx_users WHERE appid = ? AND openid = ?', [appid, openid],
    );

    // 开发模式直接带手机号：一步完成绑定并登录
    if (devModeAvailable() && b.phone) {
      const phone = String(b.phone).trim();
      if (!PHONE_RE.test(phone)) return fail('手机号格式不正确', 'BAD_PHONE', 400);
      return ok(await bindAndIssue({ openid, appid, unionid, phone, tenantCode: b.tenantCode, nickname: b.nickname }), '登录成功');
    }

    if (bind && bind.status === 'ACTIVE' && bind.user_id) {
      return ok(await issueByBinding(bind), '登录成功');
    }
    // 未绑定：写入/更新一条 PENDING 记录，方便下次直接命中
    if (!bind) {
      await db.run(
        `INSERT INTO wx_users (appid, openid, unionid, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
        [appid, openid, unionid || null, 'PENDING', nowStr(), nowStr()],
      );
    }
    return ok({
      bound: false,
      need_bind: true,
      openid,
      hint: isConfigured()
        ? '请点击「微信手机号授权」完成绑定'
        : '开发模式：请提交手机号完成绑定',
      dev_mode: devModeAvailable(),
    }, '尚未绑定，请授权手机号');
  }));

  /** 绑定手机号（微信手机号快速验证组件） */
  app.post('/api/mp/bind', wrap(async (req) => {
    const b = req.body || {};
    const { openid, appid, unionid } = await resolveOpenid(b);

    let phone;
    if (isConfigured() && b.phoneCode) {
      const info = await getPhoneNumber(String(b.phoneCode));
      phone = info.purePhone || info.phone;
    } else if (devModeAvailable() && b.phone) {
      phone = String(b.phone).trim();
    } else {
      return fail('缺少手机号授权信息（phoneCode 或开发模式下的 phone）', 'NO_PHONE', 400);
    }
    if (!PHONE_RE.test(phone)) return fail('手机号格式不正确', 'BAD_PHONE', 400);

    return ok(await bindAndIssue({
      openid, appid, unionid, phone, tenantCode: b.tenantCode, nickname: b.nickname, avatarUrl: b.avatarUrl,
    }), '绑定成功');
  }));

  /** 解绑（换号 / 退出） */
  app.post('/api/mp/unbind', wrap(async (req) => {
    const user = requireUser(req);
    const b = req.body || {};
    const { openid, appid } = await resolveOpenid(b);
    await db.run(
      'UPDATE wx_users SET status = ?, user_id = NULL, tenant_id = NULL, updated_at = ? WHERE appid = ? AND openid = ?',
      ['DISABLED', nowStr(), appid, openid],
    );
    await audit(db, { tenantId: user.tenant_id, userId: user.id, action: 'wx.unbind', detail: { openid } });
    return ok(null, '已解绑');
  }));

  /* ------------------------------ 我的 ------------------------------ */
  app.get('/api/mp/me', wrap(async (req) => {
    const user = requireUser(req);
    const access = await requireMpAccess(db, user.tenant_id, user.phone, true);
    const views = resolveViews(user.role, j(access?.views, null));
    return ok({
      user: {
        id: user.id, name: user.name, phone: user.phone,
        role: user.role, role_zh: roleZh(user.role),
        machine_code: user.machine_code,
      },
      tenant: { id: req.tenant.id, name: req.tenant.name, code: req.tenant.code },
      views: views.map((v) => ({ view: v, ...MP_VIEWS[v] })),
      view_keys: views,
      /** 管理员勾选了视图时提示，避免用户疑惑"为什么和同岗位同事看到的不一样" */
      view_overridden: Array.isArray(j(access?.views, null)) && arr(j(access?.views, null)).length > 0,
      role_default_views: ROLE_VIEWS[user.role] || [],
    });
  }));

  /* ------------------------------ 视图数据 ------------------------------ */
  app.get('/api/mp/view/:view', wrap(async (req) => {
    const user = requireUser(req);
    const view = String(req.params.view || '');
    if (!ALL_MP_VIEWS.includes(view)) return fail(`视图不存在：${view}`, 'BAD_VIEW', 400);
    const access = await requireMpAccess(db, user.tenant_id, user.phone, true);
    const views = resolveViews(user.role, j(access?.views, null));
    if (!views.includes(view)) {
      throw new AppError(`你没有「${MP_VIEWS[view].zh}」的查看权限，请联系公司管理员开通`, 403, 'VIEW_FORBIDDEN');
    }
    const data = await buildMpView(db, ctx, { tenantId: user.tenant_id, view, user });
    return ok({ view, view_meta: MP_VIEWS[view], generated_at: nowStr(), data });
  }));

  /* --------------------- 管理员：小程序访问白名单 --------------------- */

  app.get('/api/admin/wx-access', wrap(async (req) => {
    const user = requirePerm(req, 'wx.manage');
    const tid = user.tenant_id;
    const rows = await db.query(
      `SELECT a.*, u.name AS user_name, u.role, u.status AS user_status
       FROM wx_access a
       LEFT JOIN users u ON u.tenant_id = a.tenant_id AND u.phone = a.phone
       WHERE a.tenant_id = ? ORDER BY a.enabled DESC, a.id`,
      [tid],
    );
    return ok({
      mode: modeInfo(),
      views: Object.entries(MP_VIEWS).map(([k, v]) => ({ view: k, ...v })),
      items: rows.map((r) => ({
        id: r.id,
        phone: r.phone,
        name: r.name || r.user_name || null,
        enabled: !!r.enabled,
        role: r.role || null,
        role_zh: r.role ? roleZh(r.role) : null,
        /** 该手机号尚未录入员工表时提示：需先到「员工授权」录入 */
        not_employee: !r.role,
        user_status: r.user_status || null,
        views: arr(j(r.views, null)),
        effective_views: r.role ? resolveViews(r.role, j(r.views, null)) : arr(j(r.views, null)),
        remark: r.remark,
        updated_at: r.updated_at,
      })),
    });
  }));

  /** 开通 / 更新：按手机号 */
  app.post('/api/admin/wx-access', wrap(async (req) => {
    const user = requirePerm(req, 'wx.manage');
    const tid = user.tenant_id;
    const b = req.body || {};
    const phone = String(b.phone || '').trim();
    if (!PHONE_RE.test(phone)) return fail('手机号格式不正确（需 11 位中国大陆号码）', 'BAD_PHONE', 400);

    const emp = await db.get('SELECT * FROM users WHERE tenant_id = ? AND phone = ?', [tid, phone]);
    if (!emp) {
      return fail(`手机号 ${phone} 还不是本公司员工，请先到「员工授权」录入该手机号并分配角色`, 'NOT_EMPLOYEE', 400);
    }
    if (emp.status !== 'ACTIVE') return fail(`该员工账号状态为 ${emp.status}，无法开通`, 'USER_DISABLED', 400);

    let views = null;
    if (b.views !== undefined && b.views !== null) {
      const list = arr(b.views).filter((v) => ALL_MP_VIEWS.includes(v));
      views = list.length ? JSON.stringify([...new Set(list)]) : null;
    }

    const exist = await db.get('SELECT * FROM wx_access WHERE tenant_id = ? AND phone = ?', [tid, phone]);
    if (exist) {
      await db.run(
        'UPDATE wx_access SET name = ?, enabled = ?, views = ?, remark = ?, updated_at = ? WHERE id = ?',
        [b.name ?? exist.name, b.enabled === false ? 0 : 1, views, b.remark ?? exist.remark, nowStr(), exist.id],
      );
    } else {
      await db.run(
        `INSERT INTO wx_access (tenant_id, phone, name, enabled, views, remark, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [tid, phone, b.name || emp.name || null, b.enabled === false ? 0 : 1, views, b.remark || null, nowStr(), nowStr()],
      );
    }
    await audit(db, { tenantId: tid, userId: user.id, action: 'wx.access.grant', detail: { phone, views, enabled: b.enabled !== false } });
    return ok({ phone, effective_views: resolveViews(emp.role, views ? j(views, []) : null) },
      `已为 ${phone}（${roleZh(emp.role)}）开通小程序`);
  }));

  /** 停用 / 恢复 */
  app.put('/api/admin/wx-access/:id', wrap(async (req) => {
    const user = requirePerm(req, 'wx.manage');
    const tid = user.tenant_id;
    const id = Number(req.params.id);
    const row = await db.get('SELECT * FROM wx_access WHERE id = ? AND tenant_id = ?', [id, tid]);
    if (!row) return fail('记录不存在', 'NOT_FOUND', 404);
    const b = req.body || {};
    const patch = { updated_at: nowStr() };
    if (b.enabled !== undefined) patch.enabled = b.enabled ? 1 : 0;
    if (b.views !== undefined) {
      const list = arr(b.views).filter((v) => ALL_MP_VIEWS.includes(v));
      patch.views = list.length ? JSON.stringify([...new Set(list)]) : null;
    }
    if (b.name !== undefined) patch.name = b.name || null;
    if (b.remark !== undefined) patch.remark = b.remark || null;
    const keys = Object.keys(patch);
    await db.run(`UPDATE wx_access SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`,
      [...keys.map((k) => patch[k]), id]);
    await audit(db, { tenantId: tid, userId: user.id, action: 'wx.access.update', detail: { id, phone: row.phone, ...patch } });
    return ok(null, '已更新');
  }));

  app.delete('/api/admin/wx-access/:id', wrap(async (req) => {
    const user = requirePerm(req, 'wx.manage');
    const row = await db.get('SELECT * FROM wx_access WHERE id = ? AND tenant_id = ?',
      [Number(req.params.id), user.tenant_id]);
    if (!row) return fail('记录不存在', 'NOT_FOUND', 404);
    await db.run('DELETE FROM wx_access WHERE id = ?', [row.id]);
    // 同时踢掉已绑定的微信身份，避免"取消授权还能看"
    await db.run('UPDATE wx_users SET status = ?, user_id = NULL, tenant_id = NULL, updated_at = ? WHERE tenant_id = ? AND phone = ?',
      ['DISABLED', nowStr(), user.tenant_id, row.phone]);
    await audit(db, { tenantId: user.tenant_id, userId: user.id, action: 'wx.access.revoke', detail: { phone: row.phone } });
    return ok(null, `已取消 ${row.phone} 的小程序访问权`);
  }));

  /** 角色字典（含默认视图），供后台展示"这个角色默认能看到什么" */
  app.get('/api/admin/wx-roles', wrap(async (req) => {
    requirePerm(req, 'wx.manage');
    return ok(Object.entries(ROLES).map(([k, v]) => ({
      role: k, ...v, default_views: ROLE_VIEWS[k] || [],
      default_view_names: (ROLE_VIEWS[k] || []).map((x) => MP_VIEWS[x]?.zh || x),
    })));
  }));

  /* ============================== 内部方法 ============================== */

  async function resolveOpenid(b) {
    const code = String(b.code || '').trim();
    if (!code) throw new AppError('缺少 wx.login 的 code', 400, 'NO_CODE');
    const s = await jscode2session(code);
    return s;
  }

  /** 校验手机号 → 绑定微信身份 → 签发令牌 */
  async function bindAndIssue({ openid, appid, unionid, phone, tenantCode, nickname, avatarUrl }) {
    const { user, tenant, access } = await locateEmployee(phone, tenantCode);
    await db.run(
      `UPDATE wx_users SET tenant_id = ?, user_id = ?, phone = ?, nickname = ?, avatar_url = ?,
              status = ?, bound_at = ?, last_login_at = ?, updated_at = ?
       WHERE appid = ? AND openid = ?`,
      [tenant.id, user.id, phone, nickname || null, avatarUrl || null, 'ACTIVE', nowStr(), nowStr(), nowStr(), appid, openid],
    );
    await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowStr(), user.id]);
    await audit(db, { tenantId: tenant.id, userId: user.id, action: 'wx.bind', detail: { openid, phone } });
    return await profile(user, tenant, access, { bound: true, openid });
  }

  /** 已绑定身份直接签发（每次都重新校验白名单，管理员随时可关） */
  async function issueByBinding(bind) {
    const user = await db.get('SELECT * FROM users WHERE id = ? AND tenant_id = ?', [bind.user_id, bind.tenant_id]);
    if (!user) throw new AppError('原绑定的员工账号已不存在，请重新绑定', 403, 'BIND_STALE');
    if (user.status !== 'ACTIVE') throw new AppError('账号已被停用，请联系管理员', 403, 'USER_DISABLED');
    const tenant = await db.get('SELECT * FROM tenants WHERE id = ?', [bind.tenant_id]);
    if (!tenant || tenant.status !== 'ACTIVE') throw new AppError('所属公司已停止服务', 403, 'TENANT_INACTIVE');
    if (tenant.expires_at && new Date(String(tenant.expires_at).replace(' ', 'T')) < new Date()) {
      throw new AppError(`公司授权已于 ${tenant.expires_at} 到期`, 403, 'TENANT_EXPIRED');
    }
    const access = await requireMpAccess(db, tenant.id, user.phone, true);
    await db.run('UPDATE wx_users SET last_login_at = ?, updated_at = ? WHERE id = ?', [nowStr(), nowStr(), bind.id]);
    await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowStr(), user.id]);
    return await profile(user, tenant, access, { bound: true, openid: bind.openid });
  }

  async function profile(user, tenant, access, extra = {}) {
    const views = resolveViews(user.role, j(access?.views, null));
    const token = signJwt({ uid: user.id, tid: tenant.id, role: user.role, mp: 1 });
    return {
      token,
      token_type: 'Bearer',
      expires_in_hours: ctx.config.tokenTtlHours,
      user: {
        id: user.id, name: user.name, phone: user.phone,
        role: user.role, role_zh: roleZh(user.role), machine_code: user.machine_code,
      },
      tenant: { id: tenant.id, code: tenant.code, name: tenant.name, expires_at: tenant.expires_at },
      views: views.map((v) => ({ view: v, ...MP_VIEWS[v] })),
      view_keys: views,
      ...extra,
    };
  }

  /** 手机号 → 员工 + 公司（支持一人多家公司时用 tenantCode 指定） */
  async function locateEmployee(phone, tenantCode) {
    let rows;
    if (tenantCode) {
      rows = await db.query(
        `SELECT u.*, t.code AS tenant_code, t.name AS tenant_name, t.status AS tenant_status, t.expires_at, t.max_users
         FROM users u JOIN tenants t ON t.id = u.tenant_id
         WHERE u.phone = ? AND t.code = ?`, [phone, tenantCode],
      );
    } else {
      rows = await db.query(
        `SELECT u.*, t.code AS tenant_code, t.name AS tenant_name, t.status AS tenant_status, t.expires_at, t.max_users
         FROM users u JOIN tenants t ON t.id = u.tenant_id
         WHERE u.phone = ?`, [phone],
      );
    }
    if (!rows.length) {
      throw new AppError('该手机号尚未获得授权，请联系贵公司管理员先在后台录入手机号', 403, 'NOT_AUTHORIZED');
    }
    if (rows.length > 1 && !tenantCode) {
      // 用 HTTP 200 + 业务码返回：微信小程序对 3xx 响应处理不稳定
      const err = new AppError('该手机号属于多家公司，请选择要进入的公司', 200, 'MULTI_TENANT');
      err.extra = { tenants: rows.map((r) => ({ id: r.tenant_id, code: r.tenant_code, name: r.tenant_name })) };
      throw err;
    }
    const row = rows[0];
    if (row.tenant_status !== 'ACTIVE') throw new AppError('所属公司已停止服务', 403, 'TENANT_INACTIVE');
    if (row.expires_at && new Date(String(row.expires_at).replace(' ', 'T')) < new Date()) {
      throw new AppError(`公司授权已于 ${row.expires_at} 到期，请联系管理员续期`, 403, 'TENANT_EXPIRED');
    }
    if (row.status !== 'ACTIVE') throw new AppError('账号已被停用，请联系管理员', 403, 'USER_DISABLED');
    const tenant = {
      id: row.tenant_id, code: row.tenant_code, name: row.tenant_name,
      expires_at: row.expires_at, max_users: row.max_users, status: row.tenant_status,
    };
    const access = await requireMpAccess(db, tenant.id, phone, true);
    return { user: row, tenant, access };
  }
}

/** 小程序白名单校验：不在名单里一律拒绝 */
export async function requireMpAccess(db, tenantId, phone, throwIfMissing = true) {
  const row = await db.get('SELECT * FROM wx_access WHERE tenant_id = ? AND phone = ?', [tenantId, phone]);
  if (!row) {
    if (!throwIfMissing) return null;
    throw new AppError('该手机号尚未开通小程序访问权，请联系贵公司管理员在后台「小程序授权」中添加', 403, 'WX_NOT_ALLOWED');
  }
  if (!row.enabled) {
    if (!throwIfMissing) return null;
    throw new AppError('你的小程序访问权已被管理员关闭', 403, 'WX_DISABLED');
  }
  return row;
}
