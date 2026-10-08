/**
 * v3.5 能力端到端验证（需先 `npm start` 起服务，且已 seed）：
 *   1. AI 配置三级优先级（平台 → 公司 → env）
 *   2. 基础数据自然语言录入 + 表格附件上传 + 确认落库
 *   3. 自然语言改数（预览 → 确认）
 *   4. 设备维修计划：提交 → 流转 → 设备状态联动 → 消息分发
 *   5. 全员通过 APP 接口提交订单/报工
 *
 * 用法：node scripts/intake-demo.js
 */
import ExcelJS from 'exceljs';

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
let pass = 0; let failed = 0;

function assert(cond, label, extra) {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); } else {
    failed += 1; console.log(`  ❌ ${label}${extra ? ` → ${JSON.stringify(extra)}` : ''}`);
  }
}
const section = (t) => console.log(`\n── ${t} ──`);

async function call(method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && !form) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: form || (body ? JSON.stringify(body) : undefined),
  });
  return res.json();
}

async function login(phone, password = '123456') {
  const r = await call('POST', '/api/auth/login', { body: { phone, password } });
  if (r.code !== 0) throw new Error(`登录失败 ${phone}：${r.message}`);
  return r.data.token;
}

const main = async () => {
  const admin = await login('13800000001');
  const tech = await login('13800000005');
  const sales = await login('13800000002');
  const prod = await login('13800000003');
  const pfTok = (await call('POST', '/api/platform/login', { body: { token: 'change-this-platform-token' } })).data.token;

  /* ---------------- 1. AI 配置层级 ---------------- */
  section('1. AI 接口配置：平台统一 + 公司覆盖');
  const pfAi = await call('GET', '/api/platform/ai-config', { token: pfTok });
  assert(pfAi.code === 0 && pfAi.data, '平台可读取 AI 配置');
  await call('PUT', '/api/platform/ai-config', {
    token: pfTok, body: { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', allowTenantOverride: true, enabled: true },
  });
  const pfAfter = (await call('GET', '/api/platform/ai-config', { token: pfTok })).data;
  assert(pfAfter.model === 'deepseek-chat', '平台配置保存后可读回');
  assert(pfAfter.allow_tenant_override === true, '平台默认允许公司自定义');

  const companyAi1 = (await call('GET', '/api/admin/ai-config', { token: admin })).data;
  assert(companyAi1.source === 'platform', '公司未自定义时生效来源为平台', companyAi1.source);
  assert(typeof companyAi1.explain === 'string' && companyAi1.explain.length > 0, '公司页面有层级说明文字');

  await call('PUT', '/api/admin/ai-config', { token: admin, body: { apiKey: 'sk-company-demo', model: 'qwen-plus' } });
  const companyAi2 = (await call('GET', '/api/admin/ai-config', { token: admin })).data;
  assert(companyAi2.source === 'tenant', '公司填写 Key 后生效来源切到公司', companyAi2.source);
  assert(companyAi2.model === 'qwen-plus', '公司自定义模型生效');
  assert(companyAi2.api_key_set === true && companyAi2.api_key_mask !== 'sk-company-demo', 'Key 对外只返回掩码');

  await call('PUT', '/api/platform/ai-config', { token: pfTok, body: { allowTenantOverride: false } });
  const lockedPut = await call('PUT', '/api/admin/ai-config', { token: admin, body: { model: 'hack' } });
  assert(lockedPut.code === 'AI_LOCKED_BY_PLATFORM', '平台锁定后公司不可改配置', lockedPut.code);
  await call('PUT', '/api/platform/ai-config', { token: pfTok, body: { allowTenantOverride: true } });
  await call('DELETE', '/api/admin/ai-config', { token: admin });
  const companyAi3 = (await call('GET', '/api/admin/ai-config', { token: admin })).data;
  assert(companyAi3.source === 'platform', '公司恢复使用平台配置');

  /* ---------------- 2. 智能录入 ---------------- */
  section('2. 基础数据智能录入（自然语言 / Excel）');
  const targets = (await call('GET', '/api/intake/targets', { token: admin })).data;
  assert(targets.targets.length >= 8, '可录入类型列表可读', targets.targets?.length);
  assert(targets.targets.find((t) => t.key === 'products').fields.some((f) => f.field === 'sku'), '产品字段定义可读');

  const textRes = await call('POST', '/api/intake/text', {
    token: admin,
    body: { target: 'products', text: 'SKU\t名称\t损耗率\nIT-01\t验证产品甲\t3\nIT-02\t验证产品乙\t4' },
  });
  assert(textRes.code === 0 && textRes.data.rows.length === 2, '自然语言/文本解析出 2 条产品', textRes.data?.rows?.length);
  assert(textRes.data.rows[0].sku === 'IT-01' && textRes.data.rows[0].loss_rate === 3, '表头映射与数值归一化正确', textRes.data.rows[0]);

  const commitRes = await call('POST', '/api/intake/commit', {
    token: admin, body: { target: 'products', rows: textRes.data.rows, draftId: textRes.data.draft_id },
  });
  assert(commitRes.data.created === 2, '首次导入为新增 2 条', commitRes.data);
  const commitRes2 = await call('POST', '/api/intake/commit', {
    token: admin, body: { target: 'products', rows: [{ sku: 'IT-01', name: '验证产品甲', loss_rate: 6 }] },
  });
  assert(commitRes2.data.updated === 1, '重复编码按更新处理', commitRes2.data);
  const badCommit = await call('POST', '/api/intake/commit', { token: admin, body: { target: 'products', rows: [{ name: '没编码' }] } });
  assert(badCommit.data.failed.length === 1, '缺编码的行被拦下并给出原因', badCommit.data.failed);

  // Excel 附件
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('客户');
  ws.addRow(['编码', '客户名称', '别名']);
  ws.addRow(['IT-C1', '验证客户甲', '甲客户']);
  ws.addRow(['IT-C2', '验证客户乙', '乙客户,乙总']);
  const buf = await wb.xlsx.writeBuffer();
  const fd = new FormData();
  fd.append('target', 'customers');
  fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'customers.xlsx');
  const fileRes = await call('POST', '/api/intake/file', { token: admin, form: fd });
  assert(fileRes.code === 0 && fileRes.data.rows.length === 2, 'Excel 附件解析出 2 条客户', fileRes.data);
  assert(fileRes.data.rows[1].aliases.length === 2, '多值字段（别名）按数组解析', fileRes.data.rows[1]);
  const fileCommit = await call('POST', '/api/intake/commit', { token: admin, body: { target: 'customers', rows: fileRes.data.rows } });
  assert(fileCommit.data.created === 2, 'Excel 数据可落库', fileCommit.data);

  const drafts = (await call('GET', '/api/intake/drafts', { token: admin })).data;
  assert(drafts.length >= 2, '草稿列表可追溯', drafts.length);

  /* ---------------- 3. 自然语言改数 ---------------- */
  section('3. 自然语言修改基础数据');
  const modRes = await call('POST', '/api/intake/modify', { token: admin, body: { text: '把 IT-01 的 损耗率 改成 8' } });
  assert(modRes.code === 0 && modRes.data.ok === true, '按句式解析到待改记录', modRes.data);
  assert(modRes.data.changes[0].field === 'loss_rate' && modRes.data.changes[0].after === 8, '生成正确的字段补丁', modRes.data.changes);
  const applyRes = await call('POST', '/api/intake/apply', {
    token: admin,
    body: { target: modRes.data.target, recordId: modRes.data.record_id, patch: { loss_rate: 8 }, text: '把 IT-01 的 损耗率 改成 8' },
  });
  assert(applyRes.code === 0, '改数确认后落库', applyRes);
  const modMiss = await call('POST', '/api/intake/modify', { token: admin, body: { text: '把 不存在的产品 的 损耗率 改成 9' } });
  assert(modMiss.data.ok === false && /没找到/.test(modMiss.data.message), '定位不到记录时如实提示', modMiss.data.message);
  const modBad = await call('POST', '/api/intake/modify', { token: admin, body: { text: '今天天气不错' } });
  assert(modBad.data.ok === false, '无法理解的句子不臆造改动', modBad.data.message);

  /* ---------------- 4. 设备维修计划 ---------------- */
  section('4. 设备维修计划（技术员提交 / 状态联动）');
  const ov0 = (await call('GET', '/api/maintenance/overview', { token: tech })).data;
  assert(Array.isArray(ov0.machines) && ov0.machines.length > 0, '设备维护总览可读', ov0.counts);

  const machineCode = ov0.machines[0].code;
  const plan = await call('POST', '/api/maintenance/plans', {
    token: tech,
    body: { targetType: 'MACHINE', targetCode: machineCode, kind: 'REPAIR', faultDesc: '油温异常，需停机检修', durationMinutes: 120 },
  });
  assert(plan.code === 0 && /^MP-/.test(plan.data.code), '技术员可提交维修计划', plan.data);
  const planId = plan.data.id;

  const doing = await call('POST', `/api/maintenance/plans/${planId}/status`, { token: tech, body: { status: 'DOING', note: '已停机，开始检修' } });
  assert(doing.code === 0, '计划可推进为进行中', doing);
  const ov1 = (await call('GET', '/api/maintenance/overview', { token: tech })).data;
  assert(ov1.machines.find((m) => m.code === machineCode).status === 'MAINTENANCE', '开始维修后机台自动置为维护中');

  const done = await call('POST', `/api/maintenance/plans/${planId}/status`, { token: tech, body: { status: 'DONE', note: '更换油温传感器，已复产' } });
  assert(done.code === 0, '计划可置为完成');
  const ov2 = (await call('GET', '/api/maintenance/overview', { token: tech })).data;
  assert(ov2.machines.find((m) => m.code === machineCode).status === 'AVAILABLE', '维修完成后机台恢复可用');

  const badStatus = await call('POST', `/api/maintenance/plans/${planId}/status`, { token: tech, body: { status: 'XXX' } });
  assert(badStatus.code === 'BAD_STATUS', '非法状态被拒绝', badStatus.code);
  const closedEdit = await call('PUT', `/api/maintenance/plans/${planId}`, { token: tech, body: { faultDesc: '改不了' } });
  assert(closedEdit.code === 'PLAN_CLOSED', '已结束的计划不可再改', closedEdit.code);
  const noPerm = await call('POST', '/api/maintenance/plans', {
    token: sales, body: { targetType: 'MACHINE', targetCode: machineCode, kind: 'REPAIR' },
  });
  assert(noPerm.code === 'FORBIDDEN', '非技术员不能提交维修计划', noPerm.code);

  /* ---------------- 5. 全员通过 APP 提交业务 ---------------- */
  section('5. 各角色通过 APP 提交与接收');
  const master = (await call('GET', '/api/master', { token: sales })).data;
  const product = master.products[0];
  const ord = await call('POST', '/api/orders', {
    token: sales, body: { productId: product.id, quantity: 500, dueDate: '2026-12-31', note: 'APP 下单验证' },
  });
  assert(ord.code === 0, '业务员可提交新订单（APP 通道）', ord);
  const upd = await call('PUT', `/api/orders/${ord.data.id}`, { token: sales, body: { quantity: 800 } });
  assert(upd.code === 0, '业务员可修改订单', upd);
  const bossOrder = await call('POST', '/api/orders', { token: prod, body: { productId: product.id, quantity: 10 } });
  assert(bossOrder.code === 'FORBIDDEN', '生产人员不可下单（权限仍受控）', bossOrder.code);

  const prog = await call('POST', `/api/orders/${ord.data.id}/progress`, { token: prod, body: { qty: 100 } });
  assert(prog.code === 0 && prog.data.completed_qty === 100, '生产人员可提交当班产量（报工）', prog.data);
  const shift = await call('GET', '/api/schedule/shift?hours=12', { token: prod });
  assert(shift.code === 0, '生产人员可接收当班任务', shift.data?.items?.length ?? 0);

  const techPlans = await call('GET', '/api/maintenance/plans?mine=1', { token: tech });
  assert(techPlans.code === 0 && techPlans.data.length >= 1, '技术员可查看自己提交的维修计划');
  const prodOverview = await call('GET', '/api/maintenance/overview', { token: prod });
  assert(prodOverview.code === 0, '生产人员可接收设备维护状态');

  const notifies = await call('GET', '/api/notifications?limit=10', { token: prod });
  assert(notifies.code === 0 && notifies.data.some((n) => n.ref_type === 'MAINTENANCE'), '维修消息已分发到相关角色',
    notifies.data?.slice(0, 3).map((n) => n.type));

  console.log(`\n${failed === 0 ? '🎉' : '⚠️'} 通过 ${pass} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((e) => { console.error('运行失败：', e); process.exit(1); });
