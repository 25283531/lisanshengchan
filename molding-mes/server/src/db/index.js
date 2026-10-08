/**
 * 双方言数据访问层。
 *  - sqlite：Node 22 内置 node:sqlite，零依赖，用于本地演示 / 单机部署
 *  - mysql ：mysql2 连接池，用于生产
 *
 * 统一约定：
 *  1. 占位符一律 `?`
 *  2. 日期时间一律以 'YYYY-MM-DD HH:MM:SS' 字符串存取（mysql2 开启 dateStrings）
 *  3. 布尔一律 0/1 整数
 *  4. JSON 列：写入时序列化，读出时用 lib/json.js 的 j() 归一（mysql 返回对象、sqlite 返回字符串）
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import config from '../config.js';
import { TABLES, createTableSql, createIndexSql, addColumnSql } from './schema.js';

const txStore = new AsyncLocalStorage();

function nowSql() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ------------------------------- SQLite 驱动 ------------------------------ */

function createSqliteDriver(file) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line no-undef
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const handle = new DatabaseSync(file);
  handle.exec('PRAGMA journal_mode = WAL;');
  handle.exec('PRAGMA foreign_keys = ON;');

  const norm = (rows) => rows.map((r) => ({ ...r }));

  return {
    dialect: 'sqlite',
    kind: 'sync',
    async query(sql, params = []) {
      const conn = txStore.getStore() || handle;
      return norm(conn.prepare(sql).all(...params));
    },
    async get(sql, params = []) {
      const rows = await this.query(sql, params);
      return rows[0] || null;
    },
    async run(sql, params = []) {
      const conn = txStore.getStore() || handle;
      const r = conn.prepare(sql).run(...params);
      return { changes: Number(r.changes ?? 0), insertId: Number(r.lastInsertRowid ?? 0) };
    },
    async exec(sql) {
      const conn = txStore.getStore() || handle;
      conn.exec(sql);
    },
    async transaction(fn) {
      if (txStore.getStore()) return fn(this); // 已在同一事务内，直接复用
      handle.exec('BEGIN IMMEDIATE');
      try {
        const r = await txStore.run(handle, () => fn(this));
        handle.exec('COMMIT');
        return r;
      } catch (e) {
        try { handle.exec('ROLLBACK'); } catch { /* noop */ }
        throw e;
      }
    },
    close() { try { handle.close(); } catch { /* noop */ } },
  };
}

/* -------------------------------- MySQL 驱动 ------------------------------ */

async function createMysqlDriver(cfg) {
  const mysql = await import('mysql2/promise');
  const pool = mysql.default.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: cfg.connectionLimit,
    charset: 'utf8mb4',
    // 日期返回字符串，与 sqlite 保持一致
    dateStrings: true,
    multipleStatements: false,
  });

  const connOf = () => txStore.getStore() || pool;

  return {
    dialect: 'mysql',
    kind: 'pool',
    pool,
    async query(sql, params = []) {
      const [rows] = await connOf().query(sql, params);
      return Array.isArray(rows) ? rows.map((r) => ({ ...r })) : [];
    },
    async get(sql, params = []) {
      const rows = await this.query(sql, params);
      return rows[0] || null;
    },
    async run(sql, params = []) {
      const [r] = await connOf().query(sql, params);
      return { changes: Number(r.affectedRows ?? 0), insertId: Number(r.insertId ?? 0) };
    },
    async exec(sql) {
      await connOf().query(sql);
    },
    async transaction(fn) {
      if (txStore.getStore()) return fn(this);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const r = await txStore.run(conn, () => fn(this));
        await conn.commit();
        return r;
      } catch (e) {
        try { await conn.rollback(); } catch { /* noop */ }
        throw e;
      } finally {
        conn.release();
      }
    },
    close() { try { pool.end(); } catch { /* noop */ } },
  };
}

/* --------------------------------- 工厂 ---------------------------------- */

export async function createDb(opts = {}) {
  const cfg = opts.db || config.db;
  let driver;
  if (cfg.dialect === 'mysql') {
    driver = await createMysqlDriver(cfg);
  } else if (cfg.dialect === 'sqlite') {
    driver = createSqliteDriver(cfg.file);
  } else {
    throw new Error(`不支持的数据库方言：${cfg.dialect}（可选 sqlite / mysql）`);
  }

  driver.now = nowSql;
  driver.placeholderList = (n) => new Array(n).fill('?').join(', ');
  return driver;
}

/** 读取某张表现有的列名；表不存在返回 null。 */
async function existingColumns(db, table) {
  if (db.dialect === 'sqlite') {
    const rows = await db.query(`PRAGMA table_info(\`${table}\`)`);
    if (!rows.length) return null;
    return new Set(rows.map((r) => r.name));
  }
  let rows;
  try {
    rows = await db.query(`SHOW COLUMNS FROM \`${table}\``);
  } catch {
    return null; // 表不存在
  }
  return new Set(rows.map((r) => r.Field));
}

/**
 * 增量补列：把 schema 里新增的列补进已存在的表。
 * 只补「表里没有、schema 里有」的列，不动已有列，也不删列，可安全重复执行。
 */
export async function syncColumns(db) {
  const added = [];
  for (const table of TABLES) {
    const has = await existingColumns(db, table.name);
    if (!has) continue; // 表还没建，交给 migrate 的 CREATE TABLE
    for (const col of table.cols) {
      if (col[1] === 'PK') continue;
      if (has.has(col[0])) continue;
      try {
        await db.exec(addColumnSql(table, col, db.dialect));
        added.push(`${table.name}.${col[0]}`);
      } catch (e) {
        added.push(`${table.name}.${col[0]}（失败：${e.message}）`);
      }
    }
  }
  return added;
}

/** 建表（幂等）+ 增量补列。返回执行结果统计。 */
export async function migrate(db) {
  const dialect = db.dialect;
  let created = 0;
  for (const table of TABLES) {
    await db.exec(createTableSql(table, dialect));
    for (const ix of createIndexSql(table, dialect)) await db.exec(ix);
    created += 1;
  }
  const added = await syncColumns(db);
  return { dialect, tables: created, added_columns: added };
}

/** 删库跑路（仅用于演示重置） */
export async function dropAll(db) {
  for (const table of [...TABLES].reverse()) {
    await db.exec(`DROP TABLE IF EXISTS \`${table.name}\`;`);
  }
}

export { nowSql };
