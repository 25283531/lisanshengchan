# 更新日志

## v3.3.0（标签 `v3.3`）

**接入真实微信小程序 `wx8be948bf11ef3fca`，改走「管理员签发绑定码」作为默认绑定方式。**

背景：该小程序是**个人主体**（`principal_type:0`）。微信的手机号快速验证组件
`getPhoneNumber` 仅对**已微信认证的非个人主体**小程序开放且按次收费（0.03 元/次），
个人主体调不通。因此把绑定链路换成与主体类型无关的绑定码方案。

- 新增 `wx_bind_codes` 表 + `POST /api/mp/bind-code`：管理员签发、员工手输或扫码；
  一次性、可提前作废、手机号不匹配拒绝、过期失效
- 新增管理接口：`/api/admin/wx-bind-code`（生成/列表/作废）与 `/api/admin/wx-phone-check`
  （手机号组件可用性自检，依据微信返回错误码给出 `unauthorized` / `no_quota` / `unknown` 判定）
- 新增环境变量 `WX_BIND_MODE`（auto 走绑定码，phone 走付费组件）
- dev 桩改为按 `dev-` 前缀识别：配置真实凭证后本地联调与真实登录互不干扰；
  真实 code 不能再自报手机号冒绑（冒绑漏洞修复）
- 管理后台「小程序授权」页增加绑定码生成区与组件检测按钮
- 小程序 login 页增加「手机号 + 绑定码」「扫码绑定」，并按服务端下发的
  `bind_methods` 决定展示哪些方式
- 修复：`bindAndIssue` 只 UPDATE 不 INSERT，直接调绑定接口会漏建 `wx_users` 记录

## v3.2.0（标签 `v3.2`）

新增**微信小程序**（只读看板），权限按手机号判定，公司管理员逐人开通。

**新增 `molding-mes/miniprogram/`**：原生微信小程序（无构建步骤，开发者工具直接打开）

- 页面：登录（微信授权 + 手机号快速验证）、首页（按可见范围生成入口）、
  设备与模具、库存总览、生产实况、排产计划、配料计划、订单、当班任务、我的
- 三个典型视图：
  - 技术员：机台状态、待维护模具、保养进度、**下次换模时间与模具编号**
  - 老板：成品库存、原料库存（含安全库存预警）、当前生产状态
  - PMC：排产计划（任务时间轴、机台负载、换模与配料时点、交期风险）
- 数据严谨性：保养只给剩余模次与已用百分比，仅当存在最近排产效率时才推算到期天数并标注依据；
  换模时间由开工时间反推（换模工时 + 30 分钟缓冲），页面写明推导口径

**服务端**

- 新增两张表：`wx_users`（openid ↔ 员工绑定）、`wx_access`（按手机号的小程序白名单 + 视图覆盖）
- 新增 `lib/wechat.js`：`jscode2session`、`stable_token`、`getuserphonenumber`；
  未配置凭证且非生产环境可开 `WX_DEV_MODE` 用手机号直登，便于联调
- 新增 `domain/mpview.js`：七个视图的聚合，全部按 `tenant_id` 隔离并按可见范围裁剪
- 新增 `modules/mp.js`：`/api/mp/config|login|bind|unbind|me|view/:view`
  与 `/api/admin/wx-access` CRUD、`/api/admin/wx-roles`
- **登录四道关**：微信 openid → 是本公司在职员工 → 在小程序白名单且启用 → 视图可见性。
  即便 openid 已绑定，每次登录仍重新校验白名单，管理员随时可关
- 取消授权会同时置空已绑定微信身份，避免"取消后还能看"

**角色与权限**

- 新增 `BOSS`（老板）与 `PMC`（排产计划员）两个角色，纳入 RBAC 权限矩阵与消息订阅类型
- 新增小程序视图字典 `MP_VIEWS` 与角色默认视图 `ROLE_VIEWS`；
  管理员可按手机号勾选覆盖角色默认值（勾选非空以勾选为准，否则走角色默认）
- 权限矩阵新增 `wx.manage`

**管理后台**：新增「小程序授权」页面（按手机号开通/关闭、逐人勾选可见范围、展示各角色默认视图与接入状态）

**修复**：`scheduler.js` 列表调度降级路径中 `feedOrderLead` / `feedReadyLead` 未定义，
导致求解器不可用时排产直接 500（v3.1 遗留，本次随 `scripts/mp-demo.js` 验证时暴露）

