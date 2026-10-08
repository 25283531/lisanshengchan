/**
 * AI 接口配置的生效规则（单一事实源）。
 *
 * 三级优先级：
 *   1. 公司自定义（ai_configs）—— 只在平台允许覆盖时才生效，且只影响本公司；
 *   2. 平台统一配置（ai_global_configs）—— 系统管理员维护，公司未自定义时生效；
 *   3. 服务器环境变量（.env）—— 库里什么都没配时的兜底，保证服务永远可用。
 *
 * 这样拆的原因：AI 的 BaseURL / Key / 模型属于平台运维范畴，不该让每家公司各自去申请；
 * 但也确实存在「某公司要接自己买的模型」的场景，所以留了公司级覆盖口，并且平台可一键锁死。
 */
import config from '../config.js';
import { num, nowStr } from '../lib/util.js';

export function maskKey(k) {
  if (!k) return null;
  const s = String(k);
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

export const readGlobalAi = (db) => db.get('SELECT * FROM ai_global_configs ORDER BY id LIMIT 1');
export const readTenantAi = (db, tenantId) => db.get('SELECT * FROM ai_configs WHERE tenant_id = ?', [tenantId]);

/** 环境变量兜底配置（未落库时使用） */
export function envAiConfig() {
  return {
    provider: 'OPENAI_COMPAT',
    base_url: config.ai.baseUrl,
    api_key: config.ai.apiKey || null,
    model: config.ai.model,
    temperature: config.ai.temperature,
    timeout_ms: config.ai.timeoutMs,
    enabled: 1,
    allow_fallback: config.ai.allowFallback ? 1 : 0,
  };
}

function normalize(row) {
  if (!row) return null;
  return {
    provider: row.provider || 'OPENAI_COMPAT',
    base_url: row.base_url || 'https://api.deepseek.com/v1',
    api_key: row.api_key || null,
    model: row.model || 'deepseek-chat',
    temperature: num(row.temperature, 0.1),
    timeout_ms: num(row.timeout_ms, 20000),
    enabled: row.enabled === undefined ? 1 : num(row.enabled, 0),
    allow_fallback: row.allow_fallback === undefined ? 1 : num(row.allow_fallback, 0),
  };
}

/** 对外展示用的脱敏视图 */
export function publicView(row) {
  const n = normalize(row) || {};
  return {
    provider: n.provider,
    base_url: n.base_url,
    model: n.model,
    temperature: n.temperature,
    timeout_ms: n.timeout_ms,
    enabled: !!n.enabled,
    allow_fallback: !!n.allow_fallback,
    api_key_set: !!n.api_key,
    api_key_mask: maskKey(n.api_key),
  };
}

/**
 * 启动时确保平台配置有一行记录（用 .env 兜底值初始化），
 * 这样系统管理员一进后台就能看到并直接改，而不是面对一张空表。
 */
export async function ensureGlobalAi(db) {
  const g = await readGlobalAi(db);
  if (g) return g;
  const e = envAiConfig();
  await db.run(
    `INSERT INTO ai_global_configs (provider, base_url, api_key, model, temperature, timeout_ms,
       enabled, allow_fallback, allow_tenant_override, updated_by, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [e.provider, e.base_url, e.api_key, e.model, e.temperature, e.timeout_ms,
      e.enabled, e.allow_fallback, 1, '系统初始化', nowStr()],
  );
  return readGlobalAi(db);
}

/**
 * 解析某公司实际生效的配置。
 * @returns {{config:object, source:'tenant'|'platform'|'env', tenant_override:boolean,
 *            allow_tenant_override:boolean, source_zh:string}}
 */
export async function resolveAiConfig(db, tenantId) {
  const g = await readGlobalAi(db);
  const t = await readTenantAi(db, tenantId);
  const allowOverride = g ? !!num(g.allow_tenant_override, 1) : true;

  // 公司自定义要生效：填了 Key、开关打开、平台允许覆盖
  const tenantUsable = !!(t && String(t.api_key || '').trim() && num(t.enabled, 0) && allowOverride);

  if (tenantUsable) {
    return {
      config: normalize(t),
      source: 'tenant',
      tenant_override: true,
      allow_tenant_override: allowOverride,
      source_zh: '本公司自定义配置',
    };
  }
  if (g) {
    return {
      config: normalize(g),
      source: 'platform',
      tenant_override: !!(t && String(t.api_key || '').trim()),
      allow_tenant_override: allowOverride,
      source_zh: '平台统一配置（系统管理员维护）',
    };
  }
  return {
    config: envAiConfig(),
    source: 'env',
    tenant_override: !!(t && String(t.api_key || '').trim()),
    allow_tenant_override: allowOverride,
    source_zh: '服务器环境变量（.env）',
  };
}

/**
 * 连通性测试：真发一条最小请求，结果写回 last_test_ok / last_test_msg。
 * @param {object} cfg 已经 normalize 过的配置
 * @param {function} onResult (ok, msg) => Promise
 */
export async function testAiConnection(cfg, onResult) {
  const n = normalize(cfg);
  if (!n.api_key) {
    const msg = '未配置 API Key，自然语言将走确定性兜底解析器（无需联网）';
    if (onResult) await onResult(false, msg);
    return { ok: false, message: msg, mode: 'fallback' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), num(n.timeout_ms, 20000));
  const t0 = Date.now();
  try {
    const res = await fetch(`${String(n.base_url).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${n.api_key}` },
      body: JSON.stringify({
        model: n.model,
        temperature: 0,
        // 连通性探测只要一句确认，但也得给够：gpt-oss-20b 是推理模型，
        // 会先消耗 ~65 个思考 token 才吐出正文，实测 32 会被思考占满导致正文为空。
        max_tokens: 256,
        messages: [
          { role: 'system', content: '你是一个连通性测试助手。' },
          { role: 'user', content: '输出 JSON：{"ok":true}' },
        ],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    const j = await res.json().catch(() => ({}));
    const content = j?.choices?.[0]?.message?.content || '';
    const msg = `连通正常，耗时 ${Date.now() - t0}ms，模型 ${n.model}`;
    if (onResult) await onResult(true, msg);
    return { ok: true, message: msg, sample: String(content).slice(0, 120) };
  } catch (e) {
    clearTimeout(timer);
    const msg = `连接失败：${e.message}`.slice(0, 250);
    if (onResult) await onResult(false, msg);
    return { ok: false, message: msg, mode: 'ai' };
  }
}
