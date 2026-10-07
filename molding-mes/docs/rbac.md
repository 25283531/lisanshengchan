# 角色与权限

## 1. 角色定义

| 角色 | 中文 | 职责 |
|---|---|---|
| `ADMIN` | 公司管理员 | 录入基础数据、授权员工与分配角色、配置 AI 与查看授权期限 |
| `SALES` | 业务员 | 用自然语言下单、改单、查进度与交期 |
| `PRODUCTION` | 生产人员 | 接收当班任务、报工与出库；可绑定机台，也可不绑定 |
| `TECHNICIAN` | 技术员 | 维护模具与机台基础数据、接收换模与保养提醒 |
| `MIXER` | 配料员 | 接收原料用量、预计使用时间、混料机分配 |
| `WAREHOUSE` | 仓库管理员 | 原料与成品出入库、库存盘点、缺料处理 |
| `PLATFORM` | 平台运维 | 注册公司、设置用户数与授权期限（非租户内角色） |

## 2. 权限矩阵

| 权限 | ADMIN | SALES | PRODUCTION | TECHNICIAN | MIXER | WAREHOUSE |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| `master.read` 读基础数据 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `master.write` 改基础数据 | ✅ | — | — | ✅ | — | — |
| `stock.write` 改库存 | ✅ | — | — | — | — | ✅ |
| `order.read` 查订单 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `order.create` 下单 | ✅ | ✅ | — | — | — | — |
| `order.update` 改单 | ✅ | ✅ | — | — | — | — |
| `order.outbound` 出库/报工 | ✅ | — | ✅ | — | — | ✅ |
| `schedule.read` 看排产 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `schedule.run` 触发排产 | ✅ | — | — | ✅ | — | — |
| `material.read` 看配料 | ✅ | — | ✅ | ✅ | ✅ | ✅ |
| `material.write` 改配料 | ✅ | — | — | — | — | ✅ |
| `employee.manage` 员工授权 | ✅ | — | — | — | — | — |
| `tenant.config` 公司配置 | ✅ | — | — | — | — | — |
| `audit.read` 审计日志 | ✅ | — | — | — | — | — |
| `chat.use` 使用助手 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## 3. 机台绑定与消息可见性

生产人员可绑定机台，也可以不绑定——同一套代码适配两种班组形态：

| 绑定状态 | 收到的生产类消息 |
|---|---|
| 已绑定 `machine_code = IM-01` | 机台 IM-01 的定向消息 + 全部广播消息 |
| 未绑定（`NULL`） | 全部机台的消息 |

其他角色不受机台过滤影响。

判断逻辑（`middleware.js#visibleTo`）：

```js
if (user.role === 'PRODUCTION' && user.machine_code) {
  return !notification.machine_code || notification.machine_code === user.machine_code;
}
return true;
```

## 4. 授权的边界

**「拿到 APP」不等于「能进系统」。** 唯一写入口是管理员在后台录入手机号：

```
POST /api/admin/employees { phone, name, role, machineCode }
```

未录入的手机号登录时返回：

```json
{ "code": "NOT_AUTHORIZED", "message": "该手机号尚未获得授权，请联系贵公司管理员先在后台录入手机号" }
```

公司级授权由平台侧控制，两个开关：

- `max_users`：活跃用户数达到上限后拒绝新增
- `expires_at`：到期后该公司全部账号拒绝登录（提示续期）

停用员工采用**软删除**（`status = DISABLED`）而非物理删除，保留历史报工与出库的归属。

## 5. 建议的落地配置顺序

1. 平台运维注册公司，设置用户数与期限
2. 公司管理员登录 → 录入机台 / 模具 / 供料线 / 混料机 / 原料 / 标签 / 产品 / 客户
3. 查看「建档完成度」，100% 后再启用排产
4. 授权员工手机号并分配角色，生产人员按需绑定机台
5. 配置 AI 接口（或先不配，用内置确定性解析）
6. 试跑一句「河北的魔辣面筋下2万个订单，13号交货」验证全链路