## v3.1.0（标签 `v3.1`）

排产引擎升级为 **CP-SAT 求解器**，从贪心启发式改为全局最优化搜索。

**新增 `molding-mes/optimizer/`**：独立的 Python 求解器微服务（FastAPI + OR-Tools CP-SAT）

- 建模：每张订单展开成多个候选资源 option（机台×模具×供料线×混料机），
  用 `NewOptionalIntervalVar` + `NewBoolVar` 表达"选且仅选一个"，
  四类资源各自 `AddNoOverlap` 保证时间不重叠
- 目标函数（沿用 lisanshengchan 口径）：
  `Σ(逾期分钟 × 权重) + Σ(换模时长) + Σ(完工时刻 × 完工权重)`
  SALES 权重 `100 + priority×10`，STOCK 权重 `20 + priority×5`，完工权重 SALES 5 / STOCK 1
- 求解参数：10 秒上限、8 线程；返回 `OPTIMAL` / `FEASIBLE` 与目标值

**服务端改造**（`scheduler.js` 升级为调度协调器）

- 新增 `domain/optimizer-client.js`：展开候选 options + HTTP 调求解器
- 双引擎：异步入口 `runSchedulingAsync()` 优先调求解器；同步入口 `runScheduling()` 始终走列表调度
- **自动降级**：求解器未配置 / 连不上 / 超时 / 不可行 → 回退列表调度，业务层无感知
- 配置新增 `optimizer` 段：`OPTIMIZER_ENABLED` / `OPTIMIZER_URL` / `OPTIMIZER_TIMEOUT_MS` / `OPTIMIZER_HORIZON_HOURS`
- `summary` 增加 `algorithm`（`cp-sat-v3.1` / `list-schedule-fallback`）、`objective`、`solver_status`，便于判断本轮用了哪条路径
- 接口契约（入参 ctx、出参 tasks/materialPlans/alerts/unassigned/summary）保持不变，安卓端与前台零改动

**部署**：`docker-compose.yml` 增加 `optimizer` 服务；`optimizer/Dockerfile` + `requirements.txt`

## v3.0.0（标签 `v3.0`）

新增 C/S 架构的注塑生产协同 MES，位于 `molding-mes/`，与旧版 B/S 系统相互独立。

**服务端（Node.js 22 + Fastify）**

- 多租户：以公司为租户，支持席位上限（`maxUsers`）、服务期限（`expiresAt`）、启用/停用
- 平台超管后台：建公司、发授权、配 AI（BaseURL / APIKey / 模型，OpenAI 兼容协议）
- RBAC 五类业务角色：仓库管理员、业务员、生产人员、技术员、配料员，外加公司管理员与平台超管
- 主数据：机台、模具（含穴数）、供料线（与机台双向绑定）、混料机、原料、产品、标签、BOM、效率矩阵
- AI 自然语言下单：一句话解析为结构化订单，未配置 Key 时自动降级到内置确定性解析器
- 排产引擎：机台 / 模具 / 供料线 / 混料机四类资源互斥，换模三态、效率三级回退、30 分钟缓冲；集中供料时点反推换料与备料指令
- 通知分发：按「角色 + 机台绑定」推送；配料员含原料用量、预计使用时间、混料机编号；技术员含换模与保养提醒；交接班推送当班规格与数量
- 报工与出库：生产人员一句「出库 5000 个」即扣减待生产数量并通知仓库与业务员
- 数据层双方言：SQLite（本地零依赖）与 MySQL 8（生产），19 张表由统一 schema DSL 生成

**管理后台**：原生 HTML/JS，服务端静态托管在 `/admin/`

**安卓客户端**：Kotlin + Jetpack Compose 源码工程（登录、首页、AI 助手、排产、我的、消息轮询与本地通知）

**文档**：`molding-mes/docs/architecture.md`、`api.md`、`rbac.md`

## v2.x（未打标签，随本次提交一并入库）

旧版 B/S 系统的增量改动：

- 工单生产进度上报（`AddWorkOrderProgress`）
- 成品库存（`AddFinishedStock`）
- 供料线与混料机建模（`AddSupplyLineMixer`）
- 排产服务与前端看板联动调整

## v1.0.0

仓库初始化：React + NestJS + Python FastAPI 的 B/S 排产系统与 Docker Compose 部署。
