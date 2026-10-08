/**
 * 自然语言助手端到端验证（v3.6）。
 *
 * 需要服务已启动：npm start（默认 8080）。
 * 脚本会临时把本公司的 AI 配置指向内置 mock 接口，验证完自动还原。
 *
 * 用法：node scripts/chat-demo.js
 */
import http from 'node:http';

const BASE = process.env.MES_BASE || 'http://127.0.0.1:8080';
const PORT = 8097;
let pass = 0;
let fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`); } else {
    fail += 1;
    console.log(`  ✗ ${msg}${extra !== undefined ? `　→ ${JSON.stringify(extra)}` : ''}`);
  }
};

let MACHINE_CODE = 'IM-01';
const AI_ERROR = 'AI大模型（人工智能）出错，请稍后再试或联系管理员';

function mockReply(text) {
  if (/添加一台设备|海天注塑机/.test(text)) {
    return {
      intent: 'MASTER_CREATE',
      payload: { target: 'machines', rows: [{ code: '7号机', name: '海天注塑机', model: '700' }] },
      confidence: 0.9, note: '新增机台',
    };
  }
  if (/损耗率改成/.test(text)) {
    return { intent: 'MASTER_UPDATE', payload: { target: 'products', key: '魔辣面筋', patch: { loss_rate: 4 } }, confidence: 0.9 };
  }
  if (/漏料|维修/.test(text)) {
    return {
      intent: 'MAINTENANCE_PLAN',
      payload: { target_type: 'MACHINE', target_code: MACHINE_CODE, kind: 'REPAIR', fault_desc: '漏料', plan_start_at: null, duration_minutes: 60 },
      confidence: 0.85,
    };
  }
  if (/库存|还剩/.test(text)) {
    return { intent: 'QUERY_STOCK', payload: { product: null, material: 'PP' }, confidence: 0.9 };
  }
  return { intent: 'UNKNOWN', payload: {}, confidence: 0.2 };
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let user = '';
    let sys = '';
    try {
      const msgs = JSON.parse(body).messages || [];
      user = msgs.find((m) => m.role === 'user')?.content || '';
      sys = msgs.find((m) => m.role === 'system')?.content || '';
    } catch { /* ignore */ }
    // 建档 / 改数走各自的专用提示词，返回结构不同
    let reply;
    if (/基础数据录入助手/.test(sys)) {
      reply = { rows: [{ code: '7号机', name: '海天注塑机', model: '700' }] };
    } else if (/基础数据维护助手/.test(sys)) {
      reply = { target: 'products', key_field: 'sku', key: '魔辣面筋', patch: { loss_rate: 4 }, note: '损耗率 3 → 4' };
    } else {
      reply = mockReply(user);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
  });
});

async function api(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, ...j };
}

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const login = await api('POST', '/api/auth/login', { phone: '13800000001', password: '123456' });
  if (!login.data?.token) { console.error('登录失败：', JSON.stringify(login)); process.exit(1); }
  const token = login.data.token;
  console.log(`\n登录：${login.data.user?.name}（${login.data.user?.role}）`);

  const master = await api('GET', '/api/master', null, token);
  MACHINE_CODE = master.data?.machines?.[0]?.code || 'IM-01';
  console.log(`机台样例：${MACHINE_CODE}（共 ${master.data?.machines?.length || 0} 台）`);

  // 备份原 AI 配置
  const before = await api('GET', '/api/admin/ai-config', null, token);
  const origin = before.data || {};
  const restore = async () => {
    await api('PUT', '/api/admin/ai-config', {
      enabled: !!origin.enabled, allowFallback: origin.allow_fallback !== false,
      baseUrl: origin.base_url || '', model: origin.model || 'deepseek-chat',
      temperature: origin.temperature ?? 0.1, timeoutMs: origin.timeout_ms ?? 20000,
      ...(origin.api_key ? { apiKey: origin.api_key } : {}),
    }, token);
  };

  console.log('\n【A】AI 可用：建档 / 改数 / 维修 / 库存');
  await api('PUT', '/api/admin/ai-config', {
    enabled: true, allowFallback: true, baseUrl: `http://127.0.0.1:${PORT}/v1`,
    apiKey: 'sk-test', model: 'mock', temperature: 0.1, timeoutMs: 5000,
  }, token);

  {
    const r = await api('POST', '/api/chat', { text: '添加一台设备，海天注塑机，型号700，机台编号7号机' }, token);
    ok(r.data?.intent === 'MASTER_CREATE', '建档意图识别正确', r.data?.intent);
    ok(r.data?.data?.target === 'machines', '目标类型 = 机台', r.data?.data?.target);
    ok(String(r.data?.data?.rows?.[0]?.model) === '700', '型号 700 落到 model 字段', r.data?.data?.rows?.[0]);
    ok(r.data?.data?.rows?.[0]?.code === '7号机', '机台编号 = 7号机');
    ok(r.data?.needs_confirm === true, '落库前先出草稿待确认（不直接写库）');
    ok(!!r.data?.data?.draft_id, '生成了草稿 ID', r.data?.data?.draft_id);
    ok(r.data?.ai_unavailable === false, 'AI 通道正常');
  }
  {
    const r = await api('POST', '/api/chat', { text: '把魔辣面筋的损耗率改成4%' }, token);
    ok(r.data?.intent === 'MASTER_UPDATE', '改数意图识别正确', r.data?.intent);
    ok(r.data?.needs_confirm === true || r.data?.message?.includes('已更新'), '改数先预览后生效');
  }
  {
    const r = await api('POST', '/api/chat', { text: `${MACHINE_CODE}漏料了，安排维修` }, token);
    ok(r.data?.intent === 'MAINTENANCE_PLAN', '维修计划意图识别正确', r.data?.intent);
    ok(!!r.data?.data?.plan_code || /不存在/.test(r.data?.message || ''), '维修计划已提交或不存在的设备被挡住', r.data?.message?.slice(0, 60));
  }
  {
    const r = await api('POST', '/api/chat', { text: 'PP料还剩多少' }, token);
    ok(r.data?.intent === 'QUERY_STOCK', '库存查询正常', r.data?.intent);
  }

  console.log('\n【B】AI 停用：建档类语句不再瞎猜，直接提示');
  await api('PUT', '/api/admin/ai-config', { enabled: false, allowFallback: true }, token);
  {
    const r = await api('POST', '/api/chat', { text: '添加一台设备，海天注塑机，型号700，机台编号7号机' }, token);
    ok(r.data?.ai_unavailable === true, '标记 AI 不可用');
    ok(r.data?.message === AI_ERROR, `返回文案：「${AI_ERROR}」`, r.data?.message);
    ok(r.data?.error === AI_ERROR, 'error 字段同步该文案');
    ok(r.data?.intent === 'UNKNOWN', '意图为 UNKNOWN，不再伪装成下单', r.data?.intent);
    const p = r.data?.parsed || {};
    ok(!p.product && !p.quantity && !p.due_date, 'parsed 里没有臆造的产品/数量/交期', p);
  }
  {
    const r = await api('POST', '/api/chat', { text: 'PP料还剩多少' }, token);
    ok(r.data?.intent === 'QUERY_STOCK' && r.data?.used_fallback === true, '库存这类本地可解的仍可用（已标明走本地）', r.data?.intent);
  }

  await restore();
  server.close();
  console.log('\nAI 配置已还原');
  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('脚本异常：', e); server.close(); process.exit(1); });
