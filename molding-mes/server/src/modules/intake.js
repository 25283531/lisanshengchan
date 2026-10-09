/**
 * 基础数据智能录入（v3.5）。
 *
 * 通道：
 *   POST /api/intake/text    自然语言 → 记录草稿
 *   POST /api/intake/file    Excel/CSV 附件 → 记录草稿
 *   POST /api/intake/commit  草稿确认后写入台账（按编码去重：有则更新、无则新建）
 *   POST /api/intake/modify  自然语言改数 → 变更预览
 *   POST /api/intake/apply   确认改数
 *
 * 原则：AI 只做"翻译"，落库前一律先给草稿；AI 不可用时走确定性解析，不阻塞建档。
 */
import multipart from '@fastify/multipart';
import ExcelJS from 'exceljs';

import { wrap, ok, fail, AppError } from '../lib/http.js';
import { nowStr, num, arr, j } from '../lib/util.js';
import { insertRow, updateRow, findAll, audit } from '../lib/repo.js';
import { requirePerm } from '../middleware.js';
import { resolveAiConfig } from '../domain/ai-config.js';
import { AI_ERROR_MESSAGE } from '../domain/nlp.js';
import {
  INTAKE_TARGETS, INTAKE_KEYS, rowsFromTable, fallbackParseText,
  aiParseText, aiParseModify, fallbackParseModify, coerceValue, mapHeader, columnsOf,
} from '../domain/intake.js';

/** 每个类型对应的中文名/别名（用于改数时的实体定位） */
const TARGET_ZH = {
  products: ['产品', '货品', '成品'],
  customers: ['客户'],
  materials: ['原料', '材料', '塑料'],
  labels: ['标签', '标贴'],
  molds: ['模具', '模'],
  machines: ['机台', '注塑机', '机器', '设备'],
  mixers: ['混料机', '拌料机'],
  supply_lines: ['供料线', '供料', '料线'],
};

