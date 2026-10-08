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
import crypto from 'node:crypto';
import { wrap, ok, fail, AppError } from '../lib/http.js';
import { signJwt } from '../lib/auth.js';
import { nowStr, j, arr, num, addMinutes } from '../lib/util.js';
import { audit } from '../lib/repo.js';
import { requireUser, requirePerm } from '../middleware.js';
import {
  MP_VIEWS, ALL_MP_VIEWS, ROLE_VIEWS, resolveViews, roleZh, ROLES,
} from '../lib/rbac.js';
import {
  jscode2session, getPhoneNumber, modeInfo, isConfigured, devModeAvailable,
  bindMode, phoneComponentProbe,
} from '../lib/wechat.js';
import { buildMpView } from '../domain/mpview.js';

const PHONE_RE = /^1[3-9]\d{9}$/;
/** 绑定码默认有效期（分钟） */
const BIND_CODE_TTL = 30;
/** 去掉易混淆字符，方便人工抄录 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const randomCode = (len = 6) => Array.from(
  { length: len },
  () => CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)],
).join('');

/** 数据库时间字符串 → Date（兼容 SQLite 的 "YYYY-MM-DD HH:mm:ss"） */
const toDt = (s) => new Date(String(s || '').replace(' ', 'T'));

/** 当前支持的绑定方式；auto 模式下始终提供绑定码 */
function bindMethods() {
  const m = ['bind_code'];
  if (isConfigured() && bindMode() === 'phone') m.unshift('phone_component');
  return m;
}

