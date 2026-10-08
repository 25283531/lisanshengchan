/**
 * 小程序绑定码模式验证（v3.3）
 *
 * 覆盖：dev- 桩隔离、绑定码生成/使用/重放/过期/错配、越权、角色视图。
 * 用法：node scripts/mp-bind-demo.js
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
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

const db = await createDb();

async function main() {
  const tenant = await db.get('SELECT * FROM tenants ORDER BY id LIMIT 1');
  const adminRow = await db.get("SELECT * FROM users WHERE tenant_id = ? AND role = 'ADMIN'", [tenant.id]);
  console.log(`租户：${tenant.name}（${tenant.code}）\n`);

  const login = await call('POST', '/api/auth/login', {
    body: { tenantCode: tenant.code, phone: adminRow.phone, password: '123456' },
  });
  const ADMIN = login.data.token;
  console.log('=== 1. 服务端模式 ===');
  const cfg = await call('GET', '/api/mp/config');
  check('已识别真实小程序凭证', cfg.data.mode === 'wechat', `appid=${cfg.data.appid}`);
  check('绑定方式含绑定码', cfg.data.bind_methods.includes('bind_code'), cfg.data.bind_methods.join(','));
  check('默认不走付费手机号组件', !cfg.data.bind_methods.includes('phone_component'));

  console.log('\n=== 2. 真实凭证下 dev- 桩仍可用 ===');
  const dev = await call('POST', '/api/mp/login', { body: { code: 'dev-local001', phone: '13800000005' } });
  check('dev- 前缀 code 命中本地桩', dev.code === 0 && dev.data.bound, dev.message);
  const realish = await call('POST', '/api/mp/login', { body: { code: '0b3FakeRealCode' } });
  check('非 dev- code 走真实微信（假 code 被拒）', realish.code !== 0, `微信返回：${String(realish.message).slice(0, 60)}`);
  const spoof = await call('POST', '/api/mp/login', { body: { code: '0b3FakeRealCode', phone: '13800000008' } });
  check('真实 code 不能自报手机号冒绑', spoof.code !== 0);

  console.log('\n=== 3. 管理员生成绑定码 ===');
  const gen = await call('POST', '/api/admin/wx-bind-code', {
    token: ADMIN, body: { phone: '13800000009', ttlMinutes: 10 },
  });
  check('为 PMC(13800000009) 生成成功', gen.code === 0, `${gen.data && gen.data.code} 有效期至 ${gen.data && gen.data.expires_at}`);
  const CODE = gen.data.code;
  check('扫码载荷格式正确', gen.data.scan_payload === `MPBIND:${CODE}`);

  // 13800000002（业务员）是员工但未被开通小程序 → 不能发码
  const noAccess = await call('POST', '/api/admin/wx-bind-code', {
    token: ADMIN, body: { phone: '13800000002' },
  });
  check('未开小白名单的人不能发码', noAccess.code !== 0, noAccess.message);

  const notEmp = await call('POST', '/api/admin/wx-bind-code', {
    token: ADMIN, body: { phone: '13900000000' },
  });
  check('非员工不能发码', notEmp.code !== 0, notEmp.message);

  console.log('\n=== 4. 员工用绑定码登录 ===');
  await db.run('DELETE FROM wx_users WHERE openid = ?', ['dev-pmc-01']);
  const bindRes = await call('POST', '/api/mp/bind-code', {
    body: { code: 'dev-pmc-01', phone: '13800000009', bindCode: CODE },
  });
  check('绑定成功并签发令牌', bindRes.code === 0 && bindRes.data.bound, bindRes.message);
  check('身份正确', bindRes.data && bindRes.data.user.phone === '13800000009',
    bindRes.data ? `${bindRes.data.user.role_zh}` : '');
  check('视图为 PMC 默认（含排产）', bindRes.data && bindRes.data.view_keys.includes('schedule'),
    bindRes.data ? bindRes.data.view_keys.join(',') : '');

  const MP = bindRes.data.token;
  const reLogin = await call('POST', '/api/mp/login', { body: { code: 'dev-pmc-01' } });
  check('二次登录直接命中绑定', reLogin.code === 0 && reLogin.data.bound);

  console.log('\n=== 5. 绑定码安全边界 ===');
  const replay = await call('POST', '/api/mp/bind-code', {
    body: { code: 'dev-pmc-02', phone: '13800000009', bindCode: CODE },
  });
  check('绑定码不可重复使用', replay.code !== 0, replay.message);

  const wrongPhone = await call('POST', '/api/mp/bind-code', {
    body: { code: 'dev-pmc-03', phone: '13800000005', bindCode: CODE },
  });
  check('已用过的码不被其他手机号接受', wrongPhone.code !== 0, wrongPhone.message);

  const gen2 = await call('POST', '/api/admin/wx-bind-code', {
    token: ADMIN, body: { phone: '13800000005', ttlMinutes: 10 },
  });
  const mismatch = await call('POST', '/api/mp/bind-code', {
    body: { code: 'dev-tech-01', phone: '13800000009', bindCode: gen2.data.code },
  });
  check('绑定码与手机号不匹配时拒绝', mismatch.code !== 0, mismatch.message);
  const badCode = await call('POST', '/api/mp/bind-code', {
    body: { code: 'dev-tech-02', phone: '13800000005', bindCode: 'ZZZZZZ' },
  });
  check('不存在的绑定码被拒绝', badCode.code !== 0, badCode.message);

  // 过期码
  const db2 = await createDb();
  await db2.run('UPDATE wx_bind_codes SET expires_at = ? WHERE id = ?',
    ['2020-01-01 00:00:00', (await db2.get('SELECT id FROM wx_bind_codes WHERE code = ?', [gen2.data.code])).id]);
  const expired = await call('POST', '/api/mp/bind-code', {
    body: { code: 'dev-tech-03', phone: '13800000005', bindCode: gen2.data.code },
  });
  check('过期绑定码被拒绝', expired.code !== 0, expired.message);
  await db2.close();

  // 作废
  const gen3 = await call('POST', '/api/admin/wx-bind-code', {
    token: ADMIN, body: { phone: '13800000005', ttlMinutes: 10 },
  });
  const row3 = await db.get('SELECT id FROM wx_bind_codes WHERE code = ?', [gen3.data.code]);
  const revoke = await call('DELETE', `/api/admin/wx-bind-code/${row3.id}`, { token: ADMIN });
  check('管理员可作废未使用的码', revoke.code === 0, revoke.message);
  const afterRevoke = await call('POST', '/api/mp/bind-code', {
    body: { code: 'dev-tech-04', phone: '13800000005', bindCode: gen3.data.code },
  });
  check('作废后无法使用', afterRevoke.code !== 0, afterRevoke.message);

  console.log('\n=== 6. 权限仍受原有四道关约束 ===');
  const noPerm = await call('GET', '/api/mp/view/inventory', { token: MP });
  check('PMC 越权读库存被拦截', noPerm.code !== 0, noPerm.message);
  const okView = await call('GET', '/api/mp/view/schedule', { token: MP });
  check('PMC 读排产正常', okView.code === 0, `${(okView.data.data.tasks || []).length} 条任务`);

  // 关闭白名单后立即失效
  const accRow = await db.get('SELECT id FROM wx_access WHERE tenant_id = ? AND phone = ?', [tenant.id, '13800000009']);
  await call('PUT', `/api/admin/wx-access/${accRow.id}`, { token: ADMIN, body: { enabled: false } });
  const kicked = await call('POST', '/api/mp/login', { body: { code: 'dev-pmc-01' } });
  check('管理员关闭授权后立即失效', kicked.code !== 0, kicked.message);
  await call('PUT', `/api/admin/wx-access/${accRow.id}`, { token: ADMIN, body: { enabled: true } });

  console.log('\n=== 7. 手机号组件自检 ===');
  const probe = await call('GET', '/api/admin/wx-phone-check', { token: ADMIN });
  check('组件自检接口可用', probe.code === 0, `结论=${probe.data.verdict}｜${String(probe.data.detail || '').slice(0, 60)}`);
  check('给出建议', !!probe.data.recommend, probe.data.recommend);

  console.log(`\n${'='.repeat(46)}\n通过 ${pass} 项，失败 ${failCount} 项\n`);
  await db.close();
  process.exit(failCount ? 1 : 0);
}

main().catch(async (e) => { console.error('运行失败：', e); await db.close(); process.exit(1); });
