/**
 * 免填公司编码登录 + 运行日志（v3.7.1）
 *
 * 覆盖：
 *   1. 只填手机号 + 密码即可登录（公司编码留空）
 *   2. 一个手机号挂多家公司时自动选一家，其余放进 other_tenants
 *   3. 平台后台可读取运行日志（级别 info、可按 warn/error 过滤）
 *   4. 平台可改公司管理员手机号（换绑）
 * 用法：先 npm start，再 node scripts/login-logs-demo.js
 */
import { createDb } from '../src/db/index.js';
import { hashPassword } from '../src/lib/auth.js';
import config from '../src/config.js';

const BASE = `http://127.0.0.1:${config.port}`;
let pass = 0; let failCount = 0;

function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? `  ${extra}` : ''}`); } else { failCount += 1; console.log(`  ❌ ${name}${extra ? `  ${extra}` : ''}`); }
}

async function call(method, path, { token, body } = {}) {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

const db = await createDb();
const stamp = String(Date.now()).slice(-6);
const CODE = `L${stamp}`;
const PHONE = `138${stamp}22`;

const pf = await call('POST', '/api/platform/login', { body: { token: config.platformToken } });
const PF = pf.data?.token;

async function main() {
  console.log('\n【1】只填手机号 + 密码登录（不填公司编码）');
  const demo = await db.get('SELECT * FROM tenants ORDER BY id LIMIT 1');
  const created = await call('POST', '/api/platform/tenants', {
    token: PF, body: { code: CODE, name: `日志回归${stamp}`, adminPhone: PHONE, maxUsers: 5 },
  });
  const init = created.data?.initial_password;
  const noCode = await call('POST', '/api/auth/login', { body: { phone: PHONE, password: init } });
  check('不填公司编码登录成功', noCode.code === 0, noCode.message);
  check('默认落到唯一所属公司', noCode.data?.tenant?.code === CODE, noCode.data?.tenant?.code);
  check('单公司时 other_tenants 为空', (noCode.data?.other_tenants || []).length === 0);

  console.log('\n【2】手机号挂两家公司：自动选 + 返回 other_tenants');
  // 把同一个手机号也录进第一家演示公司（角色 PRODUCTION，验证"管理员优先"）
  await db.run(
    `INSERT INTO users (tenant_id, phone, name, password_hash, must_change_password,
                        initial_password, role, status, machine_code, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [demo.id, PHONE, '回归临时', hashPassword(init), 0, init, 'PRODUCTION', 'ACTIVE', null,
      new Date().toISOString().slice(0, 19).replace('T', ' '), new Date().toISOString().slice(0, 19).replace('T', ' ')],
  );
  const multi = await call('POST', '/api/auth/login', { body: { phone: PHONE, password: init } });
  check('两家都能登录时不报错', multi.code === 0, multi.message);
  check('自动选管理员那家', multi.data?.tenant?.code === CODE, multi.data?.tenant?.code);
  check('返回其他公司供切换', (multi.data?.other_tenants || []).length === 1,
    JSON.stringify((multi.data?.other_tenants || []).map((t) => t.code)));
  const withCode = await call('POST', '/api/auth/login', { body: { phone: PHONE, password: init, tenantCode: demo.code } });
  check('填编码仍能切到指定公司', withCode.code === 0 && withCode.data?.tenant?.code === demo.code,
    withCode.data?.tenant?.code);

  console.log('\n【3】平台改公司管理员手机号（换绑）');
  const newPhone = `139${stamp}33`;
  const tid = (await call('GET', '/api/platform/tenants', { token: PF })).data.find((t) => t.code === CODE).id;
  const upd = await call('PUT', `/api/platform/tenants/${tid}/admin`, { token: PF, body: { adminPhone: newPhone } });
  check('换绑成功', upd.code === 0, upd.message);
  const after = (await call('GET', '/api/platform/tenants', { token: PF })).data.find((t) => t.code === CODE);
  check('列表显示新管理员账号', after.admin_phone === newPhone, String(after.admin_phone));
  const old = await call('POST', '/api/auth/login', { body: { phone: PHONE, password: init, tenantCode: CODE } });
  check('旧号码已不能登录该公司', old.code === 'NOT_AUTHORIZED' || old.code === 'TENANT_MISMATCH', String(old.code));
  const nu = await call('POST', '/api/auth/login', { body: { phone: newPhone, password: init, tenantCode: CODE } });
  check('新号码可登录', nu.code === 0, nu.message);

  console.log('\n【4】运行日志：级别 info 且后台可读');
  const logs = await call('GET', '/api/platform/logs?limit=50', { token: PF });
  check('日志接口可用', logs.code === 0, logs.message);
  check('日志级别为 info', logs.data?.log_level === 'info', String(logs.data?.log_level));
  check('缓冲里有日志', (logs.data?.items || []).length > 0, `${(logs.data?.items || []).length} 条`);
  const hasInfo = (logs.data?.items || []).some((r) => r.level === 'info');
  check('能看到 info 级记录（请求日志）', hasInfo);
  const warnOnly = await call('GET', '/api/platform/logs?limit=50&level=error', { token: PF });
  const onlyErr = (warnOnly.data?.items || []).every((r) => ['error', 'fatal'].includes(r.level));
  check('按 error 过滤后只剩 error/fatal', onlyErr, `${(warnOnly.data?.items || []).length} 条`);
  const noReq = await call('GET', '/api/platform/logs?limit=50&requests=0', { token: PF });
  const noReqMsgs = (noReq.data?.items || []).filter((r) => ['incoming request', 'request completed'].includes(r.msg));
  check('requests=0 时滤掉请求日志', noReqMsgs.length === 0, `剩 ${(noReq.data?.items || []).length} 条`);
  const noToken = await call('GET', '/api/platform/logs');
  check('未带平台令牌取不到日志', noToken.code === 'PLATFORM_REQUIRED' || noToken.status === 401, String(noToken.code));

  // 清理
  await db.run('DELETE FROM users WHERE tenant_id = ? OR phone IN (?, ?)', [tid, PHONE, newPhone]);
  await db.run('DELETE FROM ai_configs WHERE tenant_id = ?', [tid]);
  await db.run('DELETE FROM tenants WHERE id = ?', [tid]);

  console.log(`\n结果：通过 ${pass} 项，失败 ${failCount} 项`);
  process.exit(failCount ? 1 : 0);
}

await main();
