/**
 * 全局配置。
 * 不引入 dotenv 依赖：自行解析 .env 文件（存在即读取，不存在用默认值）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '..');

function loadDotEnv() {
  const p = resolve(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const rawLine of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 8080),
  host: process.env.HOST || '0.0.0.0',

  /** JWT 签名密钥，生产环境必须修改 */
  jwtSecret: process.env.JWT_SECRET || 'molding-mes-dev-secret-change-me',
  /** 令牌有效期（小时）。安卓端建议 720h=30天，避免频繁登录 */
  tokenTtlHours: num(process.env.TOKEN_TTL_HOURS, 720),

  db: {
    /**
     * dialect: sqlite | mysql
     * sqlite 使用 Node 内置 node:sqlite，零依赖，用于本地演示与轻量部署；
     * mysql 用于生产，需配合 docker-compose.yml 或外部实例。
     */
    dialect: (process.env.DB_DIALECT || 'sqlite').toLowerCase(),
    file: process.env.DB_FILE || resolve(ROOT, 'data', 'mes.db'),
    host: process.env.DB_HOST || '127.0.0.1',
    port: num(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'mes',
    password: process.env.DB_PASSWORD || 'mes123456',
    database: process.env.DB_NAME || 'molding_mes',
    connectionLimit: num(process.env.DB_POOL, 10),
  },

  /** 平台超管口令：用于创建公司、调整授权。生产环境务必修改 */
  platformToken: process.env.PLATFORM_TOKEN || 'platform-admin-token',

  /** 排产引擎默认参数 */
  schedule: {
    /** 换模后固定缓冲（分钟），与专家团口径一致 */
    bufferMinutes: num(process.env.SCHEDULE_BUFFER_MINUTES, 30),
    /** 换料指令提前量（分钟）：换料指令 = 开工 - 60 */
    feedingOrderLeadMinutes: num(process.env.FEEDING_ORDER_LEAD, 60),
    /** 备料到位提前量（分钟）：备料到位 = 开工 - 30 */
    feedingReadyLeadMinutes: num(process.env.FEEDING_READY_LEAD, 30),
    /** 单班时长（小时），用于当班任务切分 */
    shiftHours: num(process.env.SHIFT_HOURS, 12),
  },

  /** AI 解析默认配置（可被租户后台配置覆盖） */
  ai: {
    baseUrl: process.env.AI_BASE_URL || 'https://api.deepseek.com/v1',
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || 'deepseek-chat',
    temperature: num(process.env.AI_TEMPERATURE, 0.1),
    timeoutMs: num(process.env.AI_TIMEOUT_MS, 20000),
    /** 未配置 API Key 时是否允许走确定性兜底解析器 */
    allowFallback: bool(process.env.AI_ALLOW_FALLBACK, true),
  },

  /** 是否静态托管管理后台 */
  serveAdminWeb: bool(process.env.SERVE_ADMIN_WEB, true),
  adminWebDir: process.env.ADMIN_WEB_DIR || resolve(ROOT, '..', 'admin-web'),
};

export default config;
