# 接口清单

统一响应：`{ code: 0, message: "ok", data: ... }`；失败时 `code` 为字符串错误码（如 `NOT_AUTHORIZED`）。
鉴权：`Authorization: Bearer <token>`。平台接口需平台令牌。

## 平台侧（软件供应商 / 运维）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/platform/login` | 平台口令登录 |
| POST | `/api/platform/tenants` | 注册公司（同时创建公司管理员与默认 AI 配置） |
| GET | `/api/platform/tenants` | 公司列表（含已用用户数） |
| GET | `/api/platform/tenants/:id` | 公司详情（含员工） |
| PUT | `/api/platform/tenants/:id/license` | 调整用户数 / 到期日 / 状态 |
| POST | `/api/platform/tenants/:id/reset-admin` | 重置管理员密码 |
| GET | `/api/platform/stats` | 平台统计（含 30 天内到期公司） |

## 登录与身份

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | 密码登录 `{phone,password,tenantCode?}` |
| POST | `/api/auth/sms/send` | 发送验证码（演示模式返回 `demo_code`） |
| POST | `/api/auth/sms/login` | 验证码登录 |
| GET | `/api/auth/me` | 当前用户、角色、权限、公司 |
| POST | `/api/auth/password` | 修改密码 |

未授权手机号返回 `403 NOT_AUTHORIZED`。

## 公司管理员

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/admin/overview` | employee.manage | 概览：授权、主数据条数、AI 状态、建档完成度 |
| GET | `/api/admin/employees` | employee.manage | 员工列表 |
| POST | `/api/admin/employees` | employee.manage | **录入手机号 = 授权登录**，分配角色与机台 |
| PUT | `/api/admin/employees/:id` | employee.manage | 改角色 / 机台绑定 / 停用 |
| DELETE | `/api/admin/employees/:id` | employee.manage | 停用（保留历史归属） |
| POST | `/api/admin/employees/:id/password` | employee.manage | 重置密码 |
| GET/PUT | `/api/admin/ai-config` | employee.manage | AI 接口配置读写 |
| POST | `/api/admin/ai-config/test` | employee.manage | 连通性测试 |
| GET | `/api/admin/roles` | employee.manage | 角色字典 |
| GET | `/api/admin/audit` | audit.read | 审计日志 |

## 基础数据

`res` ∈ `customers | materials | labels | molds | mixers | supply_lines | machines | products`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/master` | 一次性取全部主数据 |
| GET | `/api/master/:res` | 列表 |
| POST | `/api/master/:res` | 新增（集中供料机台会校验供料线存在） |
| POST | `/api/master/:res/bulk` | 批量导入 |
| PUT | `/api/master/:res/:id` | 修改 |
| DELETE | `/api/master/:res/:id` | 删除 |
| DELETE | `/api/master/:res/clear` | 清空该类目 |
| GET | `/api/master/onboarding` | 建档完成度报告 |

## 订单

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/orders` | order.read | 列表（支持 status/customerId/productId/keyword） |
| GET | `/api/orders/:id` | order.read | 详情（含排产任务） |
| POST | `/api/orders` | order.create | 新建 |
| PUT | `/api/orders/:id` | order.update | 改单（同步重算待生产数量） |
| POST | `/api/orders/:id/outbound` | order.outbound | **出库，回扣待生产数量** |
| POST | `/api/orders/:id/progress` | order.outbound | 报工，完工数增加 |

## 排产

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/schedule/run` | schedule.run | 运行排产并生成消息 |
| GET | `/api/schedule/tasks` | schedule.read | 任务列表（生产人员只看到绑定机台） |
| GET | `/api/schedule/materials` | material.read | 配料计划（按物料聚合） |
| GET | `/api/schedule/shift?hours=12` | schedule.read | 当班计划 |
| POST | `/api/schedule/shift-push` | schedule.run | 推送交接班消息 |
| PUT | `/api/schedule/tasks/:id` | schedule.read | 改任务状态 |

## 消息

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/notifications?limit&unread&type&since` | 消息列表（按角色+机台过滤） |
| GET | `/api/notifications/unread-count` | 未读数 |
| POST | `/api/notifications/:id/read` | 标记已读 |
| POST | `/api/notifications/read-all` | 全部已读 |

## 自然语言助手

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/chat` | 解析并执行（下单 / 出库 / 报工 / 查库存 / 查排产） |
| POST | `/api/chat/parse` | 只解析不执行（供 APP 预览确认） |
| GET | `/api/chat/logs` | 解析留痕 |

`/api/chat` 返回：

