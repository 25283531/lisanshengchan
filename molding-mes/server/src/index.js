/**
 * 注塑生产协同 MES · 服务端入口
 * 分层：路由模块 → 领域服务（排产/AI/消息）→ 仓储（双方言）
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';

import config from './config.js';
import { createDb, migrate } from './db/index.js';
import { registerAuth, requireUser, requirePerm, tenantIdOf } from './middleware.js';
import { ok, fail } from './lib/http.js';

import registerAuthRoutes from './modules/auth.js';
import registerPlatformRoutes from './modules/platform.js';
import registerAdminRoutes from './modules/admin.js';
import registerMasterRoutes from './modules/master.js';
import registerOrderRoutes from './modules/orders.js';
import registerScheduleRoutes from './modules/schedule.js';
import registerNotifyRoutes from './modules/notify.js';
import registerChatRoutes from './modules/chat.js';
import registerMpRoutes from './modules/mp.js';

export async function buildServer(opts = {}) {
  const db = opts.db || (await createDb(opts.dbConfig ? { db: opts.dbConfig } : undefined));
  if (opts.migrate !== false) await migrate(db);

  const app = Fastify({
    logger: {
      level: config.env === 'production' ? 'warn' : 'info',
      transport: undefined,
    },
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cors, { origin: true, credentials: true });

  const ctx = { config, db, requireUser, requirePerm, tenantIdOf };

  registerAuth(app, db);

  if (config.serveAdminWeb && existsSync(config.adminWebDir)) {
    await app.register(fastifyStatic, { root: config.adminWebDir, prefix: '/admin/', decorateReply: false });
    app.get('/admin', async (req, reply) => reply.redirect('/admin/'));
  }

  app.get('/api/health', async () => ok({
    status: 'ok', dialect: db.dialect, env: config.env,
    time: new Date().toISOString(),
  }, '服务正常'));

  registerAuthRoutes(app, db, ctx);
  registerPlatformRoutes(app, db, ctx);
  registerAdminRoutes(app, db, ctx);
  registerMasterRoutes(app, db, ctx);
  registerOrderRoutes(app, db, ctx);
  registerScheduleRoutes(app, db, ctx);
  registerNotifyRoutes(app, db, ctx);
  registerChatRoutes(app, db, ctx);
  registerMpRoutes(app, db, ctx);

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api')) return reply.code(404).send(fail('接口不存在', 'NOT_FOUND', 404));
    return reply.code(404).send({ code: 'NOT_FOUND', message: '页面不存在' });
  });

  app.decorate('db', db);
  return { app, db, ctx };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const { app, db } = await buildServer();
  try {
    await app.listen({ port: config.port, host: config.host });
    console.log('\n───────────────────────────────────────────────');
    console.log('  注塑生产协同 MES 服务端已启动');
    console.log(`  地址      http://127.0.0.1:${config.port}`);
    console.log(`  管理后台  http://127.0.0.1:${config.port}/admin/`);
    console.log(`  数据库    ${config.db.dialect}${config.db.dialect === 'sqlite' ? ` (${config.db.file})` : ` ${config.db.host}/${config.db.database}`}`);
    console.log(`  平台口令  ${config.platformToken}`);
    console.log('───────────────────────────────────────────────\n');
  } catch (e) {
    console.error('启动失败：', e);
    process.exit(1);
  }

  const shutdown = async () => {
    try { await app.close(); } catch { /* noop */ }
    try { db.close(); } catch { /* noop */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