export default async function registerIntakeRoutes(app, db, ctx) {
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 5 } });

  /** 可录入类型与字段定义：前端据此动态渲染预览表格 */
  app.get('/api/intake/targets', wrap(async (req) => {
    requirePerm(req, 'master.read');
    return ok({
      targets: INTAKE_KEYS.map((k) => ({
        key: k, zh: INTAKE_TARGETS[k].zh, keyField: INTAKE_TARGETS[k].key,
        fields: Object.entries(INTAKE_TARGETS[k].fields).map(([f, d]) => ({
          field: f, zh: d.zh, type: d.type || 'text', required: !!d.required,
          enum: d.enum || null, default: d.default ?? null,
        })),
      })),
    });
  }));

  /** 自然语言解析 */
  app.post('/api/intake/text', wrap(async (req) => {
    const user = requirePerm(req, 'master.write');
    const { target, text } = req.body || {};
    const out = await parseTextToDraft(db, user, target, String(text || '').trim());
    return ok(
      {
        draft_id: out.draft_id, target, target_zh: INTAKE_TARGETS[target].zh,
        rows: out.rows, warnings: out.warnings, used_fallback: out.used_fallback,
        columns: columnsOf(target),
      },
      `已解析出 ${out.rows.length} 条${INTAKE_TARGETS[target].zh}，请核对后导入`,
    );
  }));

  /** Excel / CSV 附件解析 */
  app.post('/api/intake/file', wrap(async (req) => {
    const user = requirePerm(req, 'master.write');
    const parts = req.parts();
    let target = null;
    let fileBuf = null;
    let fileName = null;

    for await (const part of parts) {
      if (part.type === 'file') {
        fileBuf = await part.toBuffer();
        fileName = part.filename || 'upload.xlsx';
      } else if (part.fieldname === 'target') {
        target = String(part.value || '');
      }
    }
    if (!target || !INTAKE_TARGETS[target]) return fail('请在表单字段 target 指定数据类型', 'BAD_TARGET', 400);
    if (!fileBuf || !fileBuf.length) return fail('未收到文件内容', 'NO_FILE', 400);

    const table = await readTable(fileBuf, fileName);
    if (!table.length) return fail('表格为空或无法解析（仅支持 .xlsx / .csv）', 'EMPTY_FILE', 400);

    const { rows, warnings } = rowsFromTable(target, table);
    const draftId = await saveDraft(db, {
      tenantId: user.tenant_id, userId: user.id, target, source: 'FILE',
      rawText: null, fileName, rows, usedFallback: false,
      message: warnings[0] || null,
    });
    return ok({
      draft_id: draftId, target, target_zh: INTAKE_TARGETS[target].zh, file_name: fileName,
      rows, warnings, columns: columnsOf(target),
      sheet_rows: table.length - 1,
    }, `已从 ${fileName} 解析出 ${rows.length} 条${INTAKE_TARGETS[target].zh}，请核对后导入`);
  }));

  /** 确认导入：按编码去重（有则更新、无则新建） */
  app.post('/api/intake/commit', wrap(async (req) => {
    const user = requirePerm(req, 'master.write');
    const b = req.body || {};
    const target = b.target;
    const cfg = INTAKE_TARGETS[target];
    if (!cfg) return fail(`未知类型：${target}`, 'BAD_TARGET', 400);
    const rows = arr(b.rows);
    if (!rows.length) return fail('没有可导入的记录', 'PARAM_MISSING', 400);
    if (rows.length > 2000) return fail('单次最多导入 2000 行', 'TOO_MANY', 400);

    const result = { created: 0, updated: 0, failed: [], created_ids: [] };
    await db.transaction(async () => {
      for (const [i, raw] of rows.entries()) {
        const row = { ...raw };
        delete row._row;
        const keyVal = row[cfg.key];
        if (keyVal === undefined || keyVal === null || String(keyVal).trim() === '') {
          result.failed.push({ index: i + 1, code: null, error: `缺少${cfg.fields[cfg.key].zh}（${cfg.key}）` });
          continue;
        }
        try {
          const exist = await db.get(`SELECT id FROM \`${cfg.table}\` WHERE tenant_id = ? AND \`${cfg.key}\` = ?`,
            [user.tenant_id, String(keyVal).trim()]);
          if (exist) {
            const patch = { ...row };
            if (cfg.timestamps?.updated) patch.updated_at = nowStr();
            await updateRow(db, cfg.table, exist.id, patch, { tenantId: user.tenant_id, jsonFields: cfg.json });
            result.updated += 1;
          } else {
            const data = { ...row };
            if (cfg.timestamps?.created) data.created_at = data.created_at || nowStr();
            if (cfg.timestamps?.updated) data.updated_at = nowStr();
            const id = await insertRow(db, cfg.table, data, { tenantId: user.tenant_id, jsonFields: cfg.json });
            result.created += 1;
            result.created_ids.push(id);
          }
        } catch (e) {
          result.failed.push({ index: i + 1, code: String(keyVal), error: e.message });
        }
      }
    });

    await audit(db, {
      tenantId: user.tenant_id, userId: user.id, action: 'intake.commit',
      detail: { target, created: result.created, updated: result.updated, failed: result.failed.length },
    });
    if (b.draftId) {
      await db.run('UPDATE intake_drafts SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
        ['COMMITTED', nowStr(), Number(b.draftId), user.tenant_id]);
    }
    const failedNote = result.failed.length ? `，${result.failed.length} 行失败` : '';
    return ok(result, `已导入：新增 ${result.created} 条、更新 ${result.updated} 条${failedNote}`);
  }));

  /** 最近草稿（便于断点续做） */
  app.get('/api/intake/drafts', wrap(async (req) => {
    const user = requirePerm(req, 'master.read');
    const rows = await db.query(
      'SELECT id, target, source, file_name, row_count, status, used_fallback, message, created_at FROM intake_drafts WHERE tenant_id = ? ORDER BY id DESC LIMIT 20',
      [user.tenant_id],
    );
    return ok(rows);
  }));

  app.get('/api/intake/drafts/:id', wrap(async (req) => {
    const user = requirePerm(req, 'master.read');
    const row = await db.get('SELECT * FROM intake_drafts WHERE id = ? AND tenant_id = ?', [Number(req.params.id), user.tenant_id]);
    if (!row) return fail('草稿不存在', 'NOT_FOUND', 404);
    return ok({ ...row, rows: j(row.rows, []) });
  }));

  /* ------------------------ 自然语言改数 ------------------------ */

  app.post('/api/intake/modify', wrap(async (req) => {
    const user = requirePerm(req, 'master.write');
    const text = String((req.body || {}).text || '').trim();
    if (!text) return fail('请输入内容', 'PARAM_MISSING', 400);
    const r = await previewModify(db, user, text);
    return ok(r, r.message || null);
  }));


  /** 确认改数 */
  app.post('/api/intake/apply', wrap(async (req) => {
    const user = requirePerm(req, 'master.write');
    const b = req.body || {};
    const target = b.target;
    const cfg = INTAKE_TARGETS[target];
    if (!cfg) return fail(`未知类型：${target}`, 'BAD_TARGET', 400);
    const patch = b.patch && typeof b.patch === 'object' ? b.patch : null;
    if (!patch || !Object.keys(patch).length) return fail('没有要修改的字段', 'PARAM_MISSING', 400);

    const record = b.recordId
      ? await db.get(`SELECT * FROM \`${cfg.table}\` WHERE id = ? AND tenant_id = ?`, [Number(b.recordId), user.tenant_id])
      : await locate(db, user.tenant_id, target, String(b.key ?? ''));
    if (!record) return fail('未找到对应记录', 'NOT_FOUND', 404);

    const safe = {};
    for (const [f, v] of Object.entries(patch)) {
      if (!cfg.fields[f]) continue;
      safe[f] = v;
    }
    if (cfg.timestamps?.updated) safe.updated_at = nowStr();
    await updateRow(db, cfg.table, record.id, safe, { tenantId: user.tenant_id, jsonFields: cfg.json });
    await audit(db, {
      tenantId: user.tenant_id, userId: user.id, action: 'intake.apply',
      detail: { target, id: record.id, [cfg.key]: record[cfg.key], patch: safe, raw: b.text || null },
    });
    return ok({ id: record.id, [cfg.key]: record[cfg.key], patch: safe }, `${cfg.zh}「${record.name || record[cfg.key]}」已更新`);
  }));
}

