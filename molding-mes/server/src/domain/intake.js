/**
 * 基础数据智能录入：自然语言 / 表格附件 → 结构化草稿 → 人工确认后落库。
 *
 * 三条输入通道：
 *  1. 自然语言（AI 解析，无 Key 时退化为确定性解析）
 *  2. 表格附件（xlsx / csv，表头中文别名自动映射，必要时让 AI 帮忙认列）
 *  3. 自然语言改数（"把魔辣面筋的损耗率改成 4%" → 定位记录 + 生成补丁 + 预览）
 *
 * 规则与本项目的口径一致：AI 只负责"把话翻译成结构化数据"，
 * 落库前一律先出草稿给人确认；AI 不可用时不阻塞业务，走确定性解析。
 */
import { num, arr, nowStr } from '../lib/util.js';

/* ------------------------------ 字段元数据 ------------------------------ */

export const INTAKE_TARGETS = {
  customers: {
    zh: '客户', table: 'customers', key: 'code', json: ['aliases'], timestamps: { created: true, updated: false },
    fields: {
      code: { zh: '客户编码', aliases: ['编码', '客户编码', '编号', 'code'], required: true },
      name: { zh: '客户名称', aliases: ['名称', '客户名称', '客户', 'name'], required: true },
      aliases: { zh: '别名', aliases: ['别名', '简称', '口语叫法'], type: 'csv' },
      contact: { zh: '联系人', aliases: ['联系人', '电话', '联系方式'] },
    },
  },
  products: {
    zh: '产品', table: 'products', key: 'sku', json: ['aliases', 'label_skus', 'recipe', 'mold_codes'], timestamps: { created: false, updated: true },
    fields: {
      sku: { zh: 'SKU', aliases: ['sku', '编码', '产品编码', '货号', '编号'], required: true },
      name: { zh: '产品名称', aliases: ['名称', '产品名称', '品名', '产品'], required: true },
      aliases: { zh: '别名', aliases: ['别名', '俗称', '口语叫法'], type: 'csv' },
      unit: { zh: '单位', aliases: ['单位'], default: '个' },
      loss_rate: { zh: '损耗率(%)', aliases: ['损耗率', '损耗', '不良率'], type: 'num', default: 3 },
      mold_codes: { zh: '模具编号', aliases: ['模具', '模具编号', '可用模具'], type: 'csv' },
      recipe: { zh: '配方', aliases: ['配方', '克重', '用料', '原料配比'], type: 'recipe' },
      needs_label: { zh: '需贴标', aliases: ['贴标', '需贴标', '是否需要标签'], type: 'bool' },
      labels_per_unit: { zh: '单件标签数', aliases: ['单件标签', '每件标签数'], type: 'num', default: 1 },
      label_skus: { zh: '标签SKU', aliases: ['标签', '标签sku', '标签编号'], type: 'csv' },
      logo_version: { zh: '标志版本', aliases: ['标志', 'logo', '标志版本'] },
      finished_stock_qty: { zh: '成品库存', aliases: ['成品库存', '库存', '现有库存'], type: 'num', default: 0 },
    },
  },
  materials: {
    zh: '原料', table: 'materials', key: 'sku', json: [], timestamps: { created: false, updated: true },
    fields: {
      sku: { zh: '原料编码', aliases: ['编码', '原料编码', 'sku', '编号'], required: true },
      name: { zh: '原料名称', aliases: ['名称', '原料名称', '原料'], required: true },
      unit: { zh: '单位', aliases: ['单位'], default: 'kg' },
      stock_qty: { zh: '库存量', aliases: ['库存', '库存量', '现有库存'], type: 'num', default: 0 },
      safety_stock: { zh: '安全库存', aliases: ['安全库存', '最低库存'], type: 'num', default: 0 },
      lead_time_days: { zh: '采购提前期(天)', aliases: ['提前期', '采购周期', '到货天数'], type: 'num', default: 3 },
    },
  },
  labels: {
    zh: '标签', table: 'labels', key: 'sku', json: [], timestamps: { created: false, updated: true },
    fields: {
      sku: { zh: '标签编码', aliases: ['编码', '标签编码', 'sku', '编号'], required: true },
      name: { zh: '标签名称', aliases: ['名称', '标签名称', '标签'], required: true },
      category: { zh: '品类', aliases: ['品类', '类别', '分类'] },
      unit: { zh: '单位', aliases: ['单位'], default: '张' },
      stock_qty: { zh: '库存张数', aliases: ['库存', '库存量', '张数'], type: 'num', default: 0 },
      safety_stock: { zh: '安全库存', aliases: ['安全库存'], type: 'num', default: 0 },
      lead_time_days: { zh: '采购提前期(天)', aliases: ['提前期', '采购周期'], type: 'num', default: 5 },
    },
  },
  molds: {
    zh: '模具', table: 'molds', key: 'code', json: [], timestamps: { created: false, updated: true },
    fields: {
      code: { zh: '模具编号', aliases: ['编码', '模具编号', '编号', 'code'], required: true },
      name: { zh: '模具名称', aliases: ['名称', '模具名称', '模具'] },
      cavities: { zh: '穴数', aliases: ['穴数', '腔数', '出数'], type: 'num', default: 1 },
      cumulative_shots: { zh: '累计模次', aliases: ['累计模次', '已产模次', '累计'], type: 'num', default: 0 },
      maintenance_at_shots: { zh: '保养阈值模次', aliases: ['保养阈值', '保养模次'], type: 'num', default: 100000 },
      status: { zh: '状态', aliases: ['状态'], enum: ['AVAILABLE', 'MAINTENANCE', 'RETIRED'], default: 'AVAILABLE' },
    },
  },
  machines: {
    zh: '机台', table: 'machines', key: 'code', json: ['product_skus', 'mold_codes', 'mold_efficiencies'], timestamps: { created: false, updated: true },
    fields: {
      code: { zh: '机台编号', aliases: ['编码', '机台编号', '编号', 'code'], required: true },
      name: { zh: '机台名称', aliases: ['名称', '机台名称', '机台'] },
      model: { zh: '型号/吨位', aliases: ['型号', '吨位', '规格', '机型', '锁模力'] },
      status: { zh: '状态', aliases: ['状态'], enum: ['AVAILABLE', 'FAULT', 'MAINTENANCE'], default: 'AVAILABLE' },
      mold_change_minutes: { zh: '换模时长(分)', aliases: ['换模时长', '换模时间', '换模分钟'], type: 'num', default: 45 },
      units_per_hour: { zh: '默认效率(件/时)', aliases: ['效率', '件每小时', '产能', '每小时产量'], type: 'num', default: 0 },
      feeding_mode: { zh: '供料方式', aliases: ['供料方式', '供料'], enum: ['CENTRALIZED', 'HOPPER', 'MANUAL'], default: 'HOPPER' },
      supply_line_code: { zh: '供料线编号', aliases: ['供料线', '供料线编号'] },
      mixer_code: { zh: '混料机', aliases: ['混料机', '混料机编号'] },
      mold_codes: { zh: '可用模具', aliases: ['模具', '可用模具', '可装模具'], type: 'csv' },
      product_skus: { zh: '可做产品', aliases: ['产品', '可做产品', '可生产'], type: 'csv' },
    },
  },
  mixers: {
    zh: '混料机', table: 'mixers', key: 'code', json: [], timestamps: { created: false, updated: true },
    fields: {
      code: { zh: '混料机编号', aliases: ['编码', '编号', 'code'], required: true },
      name: { zh: '名称', aliases: ['名称', '混料机名称'] },
      capacity_kg: { zh: '容量(kg)', aliases: ['容量', '容量kg', '最大容量'], type: 'num', default: 0 },
      status: { zh: '状态', aliases: ['状态'], enum: ['AVAILABLE', 'FAULT', 'MAINTENANCE'], default: 'AVAILABLE' },
    },
  },
  supply_lines: {
    zh: '供料线', table: 'supply_lines', key: 'code', json: ['machine_codes'], timestamps: { created: false, updated: true },
    fields: {
      code: { zh: '供料线编号', aliases: ['编码', '供料线编号', '编号'], required: true },
      name: { zh: '名称', aliases: ['名称', '供料线名称'] },
      recipe_key: { zh: '当前配方键', aliases: ['配方', '配方键', '当前配方'] },
      mixer_code: { zh: '混料机', aliases: ['混料机', '混料机编号'] },
      machine_codes: { zh: '绑定机台', aliases: ['机台', '绑定机台', '供料机台'], type: 'csv' },
      min_changeover_minutes: { zh: '换料提前量(分)', aliases: ['换料提前量', '换料时长'], type: 'num', default: 60 },
      status: { zh: '状态', aliases: ['状态'], enum: ['AVAILABLE', 'FAULT', 'MAINTENANCE'], default: 'AVAILABLE' },
    },
  },
};

