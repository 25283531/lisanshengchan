/**
 * 手机号 + 密码登录验证（v3.4）
 *
 * 覆盖：短信验证码已下线、管理员下发初始密码、批量初始化、初始密码登录提示、
 *       员工自选「立即修改 / 以后再说」、未设置密码拦截、越权与错误密码。
 * 用法：先 npm start，再 node scripts/password-demo.js
 */
import { createDb } from '../src/db/index.js';
import config from '../src/config.js';

const BASE = `http://127.0.0.1:${config.port}`;
let pass = 0; let failCount = 0;

function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? `  ${extra}` : ''}`); } else { failCount += 1; console.log(`  ❌ ${name}${extra ? `  ${extra}` : ''}`); }
}

async function call(method, path, { token, body } = {}) {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  // 无 body 时不声明 Content-Type，避免 Fastify 报 "Body cannot be empty"
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

const login = (phone, password, tenantCode) => call('POST', '/api/auth/login', { body: { phone, password, tenantCode } });

const db = await createDb();

async function main() {
  const tenant = await db.get('SELECT * FROM tenants ORDER BY id LIMIT 1');
  const adminRow = await db.get("SELECT * FROM users WHERE tenant_id = ? AND role = 'ADMIN'", [tenant.id]);
  console.log(`租户：${tenant.name}（${tenant.code}）\n`);

  // 清理上一轮遗留
  const TMP = ['13800000111', '13800000112'];
  for (const p of TMP) await db.run('DELETE FROM users WHERE tenant_id = ? AND phone = ?', [tenant.id, p]);

  console.log('=== 1. 短信验证码登录已下线 ===');
  const smsSend = await call('POST', '/api/auth/sms/send', { body: { phone: adminRow.phone } });
  check('/api/auth/sms/send 已移除', smsSend.status === 404, `HTTP ${smsSend.status}`);
  const smsLogin = await call('POST', '/api/auth/sms/login', { body: { phone: adminRow.phone, code: '123456' } });
  check('/api/auth/sms/login 已移除', smsLogin.status === 404, `HTTP ${smsLogin.status}`);

  console.log('\n=== 2. 登录前置校验 ===');
  const admin = await login(adminRow.phone, '123456', tenant.code);
  check('管理员可用密码登录', admin.code === 0, admin.message);
  const ADMIN = admin.data.token;
  const noAuth = await login('13900000000', '123456', tenant.code);
  check('未授权手机号被拒', noAuth.code === 'NOT_AUTHORIZED', noAuth.message);
  const badPwd = await login(adminRow.phone, '000000', tenant.code);
  check('错误密码被拒', badPwd.code === 'BAD_CREDENTIALS', badPwd.message);
  const noPwd = await login(adminRow.phone, '', tenant.code);
  check('空密码被拒', noPwd.code === 'PARAM_MISSING', noPwd.message);

  console.log('\n=== 3. 管理员下发初始密码（留空随机生成）===');
  const created = await call('POST', '/api/admin/employees', {
    token: ADMIN,
    body: { phone: '13800000111', name: '测试员工甲', role: 'PRODUCTION' },
  });
  check('录入成功并返回初始密码', created.code === 0 && /^\d{6}$/.test(String(created.data?.initial_password)),
    `初始密码 ${created.data?.initial_password}`);
  const PWD1 = String(created.data.initial_password);
  check('标记为待修改初始密码', created.data.must_change_password === true);

  console.log('\n=== 4. 初始密码登录与提示 ===');
  const l1 = await login('13800000111', PWD1, tenant.code);
  check('初始密码可登录', l1.code === 0, l1.message);
  check('登录后返回 must_change_password', l1.data?.must_change_password === true);
  check('给出提示文案', !!l1.data?.password_hint, l1.data?.password_hint);
  const T1 = l1.data.token;
  const me1 = await call('GET', '/api/auth/me', { token: T1 });
  check('/me 暴露密码状态', me1.data?.must_change_password === true);

  console.log('\n=== 5. 员工甲：选择立即修改 ===');
  const wrongOld = await call('POST', '/api/auth/password', { token: T1, body: { oldPassword: 'xxxxxx', newPassword: 'abc123456' } });
  check('原密码不正确被拒', wrongOld.code === 'BAD_CREDENTIALS', wrongOld.message);
  const samePwd = await call('POST', '/api/auth/password', { token: T1, body: { oldPassword: PWD1, newPassword: PWD1 } });
  check('新密码不能与旧密码相同', samePwd.code === 'SAME_PASSWORD', samePwd.message);
  const weak = await call('POST', '/api/auth/password', { token: T1, body: { oldPassword: PWD1, newPassword: '123' } });
  check('少于 6 位被拒', weak.code === 'WEAK_PASSWORD', weak.message);
  const changed = await call('POST', '/api/auth/password', { token: T1, body: { oldPassword: PWD1, newPassword: 'abc123456' } });
  check('修改成功', changed.code === 0, changed.message);
  const me2 = await call('GET', '/api/auth/me', { token: T1 });
  check('改完不再提示修改', me2.data?.must_change_password === false);
  const newLogin = await login('13800000111', 'abc123456', tenant.code);
  check('新密码可登录', newLogin.code === 0);
  check('新密码登录不再提示修改', newLogin.data?.must_change_password === false);
  const oldLogin = await login('13800000111', PWD1, tenant.code);
  check('旧密码已失效', oldLogin.code === 'BAD_CREDENTIALS');

  console.log('\n=== 6. 员工乙：选择「以后再说」 ===');
  const created2 = await call('POST', '/api/admin/employees', {
    token: ADMIN,
    body: { phone: '13800000112', name: '测试员工乙', role: 'WAREHOUSE', password: '888888' },
  });
  check('管理员可指定初始密码', created2.code === 0 && created2.data?.initial_password === '888888', created2.message);
  const l2 = await login('13800000112', '888888', tenant.code);
  check('指定初始密码可登录', l2.code === 0);
  const T2 = l2.data.token;
  const later = await call('POST', '/api/auth/password/later', { token: T2, body: {} });
  check('暂不修改接口可用', later.code === 0, later.message);
  const me3 = await call('GET', '/api/auth/me', { token: T2 });
  check('提醒已关闭', me3.data?.must_change_password === false);
  const stillOld = await login('13800000112', '888888', tenant.code);
  check('初始密码仍然可用（未被改动）', stillOld.code === 0 && stillOld.data?.must_change_password === false);
  const weakAdmin = await call('POST', '/api/admin/employees', {
    token: ADMIN, body: { phone: '13800000113', name: '弱密码', role: 'SALES', password: '123' },
  });
  check('管理员设弱密码被拒', weakAdmin.code === 'WEAK_PASSWORD', weakAdmin.message);

  console.log('\n=== 7. 批量初始化密码 ===');
  const batch = await call('POST', '/api/admin/employees/init-passwords', {
    token: ADMIN, body: { password: '666666', ids: [created.data.id, created2.data.id] },
  });
  check('批量下发成功', batch.code === 0 && batch.data?.count === 2, batch.message);
  const afterBatch = await login('13800000111', '666666', tenant.code);
  check('统一初始密码生效', afterBatch.code === 0 && afterBatch.data?.must_change_password === true);
  const randBatch = await call('POST', '/api/admin/employees/init-passwords', {
    token: ADMIN, body: { ids: [created.data.id] },
  });
  const RAND = String(randBatch.data?.items?.[0]?.initial_password);
  check('未指定时随机生成 6 位', /^\d{6}$/.test(RAND), `随机密码 ${RAND}`);
  const randLogin = await login('13800000111', RAND, tenant.code);
  check('随机初始密码可登录', randLogin.code === 0);

  console.log('\n=== 8. 单人重置与未设置密码拦截 ===');
  const reset = await call('POST', `/api/admin/employees/${created2.data.id}/password`, { token: ADMIN, body: {} });
  check('单人重置返回明文', reset.code === 0 && /^\d{6}$/.test(String(reset.data?.initial_password)), `新初始密码 ${reset.data?.initial_password}`);
  const resetLogin = await login('13800000112', String(reset.data.initial_password), tenant.code);
  check('重置后的密码可登录且提示修改', resetLogin.code === 0 && resetLogin.data?.must_change_password === true);

  await db.run('UPDATE users SET password_hash = NULL WHERE id = ?', [created2.data.id]);
  const noPassword = await login('13800000112', 'whatever', tenant.code);
  check('未设置初始密码的账号被拒', noPassword.code === 'NO_PASSWORD', noPassword.message);

  console.log('\n=== 9. 权限边界 ===');
  const notAdmin = await call('POST', '/api/admin/employees', {
    token: T2, body: { phone: '13800000114', name: '越权', role: 'SALES' },
  });
  check('普通员工不能录入员工', notAdmin.code !== 0, notAdmin.message);
  const crossTenant = await call('POST', `/api/admin/employees/${created.data.id}/password`, { token: ADMIN, body: { password: '999999' } });
  check('管理员可重置本公司员工', crossTenant.code === 0);

  // 清理
  for (const p of TMP) await db.run('DELETE FROM users WHERE tenant_id = ? AND phone = ?', [tenant.id, p]);
  const gone = await login('13800000111', '666666', tenant.code);
  check('清理后无法登录', gone.code === 'NOT_AUTHORIZED');

  console.log(`\n${'='.repeat(46)}\n通过 ${pass} 项，失败 ${failCount} 项\n`);
  await db.close();
  process.exit(failCount ? 1 : 0);
}

main().catch(async (e) => { console.error('运行失败：', e); await db.close(); process.exit(1); });