/* ------------------------------- 工具函数 ------------------------------ */

/**
 * 自然语言 → 记录草稿（路由与自然语言助手共用）。
 * AI 优先；AI 不可用时退回确定性解析，并在 warnings 里写明。
 */
export async function parseTextToDraft(db, user, target, raw, opts = {}) {
  if (!INTAKE_TARGETS[target]) throw new AppError(`未知类型：${target}`, 400, 'BAD_TARGET');
  if (!raw) throw new AppError('请输入内容', 400, 'PARAM_MISSING');

  const eff = await resolveAiConfig(db, user.tenant_id);
  const usable = eff.config.enabled && eff.config.api_key;
  // 自然语言助手通道：建档属于"本地解析不了"的意图，AI 不可用时直接报错而非猜测
  if (!usable && opts.aiRequired) throw new AppError(AI_ERROR_MESSAGE, 503, 'AI_UNAVAILABLE');

  let out;
  if (usable) {
    try {
      out = await aiParseText(target, raw, eff.config);
    } catch (e) {
      if (opts.aiRequired) throw new AppError(AI_ERROR_MESSAGE, 503, 'AI_UNAVAILABLE');
      const fb = fallbackParseText(target, raw);
      out = { ...fb, warnings: [...fb.warnings, `AI 解析失败，已改用确定性解析：${e.message}`] };
    }
  } else {
    out = fallbackParseText(target, raw);
  }

  const draftId = await saveDraft(db, {
    tenantId: user.tenant_id, userId: user.id, target, source: 'TEXT',
    rawText: raw, rows: out.rows, usedFallback: out.used_fallback || !usable,
    message: out.warnings?.[0] || null,
  });
  return {
    draft_id: draftId, target, rows: out.rows, warnings: out.warnings || [],
    used_fallback: !usable || !!out.used_fallback,
  };
}

/**
 * 自然语言改数 → 变更预览（不落库；路由与自然语言助手共用）。
 * @returns {{ok:boolean,...}} ok=false 时 message 说明为什么定位不到
 */
