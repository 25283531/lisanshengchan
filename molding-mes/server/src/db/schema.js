/**
 * 库表定义（单一事实源）。
 * 用一套抽象类型 DSL 描述，由 ddl() 分别生成 MySQL 8 与 SQLite 的建表语句，
 * 避免两套 schema 各自漂移。
 *
 * 列定义：[列名, 抽象类型, 长度/精度(可选), 默认值(可选), 是否可空(可选 true)]
 * 抽象类型：PK | INT | BIGINT | STR | TEXT | DEC | BOOL | DT | DATE | JSON
 */

export const TABLES = [
  {
    name: 'tenants',
    comment: '公司（租户）',
    cols: [
      ['id', 'PK'],
      ['code', 'STR', 64],
      ['name', 'STR', 128],
      ['status', 'STR', 20, 'ACTIVE'],
      ['max_users', 'INT', null, 20],
      ['expires_at', 'DT', null, null, true],
      ['contact_name', 'STR', 64, null, true],
      ['contact_phone', 'STR', 32, null, true],
      ['industry_note', 'STR', 255, null, true],
      ['created_at', 'DT'],
      ['updated_at', 'DT'],
    ],
    uniques: [['code']],
  },

  {
    name: 'ai_configs',
    comment: '租户 AI 接口配置（管理后台可改）',
    cols: [
      ['id', 'PK'],
      ['tenant_id', 'INT'],
      ['provider', 'STR', 32, 'OPENAI_COMPAT'],
      ['base_url', 'STR', 255, 'https://api.deepseek.com/v1'],
      ['api_key', 'STR', 255, null, true],
      ['model', 'STR', 64, 'deepseek-chat'],
      ['temperature', 'DEC', null, '0.1'],
      ['timeout_ms', 'INT', null, 20000],
      ['enabled', 'BOOL', null, 1],
      ['allow_fallback', 'BOOL', null, 1],
      ['last_test_ok', 'BOOL', null, 0],
      ['last_test_msg', 'STR', 255, null, true],
      ['updated_at', 'DT'],
    ],
    uniques: [['tenant_id']],
  },

  {
    name: 'users',
    comment: '员工账号（管理员录入手机号后方可登录）',
    cols: [
      ['id', 'PK'],
      ['tenant_id', 'INT'],
      ['phone', 'STR', 32],
      ['name', 'STR', 64],
      ['password_hash', 'STR', 255, null, true],
      ['role', 'STR', 24, 'PRODUCTION'],
      ['status', 'STR', 20, 'ACTIVE'],
      /** 生产人员可绑定机台，也可不绑定（NULL 表示接收全部机台消息） */
      ['machine_code', 'STR', 64, null, true],
      ['last_login_at', 'DT', null, null, true],
      ['created_at', 'DT'],
      ['updated_at', 'DT'],
    ],
    uniques: [['tenant_id', 'phone']],
    indexes: [['tenant_id', 'role']],
  },

  {
    name: 'wx_users',
    comment: '微信小程序身份绑定（openid ↔ 员工账号）',
    cols: [
      ['id', 'PK'],
      ['appid', 'STR', 64],
      ['openid', 'STR', 64],
      ['unionid', 'STR', 64, null, true],
      ['tenant_id', 'INT', null, null, true],
      ['user_id', 'INT', null, null, true],
      ['phone', 'STR', 32, null, true],
      ['nickname', 'STR', 64, null, true],
      ['avatar_url', 'STR', 255, null, true],
      /** PENDING 已拿 openid 未绑手机号 / ACTIVE 已绑定可用 / DISABLED 已停用 */
      ['status', 'STR', 20, 'PENDING'],
      ['bound_at', 'DT', null, null, true],
      ['last_login_at', 'DT', null, null, true],
      ['created_at', 'DT'],
      ['updated_at', 'DT'],
    ],
    uniques: [['appid', 'openid']],
    indexes: [['tenant_id', 'user_id'], ['phone']],
  },

  {
    name: 'wx_access',
    comment: '小程序访问白名单（公司管理员按手机号开通，决定谁能用小程序）',
    cols: [
      ['id', 'PK'],
      ['tenant_id', 'INT'],
      ['phone', 'STR', 32],
      ['name', 'STR', 64, null, true],
      ['enabled', 'BOOL', null, 1],
      /** 视图覆盖：留空 = 按该员工的角色默认视图；填写 = 以勾选为准 */
      ['views', 'JSON', null, null, true],
      ['remark', 'STR', 255, null, true],
      ['created_at', 'DT'],
      ['updated_at', 'DT'],
    ],
    uniques: [['tenant_id', 'phone']],
  },

  {
    name: 'wx_bind_codes',
    comment: '小程序绑定邀请码（管理员按手机号生成，员工在手输或扫码后换取绑定，替代付费的手机号组件）',
    cols: [
      ['id', 'PK'],
      ['tenant_id', 'INT'],
      ['phone', 'STR', 32],
      ['code', 'STR', 32],
      ['expires_at', 'DT'],
      ['used_at', 'DT', null, null, true],
      ['used_openid', 'STR', 64, null, true],
      ['created_by', 'INT', null, null, true],
      ['created_at', 'DT'],
    ],
    uniques: [['code']],
    indexes: [['tenant_id', 'phone']],
  },

  {
    name: 'customers',
    comment: '客户',
    cols: [
      ['id', 'PK'],
      ['tenant_id', 'INT'],
      ['code', 'STR', 64],
      ['name', 'STR', 128],
      ['aliases', 'JSON', null, null, true],
      ['contact', 'STR', 64, null, true],
      ['enabled', 'BOOL', null, 1],
      ['created_at', 'DT'],
    ],
    uniques: [['tenant_id', 'code']],
  },

  {
    name: 'materials',
    comment: '原料',
    cols: [
      ['id', 'PK'],
      ['tenant_id', 'INT'],
      ['sku', 'STR', 64],
      ['name', 'STR', 128],
      ['unit', 'STR', 16, 'kg'],
      ['stock_qty', 'DEC', null, 0],
      ['safety_stock', 'DEC', null, 0],
      ['reserved_qty', 'DEC', null, 0],
      ['lead_time_days', 'INT', null, 3],
      ['enabled', 'BOOL', null, 1],
      ['updated_at', 'DT'],
    ],
    uniques: [['tenant_id', 'sku']],
  },

  {
    name: 'labels',
    comment: '标签/标志耗材（与原料同级约束：盒子做出来没标签一样发不了货）',
    cols: [
      ['id', 'PK'],
      ['tenant_id', 'INT'],
      ['sku', 'STR', 64],
      ['name', 'STR', 128],
      ['category', 'STR', 32, null, true],
      ['unit', 'STR', 16, '张'],
      ['stock_qty', 'DEC', null, 0],
      ['safety_stock', 'DEC', null, 0],
      ['lead_time_days', 'INT', null, 5],
      ['enabled', 'BOOL', null, 1],
      ['updated_at', 'DT'],
    ],
    uniques: [['tenant_id', 'sku']],
  },

  {
    name: 'molds',
    comment: '模具',
    cols: [
      ['id', 'PK'],
      ['tenant_id', 'INT'],
      ['code', 'STR', 64],
      ['name', 'STR', 128, null, true],
      ['cavities', 'INT', null, 1],
      ['status', 'STR', 20, 'AVAILABLE'],
      ['cumulative_shots', 'INT', null, 0],
      ['maintenance_at_shots', 'INT', null, 100000],
      ['last_maintenance_at', 'DT', null, null, true],
      ['note', 'STR', 255, null, true],
      ['updated_at', 'DT'],
    ],
    uniques: [['tenant_id', 'code']],
  },

  {
    name: 'machines',
    comment: '注塑机台',
    cols: [
      ['id', 'PK'],
      ['tenant_id', 'INT'],
      ['code', 'STR', 64],
      ['name', 'STR', 128, null, true],
      ['status', 'STR', 20, 'AVAILABLE'],
      ['current_mold_code', 'STR', 64, null, true],
      ['mold_change_minutes', 'INT', null, 45],
      ['units_per_hour', 'INT', null, 0],
      /** CENTRALIZED 集中供料 / HOPPER 机边桶 / MANUAL 人工 */
      ['feeding_mode', 'STR', 20, 'HOPPER'],
      ['supply_line_code', 'STR', 64, null, true],
      ['mixer_code', 'STR', 64, null, true],
      ['product_skus', 'JSON', null, null, true],
      ['mold_codes', 'JSON', null, null, true],
      ['mold_efficiencies', 'JSON', null, null, true],
      ['enabled', 'BOOL', null, 1],
      ['updated_at', 'DT'],
    ],
    uniques: [['tenant_id', 'code']],
  },

  {
    name: 'supply_lines',
    comment: '集中供料线',
    cols: [
      ['id', 'PK'],
      ['tenant_id', 'INT'],
      ['code', 'STR', 64],
      ['name', 'STR', 128, null, true],
      ['status', 'STR', 20, 'AVAILABLE'],
      ['recipe_key', 'STR', 64, null, true],
      ['mixer_code', 'STR', 64, null, true],
      ['machine_codes', 'JSON', null, null, true],
      ['min_changeover_minutes', 'INT', null, 60],
      ['occupied_until', 'DT', null, null, true],
      ['enabled', 'BOOL', null, 1],
      ['updated_at', 'DT'],
    ],
    uniques: [['tenant_id', 'code']],
  },

  {
    name: 'mixers',
    comment: '混料机',
    cols: [
      ['id', 'PK'],
      ['tenant_id', 'INT'],
      ['code', 'STR', 64],
      ['name', 'STR', 128, null, true],
      ['status', 'STR', 20, 'AVAILABLE'],
      ['capacity_kg', 'DEC', null, 0],
      ['occupied_until', 'DT', null, null, true],
      ['enabled', 'BOOL', null, 1],
      ['updated_at', 'DT'],
    ],
    uniques: [['tenant_id', 'code']],
  },

  {
    name: 'products',
    comment: '产品（含配方、模具、标签绑定）',
    cols: [
      ['id', 'PK'],
      ['tenant_id', 'INT'],
      ['sku', 'STR', 64],
      ['name', 'STR', 128],
      ['aliases', 'JSON', null, null, true],
      ['logo_version', 'STR', 32, null, true],
      ['needs_label', 'BOOL', null, 0],
      ['labels_per_unit', 'DEC', null, 1],
      ['label_waste_rate', 'DEC', null, 2],
      ['label_skus', 'JSON', null, null, true],
      ['loss_rate', 'DEC', null, 3],
      ['unit', 'STR', 16, '个'],
      ['recipe', 'JSON', null, null, true],
      ['mold_codes', 'JSON', null, null, true],
      ['finished_stock_qty', 'DEC', null, 0],
      ['enabled', 'BOOL', null, 1],
      ['updated_at', 'DT'],
    ],
    uniques: [['tenant_id', 'sku']],
  },

  {
    name: 'orders',
    comment: '订单',
    cols: [
      ['id', 'PK'],
      ['tenant_id', 'INT'],
      ['code', 'STR', 64],
      ['customer_id', 'INT', null, null, true],
      ['product_id', 'INT'],
      ['quantity', 'INT', null, 0],
      ['remaining_qty', 'INT', null, 0],
      ['completed_qty', 'INT', null, 0],
      ['due_date', 'DATE', null, null, true],
      /** SALES 销售单（保交期优先） / STOCK 库存单（省换模优先） */
      ['order_type', 'STR', 16, 'SALES'],
      ['priority_score', 'INT', null, 0],
      ['status', 'STR', 20, 'DRAFT'],
      ['source', 'STR', 16, 'APP'],
      ['created_by', 'INT', null, null, true],
      ['note', 'STR', 255, null, true],
      ['created_at', 'DT'],
      ['updated_at', 'DT'],
    ],
    uniques: [['tenant_id', 'code']],
    indexes: [['tenant_id', 'status'], ['tenant_id', 'due_date']],
  },

  {
    name: 'schedule_tasks',
    comment: '排产任务',
    cols: [
      ['id', 'PK'],
      ['tenant_id', 'INT'],
      ['order_id', 'INT'],
      ['seq', 'INT', null, 0],
      ['machine_code', 'STR', 64],
      ['mold_code', 'STR', 64],
      ['supply_line_code', 'STR', 64, null, true],
      ['mixer_code', 'STR', 64, null, true],
      /** KEEP_CURRENT_MOLD / CHANGE_MOLD / ACTIVATE_IDLE_MACHINE */
      ['decision', 'STR', 32, 'KEEP_CURRENT_MOLD'],
      ['changeover_minutes', 'INT', null, 0],
      ['planned_qty', 'INT', null, 0],
      ['units_per_hour', 'INT', null, 0],
      ['duration_minutes', 'INT', null, 0],
      ['start_at', 'DT'],
      ['end_at', 'DT'],
      ['feeding_order_at', 'DT', null, null, true],
      ['feeding_ready_at', 'DT', null, null, true],
      ['status', 'STR', 20, 'PLANNED'],
      ['created_at', 'DT'],
    ],
    indexes: [['tenant_id', 'order_id'], ['tenant_id', 'machine_code']],
  },

  {
    name: 'material_plans',
    comment: '配料计划（配料员消息的数据源）',
    cols: [
      ['id', 'PK'],
      ['tenant_id', 'INT'],
      ['task_id', 'INT'],
      ['order_code', 'STR', 64],
      ['material_sku', 'STR', 64],
      ['material_name', 'STR', 128, null, true],
      ['kind', 'STR', 16, 'MATERIAL'],
      ['qty', 'DEC', null, 0],
      ['unit', 'STR', 16, 'kg'],
      ['use_at', 'DT', null, null, true],
      ['mixer_code', 'STR', 64, null, true],
      ['status', 'STR', 20, 'PLANNED'],
      ['created_at', 'DT'],
    ],
    indexes: [['tenant_id', 'task_id']],
  },

  {
    name: 'outbound_records',
    comment: '出库/发货记录（生产人员语音报数后回冲待生产数量）',
    cols: [
      ['id', 'PK'],
      ['tenant_id', 'INT'],
      ['order_id', 'INT'],
      ['qty', 'INT', null, 0],
      ['operator_id', 'INT', null, null, true],
      ['source', 'STR', 16, 'AI'],
      ['raw_text', 'STR', 255, null, true],
      ['created_at', 'DT'],
    ],
    indexes: [['tenant_id', 'order_id']],
  },

  {
    name: 'notifications',
    comment: '消息（按角色 + 机台定向分发）',
    cols: [
      ['id', 'PK'],
      ['tenant_id', 'INT'],
      ['type', 'STR', 40],
      ['title', 'STR', 255],
      ['body', 'STR', 2000, null, true],
      ['payload', 'JSON', null, null, true],
      ['audience_roles', 'JSON', null, null, true],
      /** NULL = 全量广播；有值 = 仅绑定该机台的人接收 */
      ['machine_code', 'STR', 64, null, true],
      ['ref_type', 'STR', 32, null, true],
      ['ref_id', 'INT', null, null, true],
      ['level', 'STR', 16, 'INFO'],
      ['created_at', 'DT'],
    ],
    indexes: [['tenant_id', 'created_at'], ['tenant_id', 'type']],
  },

  {
    name: 'notification_reads',
    comment: '消息已读回执',
    cols: [
      ['id', 'PK'],
      ['notification_id', 'INT'],
      ['user_id', 'INT'],
      ['read_at', 'DT'],
    ],
    uniques: [['notification_id', 'user_id']],
  },

  {
    name: 'audit_logs',
    comment: '审计日志',
    cols: [
      ['id', 'PK'],
      ['tenant_id', 'INT', null, null, true],
      ['user_id', 'INT', null, null, true],
      ['action', 'STR', 64],
      ['detail', 'JSON', null, null, true],
      ['ip', 'STR', 64, null, true],
      ['created_at', 'DT'],
    ],
    indexes: [['tenant_id', 'created_at']],
  },

  {
    name: 'ai_parse_logs',
    comment: 'AI 解析留痕（便于纠错与提示词调优）',
    cols: [
      ['id', 'PK'],
      ['tenant_id', 'INT'],
      ['user_id', 'INT', null, null, true],
      ['raw_text', 'STR', 1000],
      ['intent', 'STR', 32, null, true],
      ['payload', 'JSON', null, null, true],
      ['provider', 'STR', 32, null, true],
      ['used_fallback', 'BOOL', null, 0],
      ['confidence', 'DEC', null, 0],
      ['result', 'STR', 32, null, true],
      ['message', 'STR', 255, null, true],
      ['created_at', 'DT'],
    ],
    indexes: [['tenant_id', 'created_at']],
  },
];