export default function registerMpRoutes(app, db, ctx) {
  /* ------------------------- 启动配置（免鉴权） ------------------------- */
  app.get('/api/mp/config', wrap(async () => ok({
    ...modeInfo(),
    bind_methods: bindMethods(),
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

    // 开发模式一步登录：只有 code 命中 dev- 桩时才允许自报手机号，
    // 防止真实微信 code 的用户绕过校验冒绑他人手机号
    if (devModeAvailable() && b.phone && String(openid).startsWith('dev-')) {
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
      bind_methods: bindMethods(),
      hint: bindMode() === 'phone' && isConfigured()
        ? '请点击「微信手机号授权」完成绑定'
        : '请输入手机号和管理员给你的绑定码完成绑定（可在后台「小程序授权」页生成）',
      dev_mode: devModeAvailable(),
    }, '尚未绑定，请完成手机号绑定');
  }));

  /**
   * 绑定码绑定（默认方式，任何主体的小程序都可用）。
   *
   * 手机号快速验证组件（getPhoneNumber）仅限已微信认证的非个人主体小程序且按次收费，
   * 个人主体调不通。这里用「管理员生成的一次性绑定码」替代：
   * 绑定码由后台按手机号签发，含租户信息，一次性、30 分钟过期。
   */
  app.post('/api/mp/bind-code', wrap(async (req) => {
    const b = req.body || {};
    const { openid, appid, unionid } = await resolveOpenid(b);
    const phone = String(b.phone || '').trim();
    // 注意：b.code 是 wx.login 的登录凭据，绑定码在 b.bindCode，别混用
    const bindCode = String(b.bindCode || b.bind_code || '').trim().toUpperCase();
    if (!PHONE_RE.test(phone)) return fail('手机号格式不正确', 'BAD_PHONE', 400);
    if (!bindCode) return fail('缺少绑定码', 'NO_BIND_CODE', 400);

    const rec = await db.get('SELECT * FROM wx_bind_codes WHERE code = ?', [bindCode]);
    if (!rec) return fail('绑定码不正确，请向管理员确认', 'BIND_CODE_BAD', 400);
    if (rec.used_at) return fail('该绑定码已被使用', 'BIND_CODE_USED', 400);
    if (toDt(rec.expires_at) < new Date()) return fail('绑定码已过期，请让管理员重新生成', 'BIND_CODE_EXPIRED', 400);
    if (String(rec.phone) !== phone) {
      return fail('绑定码与手机号不匹配（该绑定码是为其他手机号生成的）', 'BIND_CODE_MISMATCH', 400);
    }
    const tenant = await db.get('SELECT code FROM tenants WHERE id = ?', [rec.tenant_id]);
    if (!tenant) return fail('绑定码对应的公司不存在', 'BIND_CODE_BAD', 400);

    const result = await bindAndIssue({
      openid, appid, unionid, phone, tenantCode: tenant.code, nickname: b.nickname, avatarUrl: b.avatarUrl,
    });
    await db.run('UPDATE wx_bind_codes SET used_at = ?, used_openid = ? WHERE id = ?',
      [nowStr(), openid, rec.id]);
    await audit(db, { tenantId: rec.tenant_id, userId: null, action: 'wx.bind_code.use', detail: { bindCode, openid } });
    return ok(result, '绑定成功');
  }));

  /** 绑定手机号（微信手机号快速验证组件） */
  app.post('/api/mp/bind', wrap(async (req) => {
    const b = req.body || {};
    const { openid, appid, unionid } = await resolveOpenid(b);

    let phone;
    if (isConfigured() && b.phoneCode) {
      const info = await getPhoneNumber(String(b.phoneCode));
      phone = info.purePhone || info.phone;
    } else if (devModeAvailable() && b.phone && String(openid).startsWith('dev-')) {
      phone = String(b.phone).trim();
    } else {
      return fail('缺少绑定依据：请提供手机号组件的 phoneCode，或管理员签发的绑定码（/api/mp/bind-code）', 'NO_PHONE', 400);
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

  /* --------------------- 管理员：绑定码 + 组件自检 --------------------- */

  app.get('/api/admin/wx-bind-codes', wrap(async (req) => {
    const user = requirePerm(req, 'wx.manage');
    const rows = await db.query(
      `SELECT c.*, u.name AS user_name, u.role
       FROM wx_bind_codes c
       LEFT JOIN users u ON u.tenant_id = c.tenant_id AND u.phone = c.phone
       WHERE c.tenant_id = ? ORDER BY c.created_at DESC LIMIT 50`,
      [user.tenant_id],
    );
    const now = Date.now();
    return ok({
      items: rows.map((r) => ({
        id: r.id, phone: r.phone, name: r.name || r.user_name || null,
        role: r.role || null, role_zh: r.role ? roleZh(r.role) : null,
        code: r.code, expires_at: r.expires_at, created_at: r.created_at,
        used_at: r.used_at, used_openid: r.used_openid,
        /** 已过期 / 已作废的码置灰，避免管理员拿错 */
        usable: !r.used_at && toDt(r.expires_at).getTime() > now,
        expired: !r.used_at && toDt(r.expires_at).getTime() <= now,
      })),
    });
  }));

  /**
   * 生成一次性绑定码。
   * 前置：手机号已在本公司 wx_access 白名单且启用 —— 避免给没开通的人发码。
   */
  app.post('/api/admin/wx-bind-code', wrap(async (req) => {
    const user = requirePerm(req, 'wx.manage');
    const tid = user.tenant_id;
    const b = req.body || {};
    const phone = String(b.phone || '').trim();
    if (!PHONE_RE.test(phone)) return fail('手机号格式不正确（需 11 位中国大陆号码）', 'BAD_PHONE', 400);

    const emp = await db.get('SELECT * FROM users WHERE tenant_id = ? AND phone = ?', [tid, phone]);
    if (!emp) return fail(`手机号 ${phone} 还不是本公司员工，请先到「员工授权」录入`, 'NOT_EMPLOYEE', 400);
    if (emp.status !== 'ACTIVE') return fail(`该员工账号状态为 ${emp.status}`, 'USER_DISABLED', 400);

    const access = await db.get('SELECT * FROM wx_access WHERE tenant_id = ? AND phone = ?', [tid, phone]);
    if (!access) return fail(`${phone}（${roleZh(emp.role)}）还没有开通小程序访问权，请先在上方名单里开通`, 'WX_NOT_ALLOWED', 400);
    if (!access.enabled) return fail('该手机号的小程序访问权处于关闭状态，请先恢复', 'WX_DISABLED', 400);

    const ttl = Math.min(Math.max(num(b.ttlMinutes, BIND_CODE_TTL), 1), 1440);
    // 用本地时间口径，与 nowStr() 保持一致（不能用 toISOString，否则在中国时区会被判成已过期）
    const expiresAt = addMinutes(nowStr(), ttl);
    let code = randomCode(6);
    // 极小概率撞码，重试几次
    for (let i = 0; i < 5; i += 1) {
      const dup = await db.get('SELECT id FROM wx_bind_codes WHERE code = ?', [code]);
      if (!dup) break;
      code = randomCode(6);
    }
    await db.run(
      `INSERT INTO wx_bind_codes (tenant_id, phone, code, expires_at, created_by, created_at)
       VALUES (?,?,?,?,?,?)`,
      [tid, phone, code, expiresAt, user.id, nowStr()],
    );
    await audit(db, { tenantId: tid, userId: user.id, action: 'wx.bind_code.issue', detail: { phone, ttl } });
    return ok({
      phone, name: emp.name, role: emp.role, role_zh: roleZh(emp.role),
      code, expires_at: expiresAt, ttl_minutes: ttl,
      /** 给扫码用：纯文本载荷，任何二维码生成器都能扫 */
      scan_payload: `MPBIND:${code}`,
      hint: `把 ${code} 发给本人，在小程序里输入手机号后填入。${ttl} 分钟内有效，用过作废`,
    }, `已生成 ${phone} 的绑定码`);
  }));

  app.delete('/api/admin/wx-bind-code/:id', wrap(async (req) => {
    const user = requirePerm(req, 'wx.manage');
    const id = Number(req.params.id);
    const row = await db.get('SELECT * FROM wx_bind_codes WHERE id = ? AND tenant_id = ?', [id, user.tenant_id]);
    if (!row) return fail('记录不存在', 'NOT_FOUND', 404);
    if (row.used_at) return fail('该绑定码已使用，无法作废', 'ALREADY_USED', 400);
    await db.run('UPDATE wx_bind_codes SET used_at = ?, used_openid = ? WHERE id = ?', [nowStr(), 'REVOKED', id]);
    await audit(db, { tenantId: user.tenant_id, userId: user.id, action: 'wx.bind_code.revoke', detail: { phone: row.phone, code: row.code } });
    return ok(null, '绑定码已作废');
  }));

  /**
   * 手机号快速验证组件自检。
   * 用一个必然无效的 code 试探，依据微信返回的错误码判断该小程序能否使用该组件。
   */
  app.get('/api/admin/wx-phone-check', wrap(async (req) => {
    requirePerm(req, 'wx.manage');
    const probe = await phoneComponentProbe();
    return ok({
      ...probe,
      recommend: probe.usable === true ? '可启用手机号一键绑定（WX_BIND_MODE=phone）'
        : '建议使用绑定码方式（保持 WX_BIND_MODE=auto）',
    });
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
    // 直接调 bind/bind-code 时可能还没有 wx_users 行（未先调 login），这里做 upsert
    const exist = await db.get('SELECT id FROM wx_users WHERE appid = ? AND openid = ?', [appid, openid]);
    if (exist) {
      await db.run(
        `UPDATE wx_users SET tenant_id = ?, user_id = ?, phone = ?, nickname = ?, avatar_url = ?,
                status = ?, bound_at = ?, last_login_at = ?, updated_at = ?
         WHERE appid = ? AND openid = ?`,
        [tenant.id, user.id, phone, nickname || null, avatarUrl || null, 'ACTIVE', nowStr(), nowStr(), nowStr(), appid, openid],
      );
    } else {
      await db.run(
        `INSERT INTO wx_users (appid, openid, unionid, tenant_id, user_id, phone, nickname, avatar_url,
                               status, bound_at, last_login_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [appid, openid, unionid || null, tenant.id, user.id, phone,
          nickname || null, avatarUrl || null, 'ACTIVE', nowStr(), nowStr(), nowStr(), nowStr()],
      );
    }
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
