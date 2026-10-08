# 注塑生产协同 MES

面向**小批量注塑包装盒**工厂的 C/S 生产协同系统：业务员说一句话下单，系统自动匹配机台 / 模具 / 原料 / 标签并排产，再把各自该做的事推送给生产人员、配料员、技术员、仓库管理员。

- **服务端**：Node.js 22 + Fastify，数据库支持 SQLite（零依赖，本地即跑）与 MySQL 8（生产）
- **管理后台**：原生 HTML/JS，由服务端静态托管（`/admin/`）
- **安卓端**：Kotlin + Jetpack Compose（源码工程，用 Android Studio 编译）——读写：下单、报工、出库
- **微信小程序**：原生小程序（源码工程，微信开发者工具打开）——只读看板，按手机号判定可见范围
- **AI 解析**：后台可配置 BaseURL / APIKey / 模型（OpenAI 兼容协议）；未配置 Key 时自动走内置确定性解析器，不联网也能下单出库

---

## 一、五分钟跑起来

```bash
cd server
npm install
npm run migrate      # 建表（SQLite：server/data/mes.db）
npm run seed         # 写入演示公司与基础数据
npm start            # http://127.0.0.1:8080
```

打开 **http://127.0.0.1:8080/admin/** ，用 `13800000001 / 123456` 登录（公司编码 `DEMO`）。

跑一遍完整业务链路（下单→排产→各角色收消息→出库）：

```bash
npm run demo
```

演示账号（初始密码统一 `123456`，由管理员下发）：

| 手机号 | 角色 | 说明 |
|---|---|---|
| 13800000001 | 公司管理员 | 录入基础数据、授权员工、配 AI |
| 13800000002 | 业务员 | 一句话下单 |
| 13800000003 | 生产人员 | **绑定机台 IM-01**，只收本机台消息 |
| 13800000004 | 生产人员 | **未绑定机台**，收全部生产消息 |
| 13800000005 | 技术员 | 换模与保养提醒 |
| 13800000006 | 配料员 | 原料用量 / 使用时间 / 混料机 |
| 13800000007 | 仓库管理员 | 出入库与缺料告警 |

---

## 二、业务流程

```
                 ┌──────────── 管理后台（Web）────────────┐
                 │ 平台运维：注册公司 / 授权用户数与期限      │
                 │ 公司管理员：基础数据 / 员工授权 / AI 配置   │
                 └────────────────┬───────────────────────┘
                                  │
   业务员 APP ──「河北的魔辣面筋下2万个订单，13号交货」
                                  │
                          AI 解析（或确定性兜底）
                                  │
                     匹配客户 / 产品 / 数量 / 交期
                                  │
                          排产引擎（四类资源互斥）
                                  │
        ┌───────────────┬─────────┴────────┬───────────────┐
        ▼               ▼                  ▼               ▼
   生产人员 APP     配料员 APP        技术员 APP       仓库 APP
   新增订单         每种原料用量      换模提醒        缺料/缺标签
   产品规格数量     预计使用时间      保养提醒        出库回扣
   当班任务         几号混料器       设备故障
```

生产人员说「河北麻辣面筋出库5000个」→ 自动匹配订单 → 待生产数量 20000 → 15000 → 通知仓库与业务员。

微信小程序（只读看板）从同一份数据里按手机号取各自该看的部分：

```
技术员 → 机台状态 / 待维护模具 / 保养进度 / 下次换模时间与模具编号
老板   → 成品库存 / 原料库存 / 当前生产状态
PMC    → 排产计划（任务时间轴、机台负载、换模与配料时点）
```

谁能看什么由公司管理员在后台「小程序授权」里按手机号开通，并可逐人勾选覆盖角色默认值。详见 [`miniprogram/README.md`](miniprogram/README.md)。

---

## 三、目录结构

```
molding-mes/
├── server/                     服务端
│   ├── src/
│   │   ├── index.js            入口与路由装配
│   │   ├── config.js           配置（.env）
│   │   ├── middleware.js       鉴权 / 租户授权校验 / 消息可见性
│   │   ├── db/                 双方言数据层（schema.js 单一事实源 → 生成 DDL）
│   │   ├── lib/                util / auth(JWT) / rbac / repo / http / wechat
│   │   ├── domain/             排产引擎、物料核算、小程序视图聚合、AI 解析、消息生成
│   │   └── modules/            auth / platform / admin / master / orders / schedule / notify / chat / mp
│   ├── scripts/seed.js         演示种子数据
│   ├── scripts/demo-flow.js    端到端演示（下单→排产→通知→出库）
│   ├── scripts/mp-demo.js      小程序权限与视图端到端验证
│   ├── scripts/password-demo.js 密码登录与改密端到端验证
│   ├── Dockerfile              服务端镜像（构建上下文为 molding-mes/）
│   └── data/mes.db             SQLite 数据文件（自动创建）
├── admin-web/                  管理后台（原生 HTML/CSS/JS，无构建）
├── android/                    安卓工程（Kotlin + Compose）
├── miniprogram/                微信小程序（原生，只读看板）
├── optimizer/                  CP-SAT 排产求解器（FastAPI + OR-Tools）
├── docker-compose.yml          MySQL + 求解器 + 服务端
├── .dockerignore
└── docs/                       架构、接口、权限文档
```