const SQLITE_TYPE = {
  PK: () => 'INTEGER PRIMARY KEY AUTOINCREMENT',
  INT: () => 'INTEGER',
  BIGINT: () => 'INTEGER',
  STR: (n) => `VARCHAR(${n || 255})`,
  TEXT: () => 'TEXT',
  DEC: () => 'REAL',
  BOOL: () => 'INTEGER',
  DT: () => 'TEXT',
  DATE: () => 'TEXT',
  JSON: () => 'TEXT',
};

const MYSQL_TYPE = {
  PK: () => 'BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY',
  INT: () => 'INT',
  BIGINT: () => 'BIGINT',
  STR: (n) => `VARCHAR(${n || 255})`,
  TEXT: () => 'TEXT',
  DEC: () => 'DECIMAL(18,4)',
  BOOL: () => 'TINYINT(1)',
  DT: () => 'DATETIME',
  DATE: () => 'DATE',
  JSON: () => 'JSON',
};

function defaultLiteral(type, val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return String(val);
  if (typeof val === 'boolean') return val ? '1' : '0';
  return `'${String(val).replace(/'/g, "''")}'`;
}

function colSql(col, types, isMysql) {
  const [name, type, len, def, nullable] = col;
  const base = (types[type] || types.STR)(len);
  const parts = [`\`${name}\``, base];
  if (type !== 'PK') {
    if (!nullable) parts.push('NOT NULL');
    if (def !== null && def !== undefined) {
      const lit = defaultLiteral(type, def);
      if (lit) parts.push(`DEFAULT ${lit}`);
    }
  }
  return parts.join(' ');
}

