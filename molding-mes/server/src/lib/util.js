/** 通用工具：JSON 归一、编号生成、时间运算 */

/** JSON 列归一。mysql 返回对象、sqlite 返回字符串，统一为对象/数组 */
export function j(v, fallback = null) {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

export const arr = (v) => {
  const p = j(v, []);
  return Array.isArray(p) ? p : [];
};

export const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const p2 = (n) => String(n).padStart(2, '0');

/** 本地时间 -> 'YYYY-MM-DD HH:MM:SS' */
export function toStr(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return null;
  return `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}:${p2(t.getSeconds())}`;
}

/** 'YYYY-MM-DD HH:MM:SS' / 'YYYY-MM-DD' -> Date（按本地时区解析） */
export function toDate(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  const t = new Date(String(s).replace(' ', 'T'));
  return Number.isNaN(t.getTime()) ? null : t;
}

export const nowStr = () => toStr(new Date());
export const todayStr = () => toStr(new Date()).slice(0, 10);

export function addMinutes(s, minutes) {
  const d = toDate(s) || new Date();
  return toStr(new Date(d.getTime() + minutes * 60000));
}

export function minutesBetween(a, b) {
  const da = toDate(a);
  const db = toDate(b);
  if (!da || !db) return 0;
  return (db.getTime() - da.getTime()) / 60000;
}

/** 日期字符串 YYYY-MM-DD */
export const toDateStr = (d) => toStr(d).slice(0, 10);

let seq = 0;
/** 生成业务编号：前缀 + 日期 + 3 位流水 */
export function bizCode(prefix, date = new Date()) {
  seq = (seq + 1) % 1000;
  const d = date instanceof Date ? date : new Date();
  return `${prefix}-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${String(seq).padStart(3, '0')}`;
}

/** 简易中文数字/单位解析：2万 / 2万个 / 20000 / 2.5万 */
export function parseChineseNumber(text) {
  if (typeof text === 'number') return text;
  const s = String(text ?? '').replace(/[,，\s]/g, '');
  let m = s.match(/(\d+(?:\.\d+)?)\s*万/);
  if (m) return Math.round(parseFloat(m[1]) * 10000);
  m = s.match(/(\d+(?:\.\d+)?)\s*千/);
  if (m) return Math.round(parseFloat(m[1]) * 1000);
  m = s.match(/(\d+(?:\.\d+)?)\s*[kK]/);
  if (m) return Math.round(parseFloat(m[1]) * 1000);
  m = s.match(/\d+(?:\.\d+)?/);
  return m ? Math.round(parseFloat(m[0])) : null;
}

/** 中文日期解析：13号 / 10月13号 / 10-13 / 2026-10-13 / 明天 / 后天 */
export function parseChineseDate(text, base = new Date()) {
  const s = String(text ?? '');
  const y = base.getFullYear();
  const mo = base.getMonth() + 1;

  if (/今天/.test(s)) return toDateStr(base);
  if (/明天/.test(s)) return toDateStr(new Date(base.getTime() + 86400000));
  if (/后天/.test(s)) return toDateStr(new Date(base.getTime() + 2 * 86400000));
  if (/大后天/.test(s)) return toDateStr(new Date(base.getTime() + 3 * 86400000));

  let m = s.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (m) return `${m[1]}-${p2(+m[2])}-${p2(+m[3])}`;

  m = s.match(/(\d{1,2})[-/.月](\d{1,2})/);
  if (m) return `${y}-${p2(+m[1])}-${p2(+m[2])}`;

  m = s.match(/(\d{1,2})\s*[号日]/);
  if (m) {
    let day = +m[1];
    let month = mo;
    // 「13号」若早于今天，理解为下月
    if (day < base.getDate()) month = mo === 12 ? 1 : mo + 1;
    const yy = month < mo ? y + 1 : y;
    return `${yy}-${p2(month)}-${p2(day)}`;
  }
  return null;
}

/** 简单相似度：用于产品/客户名模糊匹配（0~1） */
export function similarity(a, b) {
  const s1 = String(a ?? '');
  const s2 = String(b ?? '');
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  if (s1.includes(s2) || s2.includes(s1)) return 0.9;
  const set1 = new Set(s1.split(''));
  const set2 = new Set(s2.split(''));
  let inter = 0;
  for (const c of set1) if (set2.has(c)) inter += 1;
  return inter / Math.max(set1.size, set2.size);
}

export const round = (v, digits = 3) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
