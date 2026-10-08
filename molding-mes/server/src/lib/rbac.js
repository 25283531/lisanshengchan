/**
 * 角色与权限矩阵。
 * 角色：ADMIN 公司管理员 / BOSS 老板 / PMC 排产计划员 / SALES 业务员 /
 *      PRODUCTION 生产人员 / TECHNICIAN 技术员 / MIXER 配料员 / WAREHOUSE 仓库管理员
 */

export const ROLES = {
  ADMIN: { zh: '公司管理员', desc: '录入基础数据、授权员工与分配角色、配置 AI 与授权期限' },
  BOSS: { zh: '老板', desc: '查看成品库存、原料库存与当前生产状态（只读经营视角）' },
  PMC: { zh: '排产计划员', desc: '查看与推动排产计划、交期风险与产能占用' },
  SALES: { zh: '业务员', desc: '用自然语言下单、改单、查进度与交期' },
  PRODUCTION: { zh: '生产人员', desc: '接收当班任务、报工与出库、可绑定机台' },
  TECHNICIAN: { zh: '技术员', desc: '维护模具与机台基础数据、接收换模与保养提醒' },
  MIXER: { zh: '配料员', desc: '接收原料用量、使用时间与混料机分配' },
  WAREHOUSE: { zh: '仓库管理员', desc: '原料与成品出入库、库存盘点与预警处理' },
};

/**
 * 微信小程序视图字典。
 * 小程序只做"看"，每个视图对应一组聚合数据；管理员可按手机号勾选覆盖角色默认值。
 */
export const MP_VIEWS = {
  equipment: { zh: '设备与模具', desc: '机台状态、待维护设备、保养进度、下次换模时间与模具编号', icon: '🔧' },
  inventory: { zh: '库存总览', desc: '成品库存、原料库存、标签库存与安全库存预警', icon: '📦' },
  production: { zh: '生产实况', desc: '在制工单、当班进度、各机台当前在产订单', icon: '🏭' },
  schedule: { zh: '排产计划', desc: '排产任务时间轴、开工/完工、换模与配料时点', icon: '📅' },
  material: { zh: '配料计划', desc: '原料预估用量、使用时间、混料机分配', icon: '⚖️' },
  orders: { zh: '订单', desc: '订单列表、交期与待生产数量', icon: '📝' },
  tasks: { zh: '当班任务', desc: '本班要生产的产品规格与数量', icon: '✅' },
};

export const ALL_MP_VIEWS = Object.keys(MP_VIEWS);

/** 各角色默认可见视图；管理员在小程序授权里可逐人覆盖 */
export const ROLE_VIEWS = {
  ADMIN: [...ALL_MP_VIEWS],
  BOSS: ['inventory', 'production'],
  PMC: ['schedule'],
  SALES: ['orders'],
  PRODUCTION: ['tasks', 'production'],
  TECHNICIAN: ['equipment'],
  MIXER: ['material'],
  WAREHOUSE: ['inventory', 'material'],
};

/**
 * 解析某人最终可见视图。
 * 优先级：管理员勾选的 views（wx_access.views）> 角色默认视图。
 * 勾选为空数组时视为「未覆盖」，仍走角色默认——避免误存空数组导致全部不可见。
 */
export function resolveViews(role, override) {
  const list = Array.isArray(override) ? override.filter((v) => ALL_MP_VIEWS.includes(v)) : [];
  if (list.length) return [...new Set(list)];
  return [...(ROLE_VIEWS[role] || [])];
}

/** 是否可见某视图 */
export const canView = (views, view) => (views || []).includes(view);

export const ALL_ROLES = Object.keys(ROLES);

const RO = ['ADMIN', 'BOSS', 'PMC', 'SALES', 'PRODUCTION', 'TECHNICIAN', 'MIXER', 'WAREHOUSE'];

const P = {
  'master.read': RO,
  'master.write': ['ADMIN', 'TECHNICIAN'],
  'stock.write': ['ADMIN', 'WAREHOUSE'],
  'order.read': RO,
  'order.create': ['ADMIN', 'SALES'],
  'order.update': ['ADMIN', 'SALES'],
  'order.outbound': ['ADMIN', 'WAREHOUSE', 'PRODUCTION'],
  'schedule.read': RO,
  'schedule.run': ['ADMIN', 'PMC', 'TECHNICIAN'],
  'material.read': ['ADMIN', 'BOSS', 'WAREHOUSE', 'MIXER', 'TECHNICIAN', 'PRODUCTION'],
  'material.write': ['ADMIN', 'WAREHOUSE'],
  'employee.manage': ['ADMIN'],
  'tenant.config': ['ADMIN'],
  'notify.read': RO,
  'chat.use': RO,
  'audit.read': ['ADMIN'],
  /** 小程序访问白名单维护（谁能用小程序） */
  'wx.manage': ['ADMIN'],
};

export function can(role, permission) {
  if (role === 'PLATFORM') return true;
  return (P[permission] || []).includes(role);
}

export function assertCan(role, permission) {
  if (!can(role, permission)) {
    const err = new Error(`当前角色（${ROLES[role]?.zh || role}）无权执行：${permission}`);
    err.status = 403;
    err.code = 'FORBIDDEN';
    throw err;
  }
}

export const permissionsOf = (role) =>
  Object.keys(P).filter((p) => can(role, p));

/** 各角色默认关心的消息类型（用于消息定向与推送） */
export const ROLE_NOTIFY_TYPES = {
  ADMIN: ['*'],
  BOSS: ['ORDER_CREATED', 'DELAY_RISK', 'MATERIAL_SHORTAGE', 'LABEL_SHORTAGE', 'OUTBOUND_DONE'],
  PMC: ['ORDER_CREATED', 'SCHEDULE_DONE', 'DELAY_RISK', 'MOLD_CHANGE'],
  SALES: ['ORDER_CREATED', 'ORDER_UPDATED', 'SCHEDULE_DONE', 'DELAY_RISK'],
  PRODUCTION: ['ORDER_CREATED', 'SHIFT_PLAN', 'TASK_ASSIGNED', 'ORDER_UPDATED'],
  TECHNICIAN: ['MOLD_CHANGE', 'MOLD_MAINTENANCE', 'MACHINE_FAULT', 'ORDER_CREATED'],
  MIXER: ['MATERIAL_PLAN', 'FEEDING_START', 'ORDER_CREATED'],
  WAREHOUSE: ['OUTBOUND_DONE', 'MATERIAL_SHORTAGE', 'LABEL_SHORTAGE', 'ORDER_CREATED'],
};

export const roleZh = (role) => ROLES[role]?.zh || role;