export const INTAKE_KEYS = Object.keys(INTAKE_TARGETS);

export const fieldDef = (target, field) => INTAKE_TARGETS[target]?.fields?.[field] || null;

/**
 * 预览表的列定义（中文表头 + 枚举可选值）。
 * 解析结果里的字段名是库表英文名（code/cavities…），直接给用户看不友好；
 * 这里把每个 target 的中文名和枚举项下发，前端照此渲染表头和下拉框。
 */
export function columnsOf(target) {
  const t = INTAKE_TARGETS[target];
  if (!t) return [];
  return Object.entries(t.fields).map(([field, f]) => ({
    field,
    zh: f.zh,
    type: f.enum ? 'enum' : (f.type || 'text'),
    enum: f.enum || null,
  }));
}

/* ------------------------------ 值归一化 ------------------------------ */

/** "PP:120,PE:30" → [{material_sku:'PP', grams:120}] */
export function parseRecipe(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.entries(v).map(([material_sku, grams]) => ({ material_sku, grams: num(grams, 0) }));
  const s = String(v ?? '').trim();
  if (!s) return [];
  const out = [];
  for (const seg of s.split(/[,，;；]/)) {
    const m = String(seg).match(/([^:：=]+)[:：=]\s*([\d.]+)\s*(g|克|kg|千克)?/);
    if (m) out.push({ material_sku: m[1].trim(), grams: num(m[2], 0) });
  }
  return out;
}

