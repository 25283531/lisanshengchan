#!/usr/bin/env node
/**
 * 演示种子数据：一家「小批量注塑包装盒」工厂的完整基础数据。
 * 直接用 HTTP 接口写入，因此同时验证了接口本身。
 *   node scripts/seed.js          写入（如已存在则跳过建公司，仅重建主数据）
 *   node scripts/seed.js --reset  先删库重建
 */
import { buildServer } from '../src/index.js';
import { createDb, migrate, dropAll } from '../src/db/index.js';
import config from '../src/config.js';
import { hashPassword } from '../src/lib/auth.js';
import { nowStr } from '../src/lib/util.js';

export const TENANT = { code: 'DEMO', name: '演示注塑包装盒厂' };

export const MASTER = {
  customers: [
    { code: 'C-HB', name: '河北', aliases: ['河北客户', '河北的'], contact: '王经理' },
    { code: 'C-SD', name: '山东', aliases: ['山东客户'], contact: '李经理' },
  ],
  materials: [
    { sku: 'PP-01', name: 'PP 注塑级（透明）', unit: 'kg', stock_qty: 2400, safety_stock: 800, lead_time_days: 3 },
    { sku: 'PP-02', name: 'PP 注塑级（白色）', unit: 'kg', stock_qty: 1500, safety_stock: 600, lead_time_days: 3 },
    { sku: 'MB-01', name: '色母 红', unit: 'kg', stock_qty: 60, safety_stock: 25, lead_time_days: 5 },
  ],
  labels: [
    { sku: 'LBL-MLMJ', name: '魔辣面筋不干胶标', category: '不干胶', unit: '张', stock_qty: 8000, safety_stock: 5000, lead_time_days: 5 },
    { sku: 'LBL-A', name: '通用包装盒标', category: '不干胶', unit: '张', stock_qty: 20000, safety_stock: 5000, lead_time_days: 5 },
  ],
  molds: [
    { code: 'M-01', name: '魔辣面筋盒模具', cavities: 4, status: 'AVAILABLE', cumulative_shots: 80000, maintenance_at_shots: 100000 },
    { code: 'M-02', name: '魔辣面筋盒模具（备用）', cavities: 4, status: 'AVAILABLE', cumulative_shots: 20000, maintenance_at_shots: 100000 },
    { code: 'M-03', name: '通用包装盒模具', cavities: 2, status: 'AVAILABLE', cumulative_shots: 12000, maintenance_at_shots: 100000 },
  ],
  mixers: [
    { code: 'MIX-1', name: '1# 混料机', capacity_kg: 200 },
    { code: 'MIX-2', name: '2# 混料机', capacity_kg: 150 },
  ],
  supply_lines: [
    {
      code: 'SL-1', name: '1# 集中供料线', status: 'AVAILABLE', recipe_key: 'PP-01',
      mixer_code: 'MIX-1', machine_codes: ['IM-01', 'IM-02'], min_changeover_minutes: 60,
    },
  ],
  machines: [
    {
      code: 'IM-01', name: '注塑机 1#', status: 'AVAILABLE', current_mold_code: 'M-01',
      mold_change_minutes: 45, units_per_hour: 280, feeding_mode: 'CENTRALIZED',
      supply_line_code: 'SL-1', mixer_code: 'MIX-1',
      product_skus: ['BOX-MLMJ', 'BOX-A'], mold_codes: ['M-01', 'M-02'],
      mold_efficiencies: { 'M-01': 320, 'M-02': 300 },
    },
    {
      code: 'IM-02', name: '注塑机 2#', status: 'AVAILABLE', current_mold_code: 'M-03',
      mold_change_minutes: 45, units_per_hour: 260, feeding_mode: 'CENTRALIZED',
      supply_line_code: 'SL-1', mixer_code: 'MIX-2',
      product_skus: ['BOX-B'], mold_codes: ['M-03'],
      mold_efficiencies: { 'M-03': 290 },
    },
    {
      code: 'IM-03', name: '注塑机 3#', status: 'MAINTENANCE', current_mold_code: null,
      mold_change_minutes: 60, units_per_hour: 240, feeding_mode: 'HOPPER',
      product_skus: ['BOX-MLMJ', 'BOX-B'], mold_codes: ['M-01', 'M-03'],
      mold_efficiencies: {},
    },
  ],
  products: [
    {
      sku: 'BOX-MLMJ', name: '魔辣面筋包装盒', aliases: ['魔辣面筋', '麻辣面筋', '魔辣面筋盒'],
      logo_version: 'V1', needs_label: 1, labels_per_unit: 1, label_waste_rate: 2,
      label_skus: ['LBL-MLMJ'], loss_rate: 3, unit: '个',
      recipe: [{ material_sku: 'PP-01', grams_per_unit: 32 }, { material_sku: 'MB-01', grams_per_unit: 0.5 }],
      mold_codes: ['M-01', 'M-02'], finished_stock_qty: 3000,
    },
    {
      sku: 'BOX-A', name: '小包装盒', aliases: ['小盒'], loss_rate: 3, unit: '个', needs_label: 0,
      recipe: [{ material_sku: 'PP-01', grams_per_unit: 18 }],
      mold_codes: ['M-02'], finished_stock_qty: 500,
    },
    {
      sku: 'BOX-B', name: '通用包装盒', aliases: ['通用盒'], loss_rate: 4, unit: '个',
      needs_label: 1, labels_per_unit: 1, label_waste_rate: 2, label_skus: ['LBL-A'],
      recipe: [{ material_sku: 'PP-02', grams_per_unit: 45 }],
      mold_codes: ['M-03'], finished_stock_qty: 1200,
    },
  ],
};

