/**
 * 角色与权限矩阵。
 * 角色：ADMIN 公司管理员 / SALES 业务员 / PRODUCTION 生产人员 /
 *      TECHNICIAN 技术员 / MIXER 配料员 / WAREHOUSE 仓库管理员
 */

export const ROLES = {
  ADMIN: { zh: '公司管理员', desc: '录入基础数据、授权员工与分配角色、配置 AI 与授权期限' },
  SALES: { zh: '业务员', desc: '用自然语言下单、改单、查进度与交期' },
  PRODUCTION: { zh: '生产人员', desc: '接收当班任务、报工与出库、可绑定机台' },
  TECHNICIAN: { zh: '技术员', desc: '维护模具与机台基础数据、接收换模与保养提醒' },
  MIXER: { zh: '配料员', desc: '接收原料用量、使用时间与混料机分配' },
  WAREHOUSE: { zh: '仓库管理员', desc: '原料与成品出入库、库存盘点与预警处理' },
};

export const ALL_ROLES = Object.keys(ROLES);

const P = {
  'master.read': ['ADMIN', 'SALES', 'PRODUCTION', 'TECHNICIAN', 'MIXER', 'WAREHOUSE'],
  'master.write': ['ADMIN', 'TECHNICIAN'],
  'stock.write': ['ADMIN', 'WAREHOUSE'],
  'order.read': ['ADMIN', 'SALES', 'PRODUCTION', 'TECHNICIAN', 'MIXER', 'WAREHOUSE'],
  'order.create': ['ADMIN', 'SALES'],
  'order.update': ['ADMIN', 'SALES'],
  'order.outbound': ['ADMIN', 'WAREHOUSE', 'PRODUCTION'],
  'schedule.read': ['ADMIN', 'SALES', 'PRODUCTION', 'TECHNICIAN', 'MIXER', 'WAREHOUSE'],
  'schedule.run': ['ADMIN', 'TECHNICIAN'],
  'material.read': ['ADMIN', 'WAREHOUSE', 'MIXER', 'TECHNICIAN', 'PRODUCTION'],
  'material.write': ['ADMIN', 'WAREHOUSE'],
  'employee.manage': ['ADMIN'],
  'tenant.config': ['ADMIN'],
  'notify.read': ['ADMIN', 'SALES', 'PRODUCTION', 'TECHNICIAN', 'MIXER', 'WAREHOUSE'],
  'chat.use': ['ADMIN', 'SALES', 'PRODUCTION', 'TECHNICIAN', 'MIXER', 'WAREHOUSE'],
  'audit.read': ['ADMIN'],
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
  SALES: ['ORDER_CREATED', 'ORDER_UPDATED', 'SCHEDULE_DONE', 'DELAY_RISK'],
  PRODUCTION: ['ORDER_CREATED', 'SHIFT_PLAN', 'TASK_ASSIGNED', 'ORDER_UPDATED'],
  TECHNICIAN: ['MOLD_CHANGE', 'MOLD_MAINTENANCE', 'MACHINE_FAULT', 'ORDER_CREATED'],
  MIXER: ['MATERIAL_PLAN', 'FEEDING_START', 'ORDER_CREATED'],
  WAREHOUSE: ['OUTBOUND_DONE', 'MATERIAL_SHORTAGE', 'LABEL_SHORTAGE', 'ORDER_CREATED'],
};

export const roleZh = (role) => ROLES[role]?.zh || role;