export function coerceValue(def, raw) {
  const type = def?.type;
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (type === 'num') {
    const n = Number(String(raw).replace(/[^\d.\-]/g, ''));
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === 'csv') {
    if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
    return String(raw).split(/[,，、;；|\/]/).map((x) => x.trim()).filter(Boolean);
  }
  if (type === 'recipe') return parseRecipe(raw);
  if (type === 'bool') {
    const s = String(raw).trim();
    if (['1', 'true', '是', '需要', '要', 'yes', 'y'].includes(s.toLowerCase())) return 1;
    if (['0', 'false', '否', '不需要', '不要', 'no', 'n'].includes(s.toLowerCase())) return 0;
    return undefined;
  }
  if (def?.enum) {
    const s = String(raw).trim().toUpperCase();
    if (def.enum.includes(s)) return s;
    // 中文状态兜底
    const zhMap = { 可用: 'AVAILABLE', 正常: 'AVAILABLE', 故障: 'FAULT', 维修: 'FAULT', 保养: 'MAINTENANCE', 维护: 'MAINTENANCE', 报废: 'RETIRED', 停用: 'RETIRED' };
    return zhMap[String(raw).trim()] || def.default || def.enum[0];
  }
  return String(raw).trim();
}

/** 表头中文 → 英文字段名 */
export function mapHeader(target, headers) {
  const t = INTAKE_TARGETS[target];
  if (!t) return [];
  const out = [];
  for (const h of headers) {
    const key = String(h ?? '').trim();
    if (!key) { out.push(null); continue; }
    let hit = null;
    for (const [f, def] of Object.entries(t.fields)) {
      if (f.toLowerCase() === key.toLowerCase()) { hit = f; break; }
      if (def.zh && def.zh === key) { hit = f; break; }
    }
    if (!hit) {
      for (const [f, def] of Object.entries(t.fields)) {
        if ((def.aliases || []).some((a) => key === a || key.includes(a) || a.includes(key))) { hit = f; break; }
      }
    }
    out.push(hit);
  }
  return out;
}