export const EMPLOYEES = [
  { phone: '13800000002', name: '张业务', role: 'SALES' },
  { phone: '13800000003', name: '李生产', role: 'PRODUCTION', machineCode: 'IM-01' },
  { phone: '13800000004', name: '王生产', role: 'PRODUCTION', machineCode: null },
  { phone: '13800000005', name: '赵技术', role: 'TECHNICIAN' },
  { phone: '13800000006', name: '陈配料', role: 'MIXER' },
  { phone: '13800000007', name: '刘仓库', role: 'WAREHOUSE' },
];

export const ADMIN = { phone: '13800000001', name: '厂管理员', password: '123456' };

/** 写入主数据（幂等：先清空该租户主数据） */
export async function seedMaster(app, token) {
  const H = { authorization: `Bearer ${token}` };
  const out = {};
  for (const res of Object.keys(MASTER)) {
    await app.inject({ method: 'DELETE', url: `/api/master/${res}/clear`, headers: H }).catch(() => {});
    const r = await app.inject({ method: 'POST', url: `/api/master/${res}/bulk`, headers: H, payload: { items: MASTER[res] } });
    out[res] = JSON.parse(r.body);
  }
  return out;
}

export async function ensureTenant(app, db, platformToken) {
  let tenant = await db.get('SELECT * FROM tenants WHERE code = ?', [TENANT.code]);
  if (!tenant) {
    const r = await app.inject({
      method: 'POST', url: '/api/platform/tenants',
      headers: { authorization: `Bearer ${platformToken}` },
      payload: { code: TENANT.code, name: TENANT.name, adminName: ADMIN.name, adminPhone: ADMIN.phone, adminPassword: ADMIN.password, maxUsers: 50 },
    });
    const body = JSON.parse(r.body);
    if (!body.data) throw new Error(`建公司失败：${r.body}`);
    tenant = await db.get('SELECT * FROM tenants WHERE code = ?', [TENANT.code]);
  }
  const admin = await db.get('SELECT * FROM users WHERE tenant_id = ? AND role = ?', [tenant.id, 'ADMIN']);
  return { tenant, admin };
}

export async function ensureEmployees(app, db, tenantId) {
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { phone: ADMIN.phone, password: ADMIN.password, tenantCode: TENANT.code } });
  const token = JSON.parse(login.body).data.token;
  const H = { authorization: `Bearer ${token}` };
  for (const e of EMPLOYEES) {
    const exists = await db.get('SELECT id FROM users WHERE tenant_id = ? AND phone = ?', [tenantId, e.phone]);
    if (exists) {
      await app.inject({ method: 'PUT', url: `/api/admin/employees/${exists.id}`, headers: H, payload: { role: e.role, machineCode: e.machineCode, status: 'ACTIVE' } });
    } else {
      await app.inject({ method: 'POST', url: '/api/admin/employees', headers: H, payload: { phone: e.phone, name: e.name, role: e.role, machineCode: e.machineCode, password: '123456' } });
    }
  }
  return token;
}

async function main() {
  const reset = process.argv.includes('--reset');
  const db = await createDb();
  if (reset) { await dropAll(db); await migrate(db); }
  const { app } = await buildServer({ db, migrate: true });

  // 平台登录
  const pl = await app.inject({ method: 'POST', url: '/api/platform/login', payload: { token: config.platformToken } });
  const platformToken = JSON.parse(pl.body).data?.token;
  if (!platformToken) throw new Error('平台登录失败');

  const { tenant } = await ensureTenant(app, db, platformToken);
  const adminToken = await ensureEmployees(app, db, tenant.id);
  const seeded = await seedMaster(app, adminToken);

  console.log('\n✅ 演示数据已就绪\n');
  console.log(`公司：${tenant.name}（${tenant.code}）`);
  for (const [k, v] of Object.entries(seeded)) {
    console.log(`  ${k.padEnd(14)} ${v.code === 0 ? `导入 ${v.data?.ids?.length ?? 0} 条` : v.message}`);
  }
  console.log('\n账号（密码统一 123456）：');
  console.log(`  ${ADMIN.phone}  ${ADMIN.name}  公司管理员`);
  for (const e of EMPLOYEES) console.log(`  ${e.phone}  ${e.name}  ${e.role}${e.machineCode ? `（绑定机台 ${e.machineCode}）` : '（未绑定机台）'}`);
  console.log(`\n平台口令：${config.platformToken}`);
  console.log(`数据库：${db.dialect} ${db.dialect === 'sqlite' ? config.db.file : config.db.database}\n`);

  await app.close();
  db.close();
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
