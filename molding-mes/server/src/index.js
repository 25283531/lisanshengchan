/**
 * 注塑生产协同 MES · 服务端入口
 * 分层：路由模块 → 领域服务（排产/AI/消息）→ 仓储（双方言）
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { Writable } from 'node:stream';

import config from './config.js';
import { pushLog } from './lib/logbuf.js';
import { createDb, migrate } from './db/index.js';
import { ensureGlobalAi } from './domain/ai-config.js';
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
import registerIntakeRoutes from './modules/intake.js';
import registerMaintenanceRoutes from './modules/maintenance.js';

export async function buildServer(opts = {}) {
  const db = opts.db || (await createDb(opts.dbConfig ? { db: opts.dbConfig } : undefined));
  if (opts.migrate !== false) {
    await migrate(db);
    // 平台 AI 配置始终保证有一行，后台才有的看、有的改
    await ensureGlobalAi(db);
  }

  /**
   * 日志：一份写 stdout（交给 docker 的 json-file 落盘），一份进内存环形缓冲，
   * 平台后台「运行日志」页直接读缓冲，运维不用 SSH 敲 docker logs。
   */
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      const s = chunk.toString();
      try { process.stdout.write(s); } catch { /* stdout 不可写时别把进程拖死 */ }
      pushLog(s);
      cb();
    },
  });

  const app = Fastify({
    logger: { level: config.logLevel, stream: logStream },
    // 基础数据支持上传 Excel 附件，放开到 10MB
    bodyLimit: 10 * 1024 * 1024,
  });

  await app.register(cors, { origin: true, credentials: true });

  // 容错：许多客户端（curl、脚本、第三方集成）发 POST 时会固定带 Content-Type: application/json
  // 却没有请求体，Fastify 默认直接拒绝（FST_ERR_CTP_EMPTY_JSON_BODY）。这里把空体当作 {} 放行。
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (body === undefined || body === null || String(body).trim() === '') return done(null, {});
    try {
      done(null, JSON.parse(body));
    } catch (e) {
      e.statusCode = 400;
      e.code = 'FST_ERR_CTP_INVALID_MEDIA_TYPE';
      done(e, undefined);
    }
  });

  const ctx = { config, db, requireUser, requirePerm, tenantIdOf };

  registerAuth(app, db);

  const adminWebOn = config.serveAdminWeb && existsSync(config.adminWebDir);

  if (adminWebOn) {
    await app.register(fastifyStatic, { root: config.adminWebDir, prefix: '/admin/', decorateReply: false });
    app.get('/admin', async (req, reply) => reply.redirect('/admin/'));
  }

  /**
   * 根路径。浏览器直接访问 http://host:8080/ 时跳到管理后台，
   * 否则给一份入口清单——避免用户打开根地址看到 404 以为服务没起来。
   */
  app.get('/', async (req, reply) => {
    if (adminWebOn) return reply.redirect('/admin/', 302);
    return reply.type('application/json').send(ok({
      service: 'molding-mes-server',
      version: config.version,
      endpoints: { health: '/api/health', admin: '/admin/' },
      note: '当前未开启管理后台静态托管（SERVE_ADMIN_WEB=false）',
    }));
  });

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
  // 这两个模块内部会注册插件（multipart 等），需要 await
  await registerIntakeRoutes(app, db, ctx);
  registerMaintenanceRoutes(app, db, ctx);

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