/** 把 {表头行, 数据行} 变成结构化 rows */
export function rowsFromTable(target, table) {
  const t = INTAKE_TARGETS[target];
  if (!t || !table.length) return { rows: [], warnings: [] };
  const fields = mapHeader(target, table[0]);
  const warnings = [];
  if (!fields.includes(t.key)) {
    warnings.push(`表头里没认出「${t.fields[t.key].zh}」（${t.key}）列，将无法定位已有记录，请确认列名`);
  }
  fields.forEach((f, i) => { if (!f && String(table[0][i] ?? '').trim()) warnings.push(`第 ${i + 1} 列「${table[0][i]}」未匹配到字段，已忽略`); });

  const rows = [];
  for (let r = 1; r < table.length; r += 1) {
    const line = table[r];
    if (!line || !line.some((c) => String(c ?? '').trim() !== '')) continue;
    const obj = {};
    fields.forEach((f, i) => {
      if (!f) return;
      const v = coerceValue(t.fields[f], line[i]);
      if (v !== undefined) obj[f] = v;
    });
    for (const [f, def] of Object.entries(t.fields)) {
      if (obj[f] === undefined && def.default !== undefined) obj[f] = def.default;
    }
    obj._row = r + 1;
    rows.push(obj);
  }
  return { rows, warnings };
}

/* --------------------------- 确定性文本解析 --------------------------- */

/**
 * 无 AI 时的解析：支持三种写法
 *  1. 从 Excel/表格直接粘贴（Tab 或逗号分隔，首行表头）
 *  2. 一行一条：「MLMJ-01 魔辣面筋 损耗3% 模具M-01」
 *  3. 键值： 「编码：MLMJ-01 名称：魔辣面筋」
 */