```json
{
  "intent": "CREATE_ORDER",
  "message": "已下单：ORD-20261007-8448\n河北 · 魔辣面筋包装盒 20000 个，交期 2026-10-13\n匹配机台 IM-01（模具 M-01，沿用机上模具）…",
  "confidence": 1,
  "used_fallback": true,
  "needs_confirm": false,
  "candidates": [],
  "data": { "order_code": "ORD-20261007-8448", "task": { ... } }
}
```

## 微信小程序（v3.2 起，v3.3 增加绑定码）

登录与身份：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/mp/config` | 启动配置：模式、`bind_methods`（可用绑定方式）、视图字典（免鉴权） |
| POST | `/api/mp/login` | `{code}` 换 openid；已绑定直接发令牌，未绑定返回 `need_bind` |
| POST | `/api/mp/bind-code` | `{code, phone, bindCode}` **绑定码绑定（默认方式）** |
| POST | `/api/mp/bind` | `{code, phoneCode}` 手机号快速验证组件绑定（需企业认证 + 付费，个人主体不可用） |
| POST | `/api/mp/unbind` | 解绑当前微信身份 |
| GET | `/api/mp/me` | 当前身份、可见视图、是否被管理员覆盖 |
| GET | `/api/mp/view/:view` | 视图数据：`equipment` `inventory` `production` `schedule` `material` `orders` `tasks` |

管理员维护白名单与绑定码：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/wx-access` | 白名单列表（含每人生效视图、接入模式） |
| POST | `/api/admin/wx-access` | 按手机号开通 / 更新（`views` 留空走角色默认） |
| PUT | `/api/admin/wx-access/:id` | 改启用状态 / 勾选视图 |
| DELETE | `/api/admin/wx-access/:id` | 取消授权（同时置空已绑定微信身份） |
| GET | `/api/admin/wx-roles` | 角色字典与各角色默认视图 |
| POST | `/api/admin/wx-bind-code` | 生成一次性绑定码 `{phone, ttlMinutes}`，返回 `code` 与 `scan_payload` |
| GET | `/api/admin/wx-bind-codes` | 绑定码列表（含可用 / 已使用 / 已过期 / 已作废状态） |
| DELETE | `/api/admin/wx-bind-code/:id` | 作废未使用的绑定码 |
| GET | `/api/admin/wx-phone-check` | 手机号快速验证组件可用性自检（返回 `verdict` 与建议） |

> `POST /api/admin/wx-bind-code` 要求该手机号**既是本公司员工、又已在 `wx_access` 白名单且启用**，
> 否则分别返回 `NOT_EMPLOYEE` / `WX_NOT_ALLOWED` / `WX_DISABLED`，不给未授权的人发码。

登录与绑定失败的业务码（前端按 `code` 判断）：

| code | 含义 |
|---|---|
| `NOT_AUTHORIZED` | 手机号不是本公司员工 |
| `WX_NOT_ALLOWED` | 是员工，但管理员没开通小程序 |
| `WX_DISABLED` | 开通过，但被管理员关闭 |
| `MULTI_TENANT` | 该手机号属于多家公司，需带 `tenantCode` 重登 |
| `VIEW_FORBIDDEN` | 请求了没有权限的视图 |
| `NO_BIND_CODE` | 未提交绑定码 |
| `BIND_CODE_BAD` | 绑定码不存在 |
| `BIND_CODE_USED` | 绑定码已使用（重放攻击拦截） |
| `BIND_CODE_EXPIRED` | 绑定码已过期 |
| `BIND_CODE_MISMATCH` | 绑定码是为其他手机号生成的 |

## 消息类型

| type | 接收角色 | 场景 |
|---|---|---|
| `ORDER_CREATED` | PRODUCTION / ADMIN | 新增生产任务（按机台定向） |
| `MATERIAL_PLAN` | MIXER / ADMIN | 原料用量、使用时间、混料机 |
| `MOLD_CHANGE` | TECHNICIAN / ADMIN | 换模提醒 |
| `MOLD_MAINTENANCE` | TECHNICIAN / ADMIN | 模具达保养阈值 |
| `MACHINE_FAULT` | TECHNICIAN / ADMIN / PRODUCTION | 机台或供料线故障 |
| `MATERIAL_SHORTAGE` | WAREHOUSE / MIXER / ADMIN | 原料缺口 |
| `LABEL_SHORTAGE` | WAREHOUSE / ADMIN | 标签缺口 |
| `DELAY_RISK` | SALES / ADMIN | 交期逾期风险 |
| `OUTBOUND_DONE` | WAREHOUSE / ADMIN / PRODUCTION / SALES | 出库回扣 |
| `SHIFT_PLAN` | PRODUCTION / ADMIN | 交接班当班任务 |
