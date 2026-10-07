/**
 * 自然语言解析：把员工的一句话转成内部数据。
 *
 * 两级策略：
 *  1. AI 解析（租户后台可配 BaseURL / APIKey / 模型，OpenAI 兼容协议）。
 *     系统提示词注入本公司主数据（产品、别名、客户、模具、原料），
 *     让模型在既有实体内做匹配，而不是自由发挥。
 *  2. 确定性兜底解析（未配 API Key、调用失败或超时时启用）：
 *     关键词判意图 + 中文数量/日期解析 + 词典相似度匹配。
 *
 * 设计原则：解析结果一律「带置信度」。实体没匹配上就返回候选让用户确认，
 * 绝不拿经验值硬填——这与专家团的数据治理口径一致。
 */
import { arr, num, similarity, parseChineseNumber, parseChineseDate, toDateStr } from '../lib/util.js';

export const INTENTS = ['CREATE_ORDER', 'OUTBOUND', 'PROGRESS', 'QUERY_STOCK', 'QUERY_SCHEDULE', 'UNKNOWN'];

const SYSTEM_PROMPT = (ctx) => `你是注塑工厂的生产助理，负责把员工口语化的中文短句解析成结构化 JSON。

你必须只从下面给定的本公司主数据中选择实体，禁止臆造不存在的客户、产品、原料。

【客户列表】
${ctx.customers.map((c) => `- ${c.name}${arr(c.aliases).length ? `（别名：${arr(c.aliases).join('、')}）` : ''}`).join('\n') || '（暂无）'}

【产品列表】
${ctx.products.map((p) => `- 名称：${p.name}｜SKU：${p.sku}${arr(p.aliases).length ? `｜别名：${arr(p.aliases).join('、')}` : ''}${p.logo_version ? `｜标志版本：${p.logo_version}` : ''}`).join('\n') || '（暂无）'}

【原料列表】
${ctx.materials.map((m) => `- ${m.name}（${m.sku}）`).join('\n') || '（暂无）'}

【意图定义】
- CREATE_ORDER：下订单 / 要做货 / 客户要货。必须抽出 customer、product、quantity、due_date。
- OUTBOUND：出库 / 发货 / 送走 / 已发出。抽出 customer、product、quantity。
- PROGRESS：报工 / 完成 / 做了多少。抽出 product、quantity。
- QUERY_STOCK：问库存 / 还剩多少。
- QUERY_SCHEDULE：问排产 / 什么时候做 / 交期能否赶上。
- UNKNOWN：无法判断。

【输出格式】严格输出 JSON，不要任何解释文字、不要 markdown 代码块：
{
  "intent": "CREATE_ORDER|OUTBOUND|PROGRESS|QUERY_STOCK|QUERY_SCHEDULE|UNKNOWN",
  "customer": "客户名称原文或 null",
  "product": "产品名称原文或 null",
  "quantity": 数字或 null,
  "unit": "个|只|箱|kg 或 null",
  "due_date": "YYYY-MM-DD 或 null",
  "note": "备注或 null",
  "confidence": 0 到 1 之间的小数
}

【日期规则】今天是 ${ctx.today}。
- "13号" 指本月 13 日；若已过则为次月 13 日。
- "10月13号" 指本年 10 月 13 日。
- "明天/后天/大后天" 按今天推算。
- 没有提到交期时 due_date 为 null。

【数量规则】
- "2万" = 20000，"2万个" = 20000，"1.5万" = 15000，"5000个" = 5000。

【示例】
输入：河北的魔辣面筋下2万个订单，13号交货
输出：{"intent":"CREATE_ORDER","customer":"河北","product":"魔辣面筋","quantity":20000,"unit":"个","due_date":"${ctx.today.slice(0, 8)}13","note":null,"confidence":0.95}

输入：河北麻辣面筋出库5000个
输出：{"intent":"OUTBOUND","customer":"河北","product":"麻辣面筋","quantity":5000,"unit":"个","due_date":null,"note":null,"confidence":0.95}`;

