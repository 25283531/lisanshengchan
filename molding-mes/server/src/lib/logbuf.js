/**
 * 服务端日志环形缓冲。
 *
 * 目的：运维不必 SSH 到服务器上 `docker logs`——平台后台「运行日志」页直接看最近几百条。
 * 只保留内存里的最后 N 条，落盘的仍是 docker 的 json-file（已在 compose 里限 10m × 3）。
 *
 * 用法：入口用 pino 的 stream 把每行日志同时写 stdout 与本缓冲（见 src/index.js）。
 */

const MAX_LINES = 500;

/** pino 的数字级别 → 显示名 */
const LEVELS = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };

const buf = [];

export function pushLog(line) {
  const s = String(line ?? '').trim();
  if (!s) return;
  let rec;
  try {
    const j = JSON.parse(s);
    rec = {
      time: j.time ?? null,
      level: LEVELS[j.level] || String(j.level ?? ''),
      msg: j.msg ?? '',
      req_id: j.reqId || null,
      status: j.res?.statusCode ?? null,
      raw: s,
    };
  } catch {
    // 非 JSON（比如直接 console 输出）：原样保留，级别标 info
    rec = { time: Date.now(), level: 'info', msg: s, req_id: null, status: null, raw: s };
  }
  buf.push(rec);
  if (buf.length > MAX_LINES) buf.shift();
  return rec;
}

/** 取最近的日志：新的在前。level 传 'warn' 表示只看 warn 及以上。 */
export function readLogs({ limit = 200, level = null } = {}) {
  const order = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
  const min = level ? (order[level] ?? 0) : 0;
  const picked = min ? buf.filter((r) => (order[r.level] ?? 0) >= min) : buf;
  return picked.slice(-Math.min(limit, MAX_LINES)).reverse();
}

export const logStats = () => ({ kept: buf.length, max: MAX_LINES });
