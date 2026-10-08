#!/usr/bin/env node
/**
 * 建表 CLI：node src/db/migrate.js [--drop]
 * --drop 会先删除全部表（演示重置用，生产禁用）
 */
import config from '../config.js';
import { createDb, migrate, dropAll } from './index.js';

const drop = process.argv.includes('--drop');
const db = await createDb();

if (drop) {
  await dropAll(db);
  console.log('已删除全部表');
}

const r = await migrate(db);
console.log(`✅ 迁移完成：方言=${r.dialect}，表=${r.tables} 张`);
if (r.added_columns?.length) {
  console.log(`   增量补列 ${r.added_columns.length} 项：${r.added_columns.join('、')}`);
}
if (r.dialect === 'sqlite') console.log(`   数据库文件：${config.db.file}`);
db.close();
