/**
 * 自然语言解析（v3.6 定性重构）。
 *
 * 解析策略（用户定案）：
 *  1. **AI 优先**：所有语句一律先交给 AI（租户/平台配置的 OpenAI 兼容接口）。
 *  2. **本地解析只兜底「订单、设备状态、库存」**：这几类句式固定、可用台账确定性匹配，
 *     即使 AI 挂了也不至于让车间停摆；其余意图（建档、改数、维修计划、闲聊）本地一律不接。
 *  3. **AI 不可用且本地接不住 → 明确报错**「AI大模型（人工智能）出错，请稍后再试或联系管理员」，
 *     绝不用低置信度的猜测去顶替——宁可让人补一句，也不往库里写脏数据。
 *
 * 提示词见 ./prompts.js（内置，含完整 JSON 契约与主数据注入）。
 */
import { arr, num, similarity, parseChineseNumber, parseChineseDate } from '../lib/util.js';
import { INTENTS, LOCAL_INTENTS, buildSystemPrompt } from './prompts.js';

/** AI 不可用时的统一文案（前端直接展示） */
export const AI_ERROR_MESSAGE = 'AI大模型（人工智能）出错，请稍后再试或联系管理员';

/* ------------------------------ 实体匹配 ------------------------------- */

const MATCH_THRESHOLD = 0.6;

function matchEntity(text, list, nameKey = 'name') {
  if (!text) return null;
  const t = String(text).trim();
  let best = null;
  for (const item of list) {
    const names = [item[nameKey], item.code, item.sku, ...arr(item.aliases)].filter(Boolean);
    for (const n of names) {
      if (!n) continue;
      const s = similarity(t, String(n));
      if (!best || s > best.score) best = { item, score: s, matched: String(n) };
    }
  }
  return best;
}

/** 命中阈值才算"认出来了"，否则一律当没认出来（反臆造） */
const solid = (m) => (m && m.score >= MATCH_THRESHOLD ? m : null);