export function fallbackParseText(target, text) {
  const t = INTAKE_TARGETS[target];
  if (!t) return { rows: [], warnings: ['未知的基础数据类型'], used_fallback: true };
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], warnings: ['输入为空'], used_fallback: true };

  // 1) 表格粘贴
  const sample = lines[0];
  let sep = null;
  if (sample.includes('\t')) sep = '\t';
  else if (sample.includes('|')) sep = '|';
  else if ((sample.match(/,/g) || []).length >= 1 && lines.length > 1 && lines[1].includes(',')) sep = ',';
  else if ((sample.match(/，/g) || []).length >= 1 && lines.length > 1 && lines[1].includes('，')) sep = '，';

  if (sep && lines.length > 1) {
    const table = lines.map((l) => l.split(sep).map((c) => c.trim()));
    const { rows, warnings } = rowsFromTable(target, table);
    if (rows.length) {
      return { rows, warnings: [...warnings, '按表格格式解析（未使用 AI，字段由表头匹配）'], used_fallback: true };
    }
  }

  // 2) 键值：同一行内 键：值 / 键=值，或多个键则视为多条
  const kvRows = [];
  let cur = {};
  const flush = () => { if (Object.keys(cur).length) kvRows.push(cur); cur = {}; };
  const kvRe = /^([^:：=]{1,10})[:：=]\s*(.+)$/u;
  for (const line of lines) {
    const m = line.match(kvRe);
    if (m) {
      const f = mapHeader(target, [m[1]])[0];
      if (f) {
        // 同一字段再次出现 → 视为新记录
        if (cur[f] !== undefined) flush();
        const v = coerceValue(t.fields[f], m[2]);
        if (v !== undefined) cur[f] = v;
        continue;
      }
    }
    flush();
    // 3) 自由文本一行：整行作为名称，编码尝试从头部的连续英文数字串取
    const first = line.split(/[\s,，]+/)[0];
    const rest = line.slice(first.length).trim();
    const obj = {};
    if (/^[A-Za-z0-9_-]+$/.test(first)) {
      obj[t.key] = first;
      obj.name = String(rest || first).replace(/^[-—\s]*/, '') || first;
    } else {
      obj.name = line;
    }
    // 行内再抠 "损耗3%" "穴数4" 之类
    for (const [f, def] of Object.entries(t.fields)) {
      if (obj[f] !== undefined) continue;
      const alts = [def.zh, ...(def.aliases || [])].filter(Boolean);
      for (const a of alts) {
        const re = new RegExp(`${a}\\s*[:：=]?\\s*([\\d.]+)`);
        const mm = line.match(re);
        if (mm) { const v = coerceValue(def, mm[1]); if (v !== undefined) obj[f] = v; break; }
      }
    }
    kvRows.push(obj);
  }
  flush();

  const rows = kvRows.filter((r) => Object.keys(r).length).map((r, i) => {
    for (const [f, def] of Object.entries(t.fields)) {
      if (r[f] === undefined && def.default !== undefined) r[f] = def.default;
    }
    r._row = i + 1;
    return r;
  });
  return {
    rows,
    warnings: rows.length ? ['按关键词/分隔符解析（未使用 AI），请逐行核对后再导入'] : ['没能从文本里识别出记录，请换用「编码 名称」分行或用表格上传'],
    used_fallback: true,
  };
}

/* ------------------------------- AI 解析 ------------------------------ */

function promptFor(target) {
  const t = INTAKE_TARGETS[target];
  const lines = Object.entries(t.fields).map(([f, d]) => {
    const extra = d.type ? `（类型：${d.type}${d.type === 'csv' ? '，输出字符串数组' : ''}${d.type === 'recipe' ? '，输出 [{material_sku, grams}]' : ''}）` : '（字符串）';
    const en = d.enum ? `，取值只能是 ${d.enum.join(' / ')}` : '';
    return `- ${f}：${d.zh}${extra}${en}${d.required ? '【必填】' : ''}`;
  });
  return `你是注塑工厂基础数据录入助手。请把用户给的一段话或一段表格文本，解析成「${t.zh}」台账的结构化记录数组。

可用字段（只能用这些字段名，不要自造）：
${lines.join('\n')}

规则：
- 严格输出 JSON：{"rows":[ {...}, ... ]}，不要任何解释文字、不要 markdown 代码块。
- 用户口语里的别名（比如"魔辣面筋"）填到 name；若同时给了正式名称和俗称，正式名称填 name、俗称填进 aliases 数组。
- 数量字段只填数字，不要带单位；百分比只填数字（3% 填 3）。
- 用户没提到的字段不要填，也不要用经验值猜。
- 一句话里包含多条记录时，拆成多行输出。

示例（products）：
输入：新增两个产品，MLMJ-01 魔辣面筋（也有人叫麻辣面筋），用 M-01 模具，损耗 3%；还有 MLJG-02 魔辣鸡排，穴数 4
输出：{"rows":[{"sku":"MLMJ-01","name":"魔辣面筋","aliases":["麻辣面筋"],"mold_codes":["M-01"],"loss_rate":3},{"sku":"MLJG-02","name":"魔辣鸡排","cavities":4}]}`;
}