/* ------------------------------ 实体匹配 ------------------------------- */

function matchEntity(text, list, nameKey = 'name') {
  if (!text) return null;
  const t = String(text).trim();
  let best = null;
  for (const item of list) {
    const names = [item[nameKey], ...arr(item.aliases)];
    for (const n of names) {
      if (!n) continue;
      const s = similarity(t, String(n));
      if (!best || s > best.score) best = { item, score: s, matched: String(n) };
    }
  }
  return best;
}

/** 在整句中先定位客户（优先最长包含），再在剩余文本里匹配产品 */
function resolveByText(text, ctx) {
  let rest = String(text || '');
  let customer = null;
  for (const c of ctx.customers) {
    const names = [c.name, ...arr(c.aliases)].filter(Boolean).sort((a, b) => String(b).length - String(a).length);
    for (const n of names) {
      if (rest.includes(String(n))) {
        customer = { item: c, score: 1, matched: String(n) };
        rest = rest.replace(String(n), ' ');
        break;
      }
    }
    if (customer) break;
  }
  const product = matchEntity(rest.replace(/[的了和与及，,。]/g, ' ').trim(), ctx.products);
  return { customer, product, rest };
}

/* ------------------------------ 兜底解析 ------------------------------- */

export function fallbackParse(text, ctx) {
  const raw = String(text || '');
  let rest = raw;

  // 日期优先剥离，避免 "13号" 被当成数量
  const dateStr = parseChineseDate(raw);
  let quantity = null;
  const noDate = raw
    .replace(/(\d{4})[-/.年]\d{1,2}[-/.月]\d{1,2}日?/g, ' ')
    .replace(/(\d{1,2})[-/.月]\d{1,2}日?号?/g, ' ')
    .replace(/\d{1,2}\s*[号日]/g, ' ')
    .replace(/今天|明天|后天|大后天/g, ' ');
  quantity = parseChineseNumber(noDate);

  // 意图判定
  let intent = 'UNKNOWN';
  if (/出库|发货|发出了|送走|已发|发走|出库了/.test(raw)) intent = 'OUTBOUND';
  else if (/报工|完成|做完了|已生产|产出/.test(raw)) intent = 'PROGRESS';
  else if (/库存|还剩|还有多少|够不够/.test(raw)) intent = 'QUERY_STOCK';
  else if (/排产|计划|什么时候|几号做|能否赶上|交期/.test(raw)) intent = 'QUERY_SCHEDULE';
  else if (/下.{0,4}(订单|单)|订|要货|来一批|做|生产|需要/.test(raw)) intent = 'CREATE_ORDER';

  const { customer, product } = resolveByText(rest, ctx);

  const payload = {
    customer: customer?.matched || null,
    product: product?.matched || null,
    quantity,
    unit: '个',
    due_date: dateStr,
    note: null,
  };

  const resolvedProduct = product && product.score >= 0.6 ? product.item : null;
  const resolvedCustomer = customer && customer.score >= 0.6 ? customer.item : null;

  let confidence = 0.4;
  if (resolvedProduct) confidence += 0.35;
  if (quantity) confidence += 0.15;
  if (resolvedCustomer) confidence += 0.1;
  if (intent === 'CREATE_ORDER' && dateStr) confidence += 0.05;

  const candidates = [];
  if (!resolvedProduct) {
    candidates.push({
      field: 'product',
      input: payload.product,
      options: ctx.products.slice(0, 8).map((p) => ({ id: p.id, name: p.name, sku: p.sku })),
    });
  }
  if (!resolvedCustomer && ctx.customers.length) {
    candidates.push({
      field: 'customer',
      input: payload.customer,
      options: ctx.customers.slice(0, 8).map((c) => ({ id: c.id, name: c.name, code: c.code })),
    });
  }

  return {
    intent,
    payload,
    resolved: { product: resolvedProduct, customer: resolvedCustomer },
    confidence: Math.min(1, confidence),
    needsConfirm: !resolvedProduct || !quantity,
    candidates,
    usedFallback: true,
  };
}

