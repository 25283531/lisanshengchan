/** 鉴权中间件：令牌解析、用户装载、租户授权期限校验、角色权限校验 */
import { verifyJwt } from './lib/auth.js';
import { AppError } from './lib/http.js';
import { assertCan, can, roleZh } from './lib/rbac.js';
import { j } from './lib/util.js';

export function registerAuth(app, db) {
  app.decorateRequest('user', null);
  app.decorateRequest('tenant', null);

  app.addHook('preHandler', async (req) => {
    const raw = req.headers.authorization || '';
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : (req.headers['x-token'] || '');
    if (!token) return;
    const payload = verifyJwt(token);
    if (!payload) return;
    const user = await db.get('SELECT * FROM users WHERE id = ? AND tenant_id = ?', [payload.uid, payload.tid]);
    if (!user) return;
    const tenant = await db.get('SELECT * FROM tenants WHERE id = ?', [payload.tid]);
    req.user = user;
    req.tenant = tenant || null;
  });
}

/** 必须登录。同时校验公司授权状态与账号状态。 */
export function requireUser(req) {
  if (!req.user) throw new AppError('未登录或令牌已失效', 401, 'UNAUTHORIZED');
  const t = req.tenant;
  if (!t) throw new AppError('所属公司不存在', 401, 'TENANT_MISSING');
  if (t.status !== 'ACTIVE') throw new AppError(`公司状态为 ${t.status}，已停止服务`, 403, 'TENANT_INACTIVE');
  if (t.expires_at && new Date(String(t.expires_at).replace(' ', 'T')) < new Date()) {
    throw new AppError(`公司授权已于 ${t.expires_at} 到期，请联系管理员续期`, 403, 'TENANT_EXPIRED');
  }
  if (req.user.status !== 'ACTIVE') throw new AppError('账号已被停用，请联系管理员', 403, 'USER_DISABLED');
  return req.user;
}

/** 角色权限校验 */
export function requirePerm(req, permission) {
  const user = requireUser(req);
  assertCan(user.role, permission);
  return user;
}

export const tenantIdOf = (req) => requireUser(req).tenant_id;

/** 租户是否还能新增用户 */
export async function checkSeat(db, tenant) {
  const row = await db.get('SELECT COUNT(*) AS c FROM users WHERE tenant_id = ? AND status = ?', [tenant.id, 'ACTIVE']);
  const used = Number(row?.c || 0);
  const max = Number(tenant.max_users || 0);
  if (max > 0 && used >= max) {
    throw new AppError(`已达到授权用户数上限 ${max} 人，如需扩容请联系平台管理员`, 403, 'SEAT_LIMIT');
  }
  return { used, max };
}

/** 消息可见性：按角色 + 机台绑定过滤 */
export function visibleTo(user, notification) {
  const roles = j(notification.audience_roles, []) || [];
  if (!roles.length) return true;
  if (!roles.includes(user.role)) return false;
  // 生产人员绑定了机台时，只收该机台定向消息与广播消息
  if (user.role === 'PRODUCTION' && user.machine_code) {
    return !notification.machine_code || notification.machine_code === user.machine_code;
  }
  return true;
}

export { can, roleZh };
