#!/usr/bin/env node
/**
 * 端到端演示：业务员一句话下单 → 自动匹配机台/模具/原料/标签 → 排产 → 各角色收到消息
 *              → 生产人员一句话出库 → 待生产数量回扣
 *
 *   node scripts/demo-flow.js
 */
import { buildServer } from '../src/index.js';
import { createDb } from '../src/db/index.js';
import { TENANT, ADMIN, EMPLOYEES } from './seed.js';

const hr = (t) => console.log(`\n${'─'.repeat(64)}\n▶ ${t}\n${'─'.repeat(64)}`);

async function main() {
  const db = await createDb();
  const { app } = await buildServer({ db, migrate: true });

  const login = async (phone) => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { phone, password: '123456', tenantCode: TENANT.code } });
    const b = JSON.parse(r.body);
    if (!b.data?.token) throw new Error(`登录失败 ${phone}：${r.body}`);
    return b.data;
  };
  const chat = async (token, text) => {
    const r = await app.inject({ method: 'POST', url: '/api/chat', headers: { authorization: `Bearer ${token}` }, payload: { text } });
    return JSON.parse(r.body).data;
  };
  const notes = async (token) => {
    const r = await app.inject({ method: 'GET', url: '/api/notifications?limit=30', headers: { authorization: `Bearer ${token}` } });
    return JSON.parse(r.body).data || [];
  };

  const sales = await login(EMPLOYEES.find((e) => e.role === 'SALES').phone);
  hr(`业务员「${sales.user.name}」说出一句自然语言`);
  console.log('🗣  河北的魔辣面筋下2万个订单，13号交货\n');
  const r1 = await chat(sales.token, '河北的魔辣面筋下2万个订单，13号交货');
  console.log(`意图：${r1.intent}　置信度：${r1.confidence}　解析方式：${r1.used_fallback ? '确定性兜底' : 'AI'}`);
  console.log(`\n${r1.message}`);
  if (r1.data?.task) {
    const t = r1.data.task;
    console.log(`\n排产明细：机台 ${t.machine_code}｜模具 ${t.mold_code}｜${t.decision}`);
    console.log(`换料指令 ${t.feeding_order_at}　备料到位 ${t.feeding_ready_at}`);
  }

  hr('配料员「陈配料」收到的消息');
  const mixer = await login(EMPLOYEES.find((e) => e.role === 'MIXER').phone);
  for (const n of (await notes(mixer.token)).filter((x) => x.type === 'MATERIAL_PLAN')) {
    console.log(`\n【${n.title}】\n${n.body}`);
  }

  hr('技术员「赵技术」收到的消息');
  const tech = await login(EMPLOYEES.find((e) => e.role === 'TECHNICIAN').phone);
  for (const n of await notes(tech.token)) {
    console.log(`\n【${n.title}】${n.level}\n${n.body}`);
  }

  hr('生产人员「李生产」（已绑定机台 IM-01）收到的消息');
  const p1 = await login(EMPLOYEES.find((e) => e.role === 'PRODUCTION' && e.machineCode).phone);
  const n1 = await notes(p1.token);
  for (const n of n1) console.log(`\n【${n.title}】\n${n.body}`);
  console.log(`\n（共 ${n1.length} 条，仅含本机台 + 广播）`);

  hr('生产人员「王生产」（未绑定机台）收到的消息');
  const p2 = await login(EMPLOYEES.find((e) => e.role === 'PRODUCTION' && !e.machineCode).phone);
  const n2 = await notes(p2.token);
  console.log(`共 ${n2.length} 条：${n2.map((x) => x.type).join('、')}`);

  hr('仓库管理员「刘仓库」收到的缺料/缺标签告警');
  const wh = await login(EMPLOYEES.find((e) => e.role === 'WAREHOUSE').phone);
  for (const n of (await notes(wh.token)).filter((x) => /SHORTAGE|OUTBOUND/.test(x.type))) {
    console.log(`\n【${n.title}】\n${n.body}`);
  }

  hr(`生产人员「${p1.user.name}」语音报出库`);
  console.log('🗣  河北麻辣面筋出库5000个\n');
  const r2 = await chat(p1.token, '河北麻辣面筋出库5000个');
  console.log(`意图：${r2.intent}　置信度：${r2.confidence}`);
  console.log(r2.message);

  hr('交接班：当班生产任务（12 小时窗口）');
  const shift = await app.inject({
    method: 'GET', url: '/api/schedule/shift?hours=12',
    headers: { authorization: `Bearer ${p1.token}` },
  });
  const sd = JSON.parse(shift.body).data;
  for (const it of sd.items) {
    console.log(`机台 ${it.machine_code}｜${it.product_name}｜${it.planned_qty} 个｜模具 ${it.mold_code}｜${it.window_start.slice(5, 16)}~${it.window_end.slice(5, 16)}`);
  }
  if (!sd.items.length) console.log('当前窗口内无任务');

  await app.close();
  db.close();
}

main().catch((e) => { console.error('演示失败：', e); process.exit(1); });