async function callAi(cfg, system, user) {
  const url = `${String(cfg.base_url || '').replace(/\/+$/, '')}/chat/completions`;
  const body = JSON.stringify({
    model: cfg.model,
    temperature: num(cfg.temperature, 0.1),
    // 限制输出长度：不设的话推理型模型会生成到自然停止，实测慢一个数量级。
    // 批量录入可能几十行，且思考过程同样占用额度，给到 2400。
    max_tokens: 2400,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });

  let last;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), num(cfg.timeout_ms, 20000));
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const e = new Error(`AI 接口返回 ${res.status}：${(await res.text()).slice(0, 200)}`);
        e.retryable = res.status >= 500;
        throw e;
      }
      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content;
      if (!content) throw new Error('AI 返回内容为空');
      const clean = String(content).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      clearTimeout(timer);
      return JSON.parse(clean);
    } catch (e) {
      clearTimeout(timer);
      last = e;
      const retryable = e.retryable !== false && e.name !== 'SyntaxError';
      if (attempt >= 3 || !retryable) throw e;
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
  throw last;
}

/** 自然语言 → 记录数组 */
export async function aiParseText(target, text, cfg) {
  const t = INTAKE_TARGETS[target];
  const sys = promptFor(target);
  const raw = await callAi(cfg, sys, String(text).slice(0, 4000));
  const list = Array.isArray(raw?.rows) ? raw.rows : (Array.isArray(raw) ? raw : []);
  const rows = [];
  const warnings = [];
  for (const [i, r] of list.entries()) {
    const obj = {};
    for (const [k, v] of Object.entries(r || {})) {
      if (!t.fields[k]) continue;
      const cv = coerceValue(t.fields[k], v);
      if (cv !== undefined) obj[k] = cv;
    }
    for (const [f, def] of Object.entries(t.fields)) {
      if (obj[f] === undefined && def.default !== undefined) obj[f] = def.default;
    }
    obj._row = i + 1;
    rows.push(obj);
  }
  if (!rows.length) warnings.push('AI 没返回可识别的记录，请换个说法或改用表格上传');
  return { rows, warnings, used_fallback: false };
}

/** 自然语言改数 → {target, key_field, key, patch} */
export async function aiParseModify(text, cfg, catalog) {
  const sys = `你是注塑工厂基础数据维护助手。用户会用口语提出「修改某个基础数据」的要求，请解析成结构化补丁。

可维护的数据类型：${INTAKE_KEYS.join(' / ')}
现有台账（用于定位，只能从中选，不能臆造）：
${catalog}

严格输出 JSON，不要解释文字、不要 markdown 代码块：
{
  "target": "数据类型，如 products",
  "key_field": "用于定位的字段名，通常是 sku 或 code",
  "key": "定位值（编码；若用户只给了名称，就填名称原文）",
  "patch": { "字段名": 新值 },
  "note": "一句话说明这次改动"
}

规则：
- patch 只放用户明确要求改的字段，不要顺手改别的。
- 找不到对应记录也要照实输出（key 填用户说的原文），由系统去提示"未匹配到"。
- 数量、百分比只填数字。

示例：
输入：把魔辣面筋的损耗率改成4%
输出：{"target":"products","key_field":"sku","key":"魔辣面筋","patch":{"loss_rate":4},"note":"损耗率 3 → 4"}`;
  const raw = await callAi(cfg, sys, String(text).slice(0, 2000));
  return raw;
}

/** 无 AI 时的改数解析：句式 "把 X 的 Y 改成 Z" */
export function fallbackParseModify(text) {
  const s = String(text || '').trim();
  const m = s.match(/把\s*(.+?)\s*的\s*(.+?)\s*(?:改成|改为|调整为|调成|设为|修改成)\s*(.+?)\s*$/);
  if (!m) return null;
  return { keyword: m[1].trim(), field_zh: m[2].trim(), value: m[3].trim(), used_fallback: true };
}

export { nowStr };