/** 在整句中先定位客户（优先最长包含），再在剩余文本里匹配产品 */
function resolveByText(text, ctx) {
  let rest = String(text || '');
  let customer = null;
  for (const c of ctx.customers || []) {
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
  const product = matchEntity(rest.replace(/[的了和与及，,。]/g, ' ').trim(), ctx.products || []);
  return { customer: solid(customer), product: solid(product) };
}

/* --------------------- 日期/数量防误判（本次 bug 根因） -------------------- */

/**
 * 抹掉"规格类"数字，避免被当成订单数量：
 * 型号700 / 700吨 / 编号7 / 穴数4 / 7号机 …
 */
function stripSpecNumbers(s) {
  return String(s ?? '')
    .replace(/(?:型号|机型|规格|吨位|锁模力|编号|编码|穴数|腔数|出数|模次)\s*[:：=]?\s*\d+(?:\.\d+)?\s*[Tt吨]?/g, ' ')
    .replace(/\d+(?:\.\d+)?\s*吨/g, ' ')
    .replace(/\d{1,2}\s*号\s*[机台模线车]/g, ' ');
}

/** 抹掉"设备编号类"日期片段，避免 "7号机" 被当成 7 号 */
function stripSerialDates(s) {
  return String(s ?? '')
    .replace(/\d{1,2}\s*号\s*[机台模线车]/g, ' ')
    .replace(/(?:编号|编码|机台|模具)\s*[:：=]?\s*\d{1,2}\s*号/g, ' ');
}

/* ------------------------------ 本地解析 ------------------------------- */

/**
 * 本地确定性解析。只处理 LOCAL_INTENTS；接不住时返回 null，由调用方走 AI 报错。
 * @returns {object|null}
 */
export function fallbackParse(text, ctx) {
  const raw = String(text || '');

  // 建档 / 改数 / 维修计划：本地明确不接，必须走 AI
  if (/新增|添加|添加一|录入|建档|登记|建个|加一台|加个|把.{1,20}的?.{1,10}(?:改成|改为|调整为|调成|设为|修改成)|维修|保养|检修|报修/.test(raw)) {
    return null;
  }

  // 日期优先剥离，且先去掉设备编号干扰
  const dateStr = parseChineseDate(stripSerialDates(raw));
  const quantity = parseChineseNumber(stripSpecNumbers(raw));

  // 意图判定（仅限本地可接的意图）
  // 下单需要"订单类措辞"，或"做/生产 + 明确数量"——避免出现"生产情况怎么样"被判成下单
  const hasOrderWord = /下.{0,4}(订单|单)|下单|订货|要货|来一批|客户要/.test(raw);
  const hasMakeWord = /做|生产|安排/.test(raw);
  let intent = 'UNKNOWN';
  if (/出库|发货|发出了|送走|已发|发走|出库了/.test(raw)) intent = 'OUTBOUND';
  else if (/报工|完成|做完了|已生产|产出/.test(raw)) intent = 'PROGRESS';
  else if (/库存|还剩|还有多少|够不够/.test(raw)) intent = 'QUERY_STOCK';
  else if (/排产|计划|什么时候做|几号做|能否赶上/.test(raw)) intent = 'QUERY_SCHEDULE';
  else if (/故障|坏了|停机|漏料|异响|不能开机|修好了|状态|能用了/.test(raw)) intent = 'MACHINE_STATUS';
  else if (hasOrderWord || (hasMakeWord && quantity != null)) intent = 'CREATE_ORDER';

  if (!LOCAL_INTENTS.includes(intent)) return null;

  const { customer, product } = resolveByText(raw, ctx);

  const payload = {
    customer: customer?.matched || null,
    product: product?.matched || null,
    quantity: intent === 'CREATE_ORDER' || intent === 'OUTBOUND' || intent === 'PROGRESS' ? quantity : null,
    unit: '个',
    due_date: intent === 'CREATE_ORDER' ? dateStr : null,
    note: null,
  };

  const resolvedProduct = product?.item || null;
  const resolvedCustomer = customer?.item || null;

  let confidence = 0.4;
  if (resolvedProduct) confidence += 0.35;
  if (payload.quantity) confidence += 0.15;
  if (resolvedCustomer) confidence += 0.1;
  if (intent === 'CREATE_ORDER' && dateStr) confidence += 0.05;

  // 候选只在"订单相关"意图下给，避免拿无关列表糊弄用户
  const candidates = [];
  const needProduct = ['CREATE_ORDER', 'OUTBOUND', 'PROGRESS'].includes(intent);
  if (needProduct && !resolvedProduct) {
    candidates.push({
      field: 'product',
      input: payload.product,
      options: (ctx.products || []).slice(0, 8).map((p) => ({ id: p.id, name: p.name, sku: p.sku })),
    });
  }
  if ((intent === 'CREATE_ORDER' || intent === 'OUTBOUND') && !resolvedCustomer && (ctx.customers || []).length) {
    candidates.push({
      field: 'customer',
      input: payload.customer,
      options: (ctx.customers || []).slice(0, 8).map((c) => ({ id: c.id, name: c.name, code: c.code })),
    });
  }

  return {
    intent,
    payload,
    resolved: { product: resolvedProduct, customer: resolvedCustomer },
    confidence: Math.min(1, confidence),
    needsConfirm: needProduct ? (!resolvedProduct || !payload.quantity) : false,
    candidates,
    usedFallback: true,
    local: true,
  };
}

/* -------------------------------- AI 解析 ------------------------------ */

/**
 * 调一次 AI。带重试是因为实测 NVIDIA NIM 会偶发返回 502/瞬时不可用，
 * 一次抖动不该直接变成"AI 大模型出错"。只有可恢复的故障才重试：
 * 网络错误、超时、5xx；鉴权/模型不存在（4xx）立即失败，重试也没用。
 */
async function callAiOnce(text, ctx, cfg) {
  const sys = buildSystemPrompt(ctx);
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
        // 必须限制输出长度：语义解析的结果就几行 JSON，
        // 不加的话推理型模型会一路生成到自然停止，实测把 7 秒拖成 20~30 秒。
        // 但要留出富余：gpt-oss-20b 的思考过程也占用这个额度，多行建档容易超限被截断。
        // （注意：不要加 reasoning_effort=low——实测快一倍但正确率 36/36 掉到 35/36）
        max_tokens: 1600,
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
      const e = new Error(`AI 接口返回 ${res.status}：${t.slice(0, 200)}`);
      e.retryable = res.status >= 500;
      throw e;
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

async function callAi(text, ctx, cfg) {
  const attempts = 3;
  let last;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await callAiOnce(text, ctx, cfg);
    } catch (e) {
      last = e;
      const retryable = e.retryable !== false && e.name !== 'SyntaxError';
      if (i >= attempts || !retryable) throw e;
      // 退避：1s、2s
      await new Promise((r) => setTimeout(r, i * 1000));
    }
  }
  throw last;
}

/** AI 不可用 / 本地也接不住时的统一返回 */
function aiUnavailable(detail) {
  return {
    intent: 'UNKNOWN',
    payload: {},
    resolved: {},
    confidence: 0,
    needsConfirm: true,
    candidates: [],
    usedFallback: false,
    aiUnavailable: true,
    code: 'AI_UNAVAILABLE',
    error: AI_ERROR_MESSAGE,
    errorDetail: detail || null,
  };
}

