# 更新日志

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