/* -------------------------------- AI 解析 ------------------------------ */

async function callAi(text, ctx, cfg) {
  const sys = SYSTEM_PROMPT({ ...ctx, today: ctx.today });
  const url = `${String(cfg.base_url || '').replace(/\/+$/, '')}/chat/completions`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), num(cfg.timeout_ms, 20000));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.api_key}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: num(cfg.temperature, 0.1),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: text },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`AI 接口返回 ${res.status}：${t.slice(0, 200)}`);
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI 返回内容为空');
    const clean = String(content).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    return JSON.parse(clean);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 主入口。
 * @returns {Promise<{intent,payload,resolved,confidence,needsConfirm,candidates,usedFallback,error}>}
 */
export async function parseUtterance(text, ctx) {
  const cfg = ctx.aiConfig;
  const usable = cfg && cfg.enabled && cfg.api_key && cfg.api_key.trim().length > 0;

  if (usable) {
    try {
      const raw = await callAi(text, ctx, cfg);
      const intent = INTENTS.includes(raw.intent) ? raw.intent : 'UNKNOWN';
      // 实体落地：AI 给出的名称也要在台账里核实
      const product = raw.product ? matchEntity(raw.product, ctx.products) : null;
      const customer = raw.customer ? matchEntity(raw.customer, ctx.customers, 'name') : null;
      const resolvedProduct = product && product.score >= 0.55 ? product.item : null;
      const resolvedCustomer = customer && customer.score >= 0.55 ? customer.item : null;

      let quantity = raw.quantity != null ? Number(raw.quantity) : null;
      if (!Number.isFinite(quantity)) quantity = parseChineseNumber(String(text).replace(/\d{1,2}\s*[号日]/g, ' '));
      let dueDate = raw.due_date && /^\d{4}-\d{2}-\d{2}$/.test(raw.due_date) ? raw.due_date : parseChineseDate(text);

      let confidence = num(raw.confidence, 0.8);
      if (!resolvedProduct) confidence = Math.min(confidence, 0.5);
      if (!quantity) confidence = Math.min(confidence, 0.6);

      const candidates = [];
      if (!resolvedProduct) {
        candidates.push({ field: 'product', input: raw.product, options: ctx.products.slice(0, 8).map((p) => ({ id: p.id, name: p.name, sku: p.sku })) });
      }
      if (!resolvedCustomer && raw.customer) {
        candidates.push({ field: 'customer', input: raw.customer, options: ctx.customers.slice(0, 8).map((c) => ({ id: c.id, name: c.name, code: c.code })) });
      }

      return {
        intent,
        payload: {
          customer: raw.customer || null,
          product: raw.product || null,
          quantity,
          unit: raw.unit || '个',
          due_date: dueDate,
          note: raw.note || null,
        },
        resolved: { product: resolvedProduct, customer: resolvedCustomer },
        confidence,
        needsConfirm: !resolvedProduct || !quantity,
        candidates,
        usedFallback: false,
      };
    } catch (e) {
      if (!cfg.allow_fallback) {
        return {
          intent: 'UNKNOWN', payload: {}, resolved: {}, confidence: 0,
          needsConfirm: true, candidates: [], usedFallback: false,
          error: `AI 解析失败且未开启兜底：${e.message}`,
        };
      }
      const fb = fallbackParse(text, ctx);
      return { ...fb, error: `AI 解析失败，已走确定性兜底：${e.message}` };
    }
  }

  if (cfg && !cfg.allow_fallback) {
    return {
      intent: 'UNKNOWN', payload: {}, resolved: {}, confidence: 0,
      needsConfirm: true, candidates: [], usedFallback: false,
      error: '未配置 AI API Key，且未开启兜底解析器',
    };
  }
  return fallbackParse(text, ctx);
}

export { toDateStr };