export async function previewModify(db, user, text, opts = {}) {
  const tid = user.tenant_id;
  const eff = await resolveAiConfig(db, tid);
  const usable = eff.config.enabled && eff.config.api_key;
  if (!usable && opts.aiRequired) throw new AppError(AI_ERROR_MESSAGE, 503, 'AI_UNAVAILABLE');

  let target = null;
  let keyField = null;
  let key = null;
  let patch = null;
  let note = null;
  let usedFallback = false;

  if (usable) {
    try {
      const parsed = await aiParseModify(text, eff.config, await catalogFor(db, tid));
      target = INTAKE_TARGETS[parsed?.target] ? parsed.target : null;
      keyField = parsed?.key_field || null;
      key = parsed?.key ?? null;
      patch = parsed?.patch && typeof parsed.patch === 'object' ? parsed.patch : null;
      note = parsed?.note || null;
    } catch (e) {
      if (opts.aiRequired) throw new AppError(AI_ERROR_MESSAGE, 503, 'AI_UNAVAILABLE');
      usedFallback = true;
      note = `AI 解析失败，已改用句式解析：${e.message}`;
    }
  } else {
    usedFallback = true;
  }

  if (!target || !patch) {
    const fb = fallbackParseModify(text);
    usedFallback = true;
    if (!fb) {
      return { ok: false, message: '没能识别出要改哪条数据，请换成「把 魔辣面筋 的 损耗率 改成 4%」这样的说法', ai_required: !usable };
    }
    // 先按话里的类型词判断（"产品""模具"…），判断不出就拿着关键词去各台账里找
    target = guessTarget(text) || (await guessTargetByKey(db, tid, fb.keyword));
    if (!target) return { ok: false, message: `没能判断「${fb.keyword}」属于哪一类基础数据，请说明是产品、模具还是机台` };
    key = fb.keyword;
    keyField = INTAKE_TARGETS[target].key;
    const field = matchFieldZh(target, fb.field_zh);
    if (!field) return { ok: false, message: `没能识别出字段「${fb.field_zh}」` };
    const v = coerceValue(INTAKE_TARGETS[target].fields[field], fb.value);
    if (v === undefined) return { ok: false, message: `字段「${INTAKE_TARGETS[target].fields[field].zh}」的取值「${fb.value}」无法识别` };
    patch = { [field]: v };
    note = note || `按句式解析：${fb.keyword} 的 ${INTAKE_TARGETS[target].fields[field].zh} → ${fb.value}`;
  }

  // 定位记录：先按编码，再按名称/别名
  const cfg = INTAKE_TARGETS[target];
  const hit = await locate(db, tid, target, String(key ?? ''));
  if (!hit) {
    return {
      ok: false, target, key: String(key ?? ''), patch, note,
      message: `没找到${cfg.zh}「${key}」，请确认名称或编码是否正确（已录入的${cfg.zh}共 ${await countOf(db, tid, target)} 条）`,
    };
  }

  // 只保留真正有变化的字段，给出变更前 → 变更后
  const changes = [];
  for (const [f, v] of Object.entries(patch)) {
    if (!cfg.fields[f]) continue;
    const before = hit[f];
    if (JSON.stringify(before ?? null) === JSON.stringify(v ?? null)) continue;
    changes.push({ field: f, zh: cfg.fields[f].zh, before, after: v });
  }
  if (!changes.length) {
    return { ok: false, target, record: hit, message: '识别到的字段值与现有一致，无需修改' };
  }

  const draftId = await saveDraft(db, {
    tenantId: tid, userId: user.id, target, source: 'MODIFY',
    rawText: text, rows: [{ [keyField || cfg.key]: hit[cfg.key], patch: Object.fromEntries(changes.map((c) => [c.field, c.after])) }],
    usedFallback, message: note || null,
  });
  return {
    ok: true, draft_id: draftId, target, target_zh: cfg.zh,
    key_field: cfg.key, key: hit[cfg.key], record_id: hit.id,
    record_name: hit.name || hit[cfg.key], changes, note,
    used_fallback: usedFallback,
    message: `已定位到${cfg.zh}「${hit.name || hit[cfg.key]}」，共 ${changes.length} 处改动，确认后生效`,
  };
}

