/**
 * 消息中心：移动端轮询入口。
 * 可见性 = 角色匹配 + 机台绑定（未绑机台的生产人员收全部生产类消息）。
 */
import { wrap, ok, fail } from '../lib/http.js';
import { nowStr, num, j } from '../lib/util.js';
import { requireUser, visibleTo } from '../middleware.js';

export default function registerNotifyRoutes(app, db, ctx) {
  app.get('/api/notifications', wrap(async (req) => {
    const user = requireUser(req);
    const limit = Math.min(num(req.query.limit, 50), 200);
    const unreadOnly = String(req.query.unread || '') === '1';
    const type = req.query.type ? String(req.query.type) : null;
    const since = req.query.since ? String(req.query.since) : null;

    const where = ['n.tenant_id = ?'];
    const params = [user.tenant_id];
    if (since) { where.push('n.created_at > ?'); params.push(since); }
    if (type) { where.push('n.type = ?'); params.push(type); }
    if (unreadOnly) where.push('NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = ?)');
    if (unreadOnly) params.push(user.id);

    const rows = await db.query(
      `SELECT n.*, (SELECT COUNT(*) FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = ?) AS read_flag
       FROM notifications n WHERE ${where.join(' AND ')}
       ORDER BY n.id DESC LIMIT ?`,
      [user.id, ...params, limit],
    );

    const visible = rows.filter((r) => visibleTo(user, r));
    return ok(visible.map((r) => ({
      id: r.id, type: r.type, title: r.title, body: r.body,
      payload: j(r.payload, null), level: r.level,
      machine_code: r.machine_code, ref_type: r.ref_type, ref_id: r.ref_id,
      created_at: r.created_at, is_read: Number(r.read_flag) > 0,
    })));
  }));

  app.get('/api/notifications/unread-count', wrap(async (req) => {
    const user = requireUser(req);
    const rows = await db.query(
      `SELECT n.*, (SELECT COUNT(*) FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = ?) AS read_flag
       FROM notifications n WHERE n.tenant_id = ? ORDER BY n.id DESC LIMIT 300`,
      [user.id, user.tenant_id],
    );
    const c = rows.filter((r) => visibleTo(user, r) && !Number(r.read_flag)).length;
    return ok({ unread: c });
  }));

  app.post('/api/notifications/:id/read', wrap(async (req) => {
    const user = requireUser(req);
    const id = Number(req.params.id);
    const exists = await db.get('SELECT id FROM notification_reads WHERE notification_id = ? AND user_id = ?', [id, user.id]);
    if (!exists) {
      await db.run('INSERT INTO notification_reads (notification_id, user_id, read_at) VALUES (?,?,?)', [id, user.id, nowStr()]);
    }
    return ok(null, '已标记已读');
  }));

  app.post('/api/notifications/read-all', wrap(async (req) => {
    const user = requireUser(req);
    const rows = await db.query(
      'SELECT id, audience_roles, machine_code FROM notifications WHERE tenant_id = ? ORDER BY id DESC LIMIT 300',
      [user.tenant_id],
    );
    let n = 0;
    for (const r of rows) {
      if (!visibleTo(user, r)) continue;
      const exists = await db.get('SELECT id FROM notification_reads WHERE notification_id = ? AND user_id = ?', [r.id, user.id]);
      if (exists) continue;
      await db.run('INSERT INTO notification_reads (notification_id, user_id, read_at) VALUES (?,?,?)', [r.id, user.id, nowStr()]);
      n += 1;
    }
    return ok({ marked: n }, `已全部标记已读（${n} 条）`);
  }));
}