export function createTableSql(table, dialect) {
  const isMysql = dialect === 'mysql';
  const types = isMysql ? MYSQL_TYPE : SQLITE_TYPE;
  const cols = table.cols.map((c) => colSql(c, types, isMysql));
  const extra = [];
  if (isMysql) {
    for (const u of table.uniques || []) {
      extra.push(`UNIQUE KEY \`uq_${table.name}_${u.join('_')}\` (${u.map((c) => `\`${c}\``).join(', ')})`);
    }
    for (const ix of table.indexes || []) {
      extra.push(`KEY \`ix_${table.name}_${ix.join('_')}\` (${ix.map((c) => `\`${c}\``).join(', ')})`);
    }
    const ddl = `CREATE TABLE IF NOT EXISTS \`${table.name}\` (\n  ${[...cols, ...extra].join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci${
      table.comment ? ` COMMENT='${table.comment}'` : ''
    };`;
    return ddl;
  }
  // SQLite：唯一/普通索引单独建
  const ddl = `CREATE TABLE IF NOT EXISTS \`${table.name}\` (\n  ${cols.join(',\n  ')}\n);`;
  return ddl;
}

export function createIndexSql(table, dialect) {
  if (dialect !== 'sqlite') return [];
  const out = [];
  for (const u of table.uniques || []) {
    out.push(`CREATE UNIQUE INDEX IF NOT EXISTS \`uq_${table.name}_${u.join('_')}\` ON \`${table.name}\` (${u.map((c) => `\`${c}\``).join(', ')});`);
  }
  for (const ix of table.indexes || []) {
    out.push(`CREATE INDEX IF NOT EXISTS \`ix_${table.name}_${ix.join('_')}\` ON \`${table.name}\` (${ix.map((c) => `\`${c}\``).join(', ')})`);
  }
  return out;
}

export const TABLE_NAMES = TABLES.map((t) => t.name);
