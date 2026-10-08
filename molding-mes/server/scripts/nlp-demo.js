/**
 * 语义解析定性验证（v3.6）。
 *
 * 覆盖四条定案：
 *  1. AI 优先；AI 不可用且本地接不住 → 明确报「AI大模型（人工智能）出错，请稍后再试或联系管理员」
 *  2. 本地解析只兜底「订单 / 设备状态 / 库存」，建档、改数、维修计划本地一律不接
 *  3. 日期不再被"7号机"带偏；数量不再被"型号700"污染
 *  4. 低置信度实体不写进 payload（反臆造）
 *
 * 用法：node scripts/nlp-demo.js（会读本地 data/mes.db 取主数据；不写库）
 */
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { parseUtterance, AI_ERROR_MESSAGE } from '../src/domain/nlp.js';

const PORT = 8098;
let pass = 0;
let fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`); } else {
    fail += 1;
    console.log(`  ✗ ${msg}${extra !== undefined ? `　→ ${JSON.stringify(extra)}` : ''}`);
  }
};

/* ------------------------- mock OpenAI 兼容接口 ------------------------- */
function mockReply(text) {
  if (/添加一台设备|海天注塑机/.test(text)) {
    return {
      intent: 'MASTER_CREATE',
      payload: { target: 'machines', rows: [{ code: '7号机', name: '海天注塑机', model: '700' }] },
      confidence: 0.9, note: '新增机台 7号机',
    };
  }
  if (/损耗率改成/.test(text)) {
    return { intent: 'MASTER_UPDATE', payload: { target: 'products', key: '魔辣面筋', patch: { loss_rate: 4 } }, confidence: 0.9 };
  }
  if (/漏料|维修/.test(text)) {
    return {
      intent: 'MAINTENANCE_PLAN',
      payload: { target_type: 'MACHINE', target_code: '3号机', kind: 'REPAIR', fault_desc: '漏料', plan_start_at: null, duration_minutes: null },
      confidence: 0.85,
    };
  }
  if (/库存|还剩/.test(text)) {
    return { intent: 'QUERY_STOCK', payload: { product: null, material: 'PP' }, confidence: 0.9 };
  }
  return { intent: 'UNKNOWN', payload: {}, confidence: 0.2, note: '没理解' };
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let user = '';
    try { user = JSON.parse(body).messages?.find((m) => m.role === 'user')?.content || ''; } catch { /* ignore */ }
    const reply = mockReply(user);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
  });
});

/* ------------------------------ 主数据 ------------------------------ */
const db = new DatabaseSync('data/mes.db');
const q = (sql) => db.prepare(sql).all();
const T = q('SELECT id FROM tenants ORDER BY id LIMIT 1')[0]?.id || 1;
const ctxBase = {
  customers: q(`SELECT * FROM customers WHERE tenant_id = ${T}`),
  products: q(`SELECT * FROM products WHERE tenant_id = ${T}`),
  materials: q(`SELECT * FROM materials WHERE tenant_id = ${T}`),
  molds: q(`SELECT * FROM molds WHERE tenant_id = ${T}`),
  machines: q(`SELECT * FROM machines WHERE tenant_id = ${T}`),
  today: new Date().toISOString().slice(0, 10),
};
for (const c of ctxBase.customers) c.aliases = JSON.parse(c.aliases || '[]');
for (const p of ctxBase.products) { p.aliases = JSON.parse(p.aliases || '[]'); p.mold_codes = JSON.parse(p.mold_codes || '[]'); }

const cfgAi = (over = {}) => ({
  provider: 'mock', enabled: true, allow_fallback: true,
  base_url: `http://127.0.0.1:${PORT}/v1`, api_key: 'sk-test',
  model: 'mock', temperature: 0.1, timeout_ms: 5000, ...over,
});
const cfgNoAi = { provider: 'none', enabled: false, allow_fallback: true, base_url: '', api_key: null, model: 'x', temperature: 0.1, timeout_ms: 1000 };

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log(`\n主数据：产品 ${ctxBase.products.length} / 客户 ${ctxBase.customers.length} / 机台 ${ctxBase.machines.length}\n`);

  const TEXT_DEVICE = '添加一台设备，海天注塑机，型号700，机台编号7号机';

  console.log('【一】AI 不可用时的定性行为');
  {
    const r = await parseUtterance(TEXT_DEVICE, { ...ctxBase, aiConfig: cfgNoAi });
    ok(r.intent === 'UNKNOWN', '建档语句本地不接，intent 保持 UNKNOWN', r.intent);
    ok(r.aiUnavailable === true, '标记 aiUnavailable');
    ok(r.error === AI_ERROR_MESSAGE, `提示文案为「${AI_ERROR_MESSAGE}」`, r.error);
    ok(r.payload && Object.keys(r.payload).length === 0, 'payload 为空，不再臆造产品/数量/交期', r.payload);
    ok((r.candidates || []).length === 0, '不再推送无关的产品/客户候选', r.candidates);
    ok(r.confidence === 0, '置信度归零', r.confidence);
  }
  {
    const r = await parseUtterance('把魔辣面筋的损耗率改成4%', { ...ctxBase, aiConfig: cfgNoAi });
    ok(r.aiUnavailable === true, '改数语句本地不接，报 AI 不可用');
  }
  {
    const r = await parseUtterance('3号机漏料了，安排维修', { ...ctxBase, aiConfig: cfgNoAi });
    ok(r.aiUnavailable === true, '维修计划本地不接，报 AI 不可用');
  }
  {
    const r = await parseUtterance('帮我看看今天生产情况怎么样', { ...ctxBase, aiConfig: cfgNoAi });
    ok(r.aiUnavailable === true, '闲聊/无法判定 → 报 AI 不可用（不再瞎猜意图）', r.intent);
  }

  console.log('\n【二】AI 优先 + 输出落内部 JSON');
  {
    const r = await parseUtterance(TEXT_DEVICE, { ...ctxBase, aiConfig: cfgAi() });
    ok(r.intent === 'MASTER_CREATE', '这条被正确识别为「新增基础数据」', r.intent);
    ok(r.payload.target === 'machines', 'target = machines（机台）', r.payload.target);
    ok(r.payload.rows?.[0]?.code === '7号机', '机台编号 = 7号机', r.payload.rows?.[0]);
    ok(r.payload.rows?.[0]?.name === '海天注塑机', '机台名称 = 海天注塑机');
    ok(String(r.payload.rows?.[0]?.model) === '700', '型号 700 落到 model 字段，没被当成数量', r.payload.rows?.[0]);
    ok(r.usedFallback === false, '走的是 AI 通道', r.usedFallback);
    ok(r.payload.quantity == null, 'payload 里不再出现 quantity', r.payload.quantity);
    ok(r.payload.due_date == null, 'payload 里不再出现臆造交期', r.payload.due_date);
  }
  {
    const r = await parseUtterance('把魔辣面筋的损耗率改成4%', { ...ctxBase, aiConfig: cfgAi() });
    ok(r.intent === 'MASTER_UPDATE' && r.payload.patch?.loss_rate === 4, '改数解析为 patch', r.payload);
  }
  {
    const r = await parseUtterance('3号机漏料了', { ...ctxBase, aiConfig: cfgAi() });
    ok(r.intent === 'MAINTENANCE_PLAN' && r.payload.target_code === '3号机', '维修计划解析', r.payload);
  }

  console.log('\n【三】AI 挂了：本地可解析的降级，本地接不住的报错');
  {
    const bad = cfgAi({ base_url: 'http://127.0.0.1:1/v1' });
    const r1 = await parseUtterance('河北的魔辣面筋下2万个订单，13号交货', { ...ctxBase, aiConfig: bad });
    ok(r1.usedFallback === true && r1.intent === 'CREATE_ORDER', '订单句在 AI 挂掉后降级为本地解析', r1.intent);
    ok(r1.error && r1.error.includes('AI 解析失败'), '明确告知已降级', r1.error);
    const r2 = await parseUtterance(TEXT_DEVICE, { ...ctxBase, aiConfig: bad });
    ok(r2.aiUnavailable === true, '建档句在 AI 挂掉后直接报错，不用本地猜', r2.intent);
  }
  {
    const r = await parseUtterance(TEXT_DEVICE, { ...ctxBase, aiConfig: cfgAi({ base_url: 'http://127.0.0.1:1/v1', allow_fallback: false }) });
    ok(r.aiUnavailable === true, '关闭兜底开关后，一律报 AI 不可用');
  }

  console.log('\n【四】本地解析不再误判（本次 bug 根因）');
  {
    const r = await parseUtterance('7号机做魔辣面筋2万个，13号交货', { ...ctxBase, aiConfig: cfgNoAi });
    ok(r.intent === 'CREATE_ORDER', '本地能判出下单', r.intent);
    ok(Number(r.payload.quantity) === 20000, '数量 = 20000（"7号机"没被当成数量）', r.payload.quantity);
    const d = String(r.payload.due_date || '');
    ok(/^\d{4}-\d{2}-13$/.test(d), `交期落在 13 号，没被"7号机"带成 7 号：${d}`, r.payload.due_date);
  }
  {
    const r = await parseUtterance('海天注塑机要货700', { ...ctxBase, aiConfig: cfgNoAi });
    ok(r.payload.product === null, '匹配不上产品时 payload.product 为 null（不再塞"魔辣面筋包装盒"）', r.payload.product);
    ok(r.resolved.product === null, 'resolved 里也不放低分匹配', r.resolved.product);
  }
  {
    const r = await parseUtterance('PP料还剩多少', { ...ctxBase, aiConfig: cfgNoAi });
    ok(r.intent === 'QUERY_STOCK', '库存查询本地可解', r.intent);
  }
  {
    const r = await parseUtterance('3号机现在什么状态', { ...ctxBase, aiConfig: cfgNoAi });
    ok(r.intent === 'MACHINE_STATUS', '设备状态本地可解', r.intent);
  }

  server.close();
  db.close();
  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('脚本异常：', e); server.close(); process.exit(1); });