---

## 四、排产引擎口径

直接移植自「注塑智造运营专家团」，与 CP-SAT 建模一致：

1. **四类资源互斥**：机台 / 模具 / 供料线 / 混料机，任一资源不得时间重叠
2. **硬约束**：供料线 `FAULT` → 其关联机台全部视为不可排（最容易漏的一条）
3. **效率三级回退**：机台×模具效率 → 机台默认效率 → 不可用（**不编造数值**）
4. **换模三态**：`KEEP_CURRENT_MOLD` / `CHANGE_MOLD` / `ACTIVATE_IDLE_MACHINE`
5. **开工时间** = `max(机台完工, 供料线占用至, 模具释放) + 换模时长 + 30min 缓冲`
6. **排序**：SALES 先保交期；STOCK 同模具聚批省换模
7. **集中供料时点**：换料指令 = 开工 − 60min，备料到位 = 开工 − 30min
8. **物料公式**：`数量 × 单件克重 / 1000 × (1 + 损耗率%)`；标签 = `数量 × 单件张数 × (1 + 标签损耗%)`

---

## 五、登录方式：手机号 + 初始密码

只有管理员录入过的手机号才能登录（未授权号码返回 `403 NOT_AUTHORIZED`）。
v3.4 起**不再使用短信验证码**，流程改为：

1. **管理员下发初始密码**：后台「员工授权」录入手机号时可指定初始密码，留空则系统随机生成 6 位数字；
   也可用「批量初始化密码」为全员统一下发。明文初始密码**只在提交后的结果面板出现一次**（库中只存 scrypt 散列）。
2. **员工登录**：安卓 / 后台输入「手机号 + 初始密码」，公司编码必填（演示环境为 `DEMO`）。
3. **是否修改由员工自选**：首次登录成功后 APP 弹出提示——
   - 点「保存」→ 输入新密码立即生效；
   - 点「以后再说」→ 保留初始密码，后续可在「我的 · 修改密码」随时改。

相关接口：`POST /api/auth/login`（返回 `must_change_password`）、`POST /api/auth/password`、
`POST /api/auth/password/later`、`POST /api/admin/employees/:id/password`、
`POST /api/admin/employees/init-passwords`。详见 [`docs/api.md`](docs/api.md)。

---

## 六、生产部署

### 6.1 Docker（推荐）

```bash
# 构建服务端镜像（上下文为 molding-mes/，镜像内已含管理后台）
docker build -f server/Dockerfile -t molding-mes-server:3.4 .

# 一键起 MySQL + CP-SAT 求解器 + 服务端
docker compose up -d --build
# 管理后台：http://<host>:8080/admin/
```

首次启动会自动建表/补列（服务端启动时执行 `migrate`）。**务必修改** `JWT_SECRET` 与 `PLATFORM_TOKEN`
（`docker-compose.yml` 里通过环境变量传入）。

### 6.2 手工部署

1. 启动 MySQL：`docker compose up -d mysql`（或用现有实例）
2. 在 `server/.env` 中设置 `DB_DIALECT=mysql` 及连接参数
3. `npm run migrate` 建表（已有库会自动补新增列）→ `npm start`
4. 反向代理（Nginx）转发 8080，配 HTTPS

### 6.3 安卓端服务端地址

打包默认指向 **`https://zs.250886.xyz/`**（`android/app/build.gradle.kts` 的 `DEFAULT_BASE_URL`）。
车间内网调试可在 APP「我的」页临时改成 `http://192.168.x.x:8080/`（只存在本机，不影响其他设备）。

---

## 七、CI：GitHub Actions

仓库根的 `.github/workflows/` 下有两个工作流（GitHub 只识别仓库根目录的工作流，
而本项目位于 `molding-mes/` 子目录，故工作流置于根、构建上下文指向子目录）：

| 工作流 | 触发 | 产物 |
|---|---|---|
| `mes-android.yml` | push(main, android 目录) / 发布 Release / 手动 | debug 与 release APK；配置了签名密钥则自动签名 + zipalign |
| `mes-server-docker.yml` | push(main) / 打 `v*.*.*` 标签 / PR / 手动 | `ghcr.io/<owner>/<repo>-mes-server`、`-mes-optimizer` 镜像 |

签名密钥（可选）在仓库 Settings → Secrets 配置：`ANDROID_KEYSTORE_BASE64`、
`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`。

---

## 八、已知边界

- 排产优先 CP-SAT 求解器，不可用时降级为**确定性列表调度**（结果可解释、可复现）
- 消息目前是**轮询**（WorkManager，默认 15 分钟）；需秒级触达时接入 FCM / 厂商推送，只需替换 `PollWorker`
- 安卓工程未提交 Gradle Wrapper；CI 用 `gradle/actions/setup-gradle` 拉 Gradle 8.9 构建，本地用 Android Studio 打开时会自动生成 Wrapper