/**
 * 把 AI 的原始 JSON 落成内部可用的结构：实体回台账核实、日期/数量防误判、置信度收敛。
 */
function normalizeAiResult(raw, text, ctx) {
  const intent = INTENTS.includes(raw.intent) ? raw.intent : 'UNKNOWN';
  const p = raw.payload && typeof raw.payload === 'object' ? raw.payload : {};

  // 实体落地：AI 给的名称也要在台账里核实（反臆造）
  const product = p.product ? matchEntity(p.product, ctx.products || []) : null;
  const customer = p.customer ? matchEntity(p.customer, ctx.customers || []) : null;
  const machine = p.machine ? matchEntity(p.machine, ctx.machines || [], 'name') : null;
  const mold = p.mold ? matchEntity(p.mold, ctx.molds || [], 'name') : null;
  const resolvedProduct = solid(product)?.item || null;
  const resolvedCustomer = solid(customer)?.item || null;
  const resolvedMachine = solid(machine)?.item || null;
  const resolvedMold = solid(mold)?.item || null;

  let confidence = num(raw.confidence, 0.8);
  confidence = Math.max(0, Math.min(1, confidence));

  // 订单类必须有实体与数量，否则降权并请求确认
  const orderish = ['CREATE_ORDER', 'OUTBOUND', 'PROGRESS'].includes(intent);
  let quantity = p.quantity != null ? Number(p.quantity) : null;
  if (!Number.isFinite(quantity)) quantity = null;
  if (orderish && !quantity) quantity = parseChineseNumber(stripSpecNumbers(String(text)));
  if (orderish && !resolvedProduct) confidence = Math.min(confidence, 0.45);
  if (orderish && !quantity) confidence = Math.min(confidence, 0.55);

  let dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(p.due_date || '')) ? p.due_date : null;
  if (!dueDate && intent === 'CREATE_ORDER') dueDate = parseChineseDate(stripSerialDates(String(text)));

  const candidates = [];
  if (orderish && !resolvedProduct) {
    candidates.push({
      field: 'product',
      input: p.product ?? null,
      options: (ctx.products || []).slice(0, 8).map((x) => ({ id: x.id, name: x.name, sku: x.sku })),
    });
  }
  if ((intent === 'CREATE_ORDER' || intent === 'OUTBOUND') && !resolvedCustomer && p.customer) {
    candidates.push({
      field: 'customer',
      input: p.customer ?? null,
      options: (ctx.customers || []).slice(0, 8).map((x) => ({ id: x.id, name: x.name, code: x.code })),
    });
  }

  return {
    intent,
    payload: {
      ...p,
      customer: p.customer ?? null,
      product: p.product ?? null,
      quantity: orderish ? quantity : (p.quantity ?? null),
      unit: p.unit || '个',
      due_date: dueDate || null,
      note: p.note || raw.note || null,
    },
    resolved: {
      product: resolvedProduct,
      customer: resolvedCustomer,
      machine: resolvedMachine,
      mold: resolvedMold,
    },
    confidence,
    needsConfirm: (orderish && (!resolvedProduct || !quantity)) || intent === 'UNKNOWN',
    candidates,
    usedFallback: false,
    aiUnavailable: false,
  };
}

/**
 * 主入口。
 * @returns {Promise<{intent,payload,resolved,confidence,needsConfirm,candidates,usedFallback,aiUnavailable,error,errorDetail}>}
 */
export async function parseUtterance(text, ctx) {
  const cfg = ctx.aiConfig;
  const usable = cfg && cfg.enabled && cfg.api_key && String(cfg.api_key).trim().length > 0;

  // 1) AI 优先
  if (usable) {
    try {
      const raw = await callAi(text, ctx, cfg);
      return normalizeAiResult(raw, text, ctx);
    } catch (e) {
      if (!cfg.allow_fallback) return aiUnavailable(`AI 解析失败：${e.message}`);
      const local = fallbackParse(text, ctx);
      if (!local) return aiUnavailable(`AI 解析失败，且该语句不在本地可解析范围内：${e.message}`);
      return {
        ...local,
        degraded: true,
        error: `AI 解析失败（${e.message}），已改用本地解析（仅支持订单/设备状态/库存）`,
      };
    }
  }

  // 2) 没配 AI：本地能接就接，接不住直接报 AI 不可用
  const local = fallbackParse(text, ctx);
  if (local) {
    return {
      ...local,
      degraded: true,
      error: '未配置 AI 接口，当前由本地解析处理（仅支持订单/设备状态/库存），其余语句需先配置 AI',
    };
  }
  return aiUnavailable('未配置 AI 接口，且该语句不在本地可解析范围内');
}

export { toDateStr } from '../lib/util.js';