async function saveDraft(db, { tenantId, userId, target, source, rawText, fileName, rows, usedFallback, message }) {
  const cleanRows = (rows || []).map((r) => {
    const c = { ...r };
    delete c._row;
    return c;
  });
  // 列名一律加反引号：rows 在 MySQL 8 里是保留字（窗口函数），不加引号会语法错误
  const r = await db.run(
    `INSERT INTO intake_drafts (\`tenant_id\`, \`target\`, \`source\`, \`raw_text\`, \`file_name\`, \`rows\`, \`row_count\`, \`status\`, \`used_fallback\`, \`message\`, \`created_by\`, \`created_at\`, \`updated_at\`)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [tenantId, target, source, rawText ? rawText.slice(0, 2000) : null, fileName || null,
      JSON.stringify(cleanRows), cleanRows.length, 'DRAFT', usedFallback ? 1 : 0,
      message ? String(message).slice(0, 255) : null, userId, nowStr(), nowStr()],
  );
  return Number(r.insertId);
}

/** xlsx → 二维数组（首行表头）；csv 也支持 */
async function readTable(buf, fileName) {
  const isCsv = /\.csv$/i.test(fileName || '');
  if (isCsv) {
    const text = buf.toString('utf8');
    return text.split(/\r?\n/).filter((l) => l.trim() !== '')
      .map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '')));
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const out = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    out.push(row.values.slice(1).map((v) => (v && typeof v === 'object' && v.text !== undefined ? v.text : v)));
  });
  return out.map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c).trim())));
}

/** 改数时给 AI 的台账摘要（只给编码与名称，控制 token） */
async function catalogFor(db, tenantId) {
  const parts = [];
  for (const key of INTAKE_KEYS) {
    const cfg = INTAKE_TARGETS[key];
    const rows = await findAll(db, cfg.table, { tenantId, jsonFields: cfg.json, orderBy: cfg.key });
    if (!rows.length) continue;
    parts.push(`${cfg.zh}（${key}）：${rows.slice(0, 200).map((r) => `${r[cfg.key]}=${r.name || ''}`).join('｜')}`);
  }
  return parts.join('\n') || '（台账为空）';
}

function guessTarget(text) {
  const s = String(text || '');
  let best = null;
  for (const [key, zhs] of Object.entries(TARGET_ZH)) {
    for (const zh of zhs) {
      if (s.includes(zh)) return key;
    }
  }
  return best;
}

function matchFieldZh(target, zh) {
  const cfg = INTAKE_TARGETS[target];
  if (!cfg) return null;
  const s = String(zh || '').trim();
  for (const [f, def] of Object.entries(cfg.fields)) {
    if (def.zh === s || f === s) return f;
  }
  for (const [f, def] of Object.entries(cfg.fields)) {
    if ((def.aliases || []).some((a) => s.includes(a) || a.includes(s))) return f;
  }
  return null;
}

/** 按编码或名称定位一条基础数据 */
async function locate(db, tenantId, target, key) {
  const cfg = INTAKE_TARGETS[target];
  const k = String(key || '').trim();
  if (!k) return null;
  const byCode = await db.get(`SELECT * FROM \`${cfg.table}\` WHERE tenant_id = ? AND \`${cfg.key}\` = ?`, [tenantId, k]);
  if (byCode) return byCode;
  const rows = await findAll(db, cfg.table, { tenantId, jsonFields: cfg.json, orderBy: cfg.key });
  const lower = k.toLowerCase();
  return rows.find((r) => String(r.name || '').toLowerCase() === lower)
    || rows.find((r) => String(r.name || '').toLowerCase().includes(lower))
    || rows.find((r) => (r.aliases || []).some?.((a) => String(a).toLowerCase() === lower || String(a).includes(k)))
    || null;
}

/** 拿着关键词（编码或名称）去各台账里找，判断它属于哪一类基础数据 */
async function guessTargetByKey(db, tenantId, keyword) {
  const k = String(keyword || '').trim();
  if (!k) return null;
  for (const key of INTAKE_KEYS) {
    const hit = await locate(db, tenantId, key, k);
    if (hit) return key;
  }
  return null;
}

async function countOf(db, tenantId, target) {
  const cfg = INTAKE_TARGETS[target];
  const r = await db.get(`SELECT COUNT(*) AS c FROM \`${cfg.table}\` WHERE tenant_id = ?`, [tenantId]);
  return Number(r?.c || 0);
}
