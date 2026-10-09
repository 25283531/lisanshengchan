/**
 * 平台注册公司 + 公司列表管理员账号/初始密码 + 首管理员登录（v3.7）
 *
 * 覆盖：
 *   1. 平台注册公司即建好第一个管理员，返回初始密码明文
 *   2. 公司列表带 管理员账号（手机号）/ 初始密码 / 有无管理员
 *   3. 注册者无需先被授权，用手机号 + 初始密码可直接登录
 *   4. 公司编码填错成公司名也能登录；填错成不存在的值给出明确提示
 *   5. 手机号不属于该公司 / 从未授权，分别给出不同提示（不再一律"尚未授权"）
 *   6. 平台可改管理员手机号、可重置初始密码
 *   7. 公司一个管理员都没有时，平台登记的联系人手机号登录会自助补建管理员
 *   8. 管理员自行改密后，明文初始密码即从列表里消失
 * 用法：先 npm start，再 node scripts/tenant-login-demo.js
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
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

const login = (phone, password, tenantCode) => call('POST', '/api/auth/login', { body: { phone, password, tenantCode } });

const db = await createDb();
const stamp = String(Date.now()).slice(-6);
const CODE = `T${stamp}`;
const NAME = `回归测试厂${stamp}`;
const PHONE = `139${stamp}00`;   // 11 位
const PHONE2 = `137${stamp}11`;

/** 平台令牌 */
const pf = await call('POST', '/api/platform/login', { body: { token: config.platformToken } });
const PF = { token: pf.data?.token };

async function main() {
  console.log('\n【1】平台注册公司：同时建好第一个管理员');
  const created = await call('POST', '/api/platform/tenants', {
    token: PF.token,
    body: { code: CODE, name: NAME, adminName: '测试厂长', adminPhone: PHONE, maxUsers: 5 },
  });
  const init = created.data?.initial_password;
  check('注册成功', created.code === 0, created.message);
  check('返回管理员账号（手机号）', created.data?.adminPhone === PHONE, created.data?.adminPhone);
  check('返回初始密码明文（6 位）', /^\d{6}$/.test(String(init || '')), String(init));

  console.log('\n【2】公司列表：管理员账号 + 初始密码');
  const list = await call('GET', '/api/platform/tenants', { token: PF.token });
  const row = (list.data || []).find((t) => t.code === CODE);
  check('列表含该公司', !!row);
  check('列表带管理员账号', row?.admin_phone === PHONE, String(row?.admin_phone));
  check('列表带初始密码', row?.admin_initial_password === init, String(row?.admin_initial_password));
  check('列表标记已有管理员', row?.has_admin === true);

  console.log('\n【3】注册者直接登录（不需要先在后台给自己授权）');
  const okLogin = await login(PHONE, init, CODE);
  check('手机号 + 初始密码登录成功', okLogin.code === 0, okLogin.message);
  check('身份为公司管理员', okLogin.data?.user?.role === 'ADMIN', okLogin.data?.user?.role);
  check('提示仍在使用初始密码', okLogin.data?.must_change_password === true);

  console.log('\n【4】公司编码 vs 公司名称');
  const byName = await login(PHONE, init, NAME);
  check('填公司名称也能登录', byName.code === 0, byName.message);
  const bad = await login(PHONE, init, 'NO_SUCH_COMPANY');
  check('公司编码不存在 → TENANT_NOT_FOUND', bad.code === 'TENANT_NOT_FOUND', `${bad.code} ${bad.message}`);
  const first = await db.get('SELECT code, name FROM tenants ORDER BY id LIMIT 1');
  const mismatch = await login(PHONE, init, first.code);
  check('手机号不属于该公司 → TENANT_MISMATCH', mismatch.code === 'TENANT_MISMATCH', `${mismatch.code} ${mismatch.message}`);
  const nobody = await login('13600000000', '123456', CODE);
  check('从未授权的号码 → NOT_AUTHORIZED', nobody.code === 'NOT_AUTHORIZED', `${nobody.code}`);

  console.log('\n【5】平台改管理员手机号 / 重置初始密码');
  const tid = row.id;
  const upd = await call('PUT', `/api/platform/tenants/${tid}/admin`, { token: PF.token, body: { adminPhone: PHONE2 } });
  check('管理员手机号可改', upd.code === 0, upd.message);
  const reset = await call('POST', `/api/platform/tenants/${tid}/reset-admin`, { token: PF.token, body: {} });
  const init2 = reset.data?.initial_password;
  check('重置后返回新初始密码', /^\d{6}$/.test(String(init2 || '')), String(init2));
  const list2 = await call('GET', '/api/platform/tenants', { token: PF.token });
  const row2 = (list2.data || []).find((t) => t.code === CODE);
  check('列表同步新账号与新密码', row2?.admin_phone === PHONE2 && row2?.admin_initial_password === init2);
  const login2 = await login(PHONE2, init2, CODE);
  check('新管理员账号可登录', login2.code === 0, login2.message);

  console.log('\n【6】管理员自行改密：明文不再留存在列表');
  const changed = await call('POST', '/api/auth/password', {
    token: login2.data.token, body: { oldPassword: init2, newPassword: 'abc123456' },
  });
  check('自行改密成功', changed.code === 0, changed.message);
  const list3 = await call('GET', '/api/platform/tenants', { token: PF.token });
  const row3 = (list3.data || []).find((t) => t.code === CODE);
  check('列表初始密码已清空', row3?.admin_initial_password === null, String(row3?.admin_initial_password));

  console.log('\n【7】首管理员自助开箱（公司一个管理员都没有时）');
  await db.run("DELETE FROM users WHERE tenant_id = ? AND role = 'ADMIN'", [tid]);
  const boot = await login(PHONE2, 'whatever', CODE);
  check('无管理员时按登记手机号补建账号', boot.code === 'BOOTSTRAP_CREATED', `${boot.code} ${boot.message}`);
  const bootRow = await db.get("SELECT * FROM users WHERE tenant_id = ? AND role = 'ADMIN'", [tid]);
  check('已补建 ADMIN', !!bootRow, bootRow?.phone);
  const bootLogin = await login(PHONE2, bootRow?.initial_password, CODE);
  check('用补建的初始密码可登录', bootLogin.code === 0, bootLogin.message);

  // 清理测试数据
  await db.run('DELETE FROM users WHERE tenant_id = ?', [tid]);
  await db.run('DELETE FROM ai_configs WHERE tenant_id = ?', [tid]);
  await db.run('DELETE FROM tenants WHERE id = ?', [tid]);

  console.log(`\n结果：通过 ${pass} 项，失败 ${failCount} 项`);
  process.exit(failCount ? 1 : 0);
}

await main();
