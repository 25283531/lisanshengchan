# 智注排产 MES

面向 PP 注塑包装盒工厂的生产排产系统，包含产品/BOM、原料库存、设备与模具效率矩阵、供料线、订单/工单、故障、排产建议、甘特图和报工看板。

## 版本说明

| 版本 | 代码位置 | 形态 | 说明 |
| --- | --- | --- | --- |
| v3.4（当前） | `molding-mes/` | 同上 + 密码登录与 CI 构建 | 登录改为**手机号 + 初始密码**（短信验证码下线）：管理员为员工下发/重置初始密码，员工首次登录可自选「立即修改」或「以后再说」；安卓端默认服务端地址 `https://zs.250886.xyz/`；新增 GitHub Actions：安卓 APK 构建（可签名）与服务端 / 求解器 Docker 镜像构建 |
| v3.3 | `molding-mes/` | 同上 + 真实微信小程序接入 | 已绑定 AppID `wx8be948bf11ef3fca`。因该小程序为**个人主体**（无法使用付费的 `getPhoneNumber` 手机号组件），改为「管理员签发一次性绑定码」完成身份绑定；同时提供手机号组件可用性自检。详见 [`molding-mes/miniprogram/README.md`](molding-mes/miniprogram/README.md) |
| v3.2 | `molding-mes/` | 同上 + 微信小程序 | 新增原生微信小程序只读看板：按手机号判定权限，新增老板（BOSS）与排产计划员（PMC）角色，管理员可逐人勾选可见范围 |
| v3.1 | `molding-mes/` | 同上 + Python CP-SAT 求解器 | 排产升级为 OR-Tools CP-SAT 全局最优化；求解器不可用时自动降级到内置列表调度。详见 [`molding-mes/README.md`](molding-mes/README.md) |
| v3.0 | `molding-mes/` | C/S 架构：Node.js + Fastify 服务端、Android（Kotlin + Compose）客户端、平台管理后台 | 多租户 SaaS 化 MES：授权与席位管理、RBAC 五类角色、AI 自然语言下单、自动排产与角色化通知、交接班与报工 |
| v1.x / v2.x | 仓库根目录（`apps/web`、`apps/api`、`apps/scheduler`、`compose.yaml`） | B/S 架构：React + NestJS + Python FastAPI | 早期单机版排产系统，保留用于回溯；部署方式见下文 |

> v3.0 与旧版相互独立：旧版继续用根目录的 `compose.yaml` 部署，新版用 `molding-mes/docker-compose.yml`，两者数据模型不互通。

### 登录方式（v3.4 起）

```
管理员：后台「员工授权」→ 录入手机号（可指定初始密码，留空随机 6 位）→ 把初始密码告知本人
        也可「批量初始化密码」为全员统一下发，明文只在提交后的结果面板出现一次
员工  ：手机号 + 初始密码登录 → 弹窗询问是否修改
        · 立即修改：输入新密码（≥6 位），即时生效
        · 以后再说：保留初始密码，之后在「我的 · 修改密码」随时改
```

短信验证码登录已下线；未设置初始密码的账号登录返回 `403 NO_PASSWORD`。

### v3.3 快速开始

```bash
# 1) 排产求解器（可选，不启动则自动降级到内置列表调度）
cd molding-mes/optimizer
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8090

# 2) 服务端
cd molding-mes/server
cp .env.example .env        # 修改 JWT_SECRET、PLATFORM_TOKEN；确认 OPTIMIZER_URL
                            # 微信：填 WX_APPID / WX_SECRET，WX_BIND_MODE 保持 auto
npm install
npm run migrate             # 建表（sqlite 或 mysql，由 DB_DIALECT 决定）
npm run seed                # 写入演示数据（含小程序授权与老板/PMC 演示账号）
npm start                   # 服务端，默认 http://localhost:8080
```

排产结果的 `summary.algorithm` 会标明本轮用了哪条路径：`cp-sat-v3.1`（求解器）或 `list-schedule-fallback`（降级）。

管理后台访问 `http://localhost:8080/admin`，安卓客户端用 Android Studio 打开 `molding-mes/android` 编译，
微信小程序用微信开发者工具打开 `molding-mes/miniprogram`（已内置 AppID，见该目录 README）。

### CI / 构建

GitHub Actions（`.github/workflows/`，GitHub 只识别仓库根目录的工作流）：

| 工作流 | 触发 | 产物 |
| --- | --- | --- |
| `mes-android.yml` | push(main, android 目录) / 发布 Release / 手动 | debug + release APK；配置了签名密钥则自动 zipalign + 签名 |
| `mes-server-docker.yml` | push(main) / 打 `v*.*.*` 标签 / PR / 手动 | GHCR 镜像：`-mes-server`、`-mes-optimizer` |

也可本地构建服务端镜像：`cd molding-mes && docker build -f server/Dockerfile -t molding-mes-server:3.4 .`

### 微信小程序员工绑定流程

```
管理员：后台「小程序授权」页 → 开通手机号并勾选可见范围 → 生成绑定码（6 位，30 分钟有效）
员工  ：小程序首登 → 输入手机号 + 绑定码（或扫 MPBIND:XXXXXX 二维码）→ 绑定成功
```

> 该 AppID 为**个人主体**，无法使用 `getPhoneNumber` 手机号快速验证组件
> （该能力需企业认证 + 按次付费），所以默认走绑定码方式。后台「检测手机号组件可用性」
> 可一键确认要不要切到 `WX_BIND_MODE=phone`。

### 微信小程序权限速查

| 身份 | 演示账号 | 小程序里能看到 |
| --- | --- | --- |
| 技术员 | 13800000005 | 机台状态、待维护模具、保养进度、下次换模时间与模具编号 |
| 老板 | 13800000008 | 成品库存、原料库存、当前生产状态 |
| PMC | 13800000009 | 排产计划（任务时间轴、机台负载、换模与配料时点） |

密码统一 `123456`。谁能用小程序由公司管理员在后台「小程序授权」按手机号开通。

## 系统组成（v1.x / v2.x 旧版）

- `apps/web`：React + TypeScript + Vite 前端，Nginx 提供静态页面并反向代理 `/api`。
- `apps/api`：NestJS + TypeORM 业务 API，启动时执行数据库迁移。
- `apps/scheduler`：Python FastAPI 排产优化服务（可继续扩展 OR-Tools CP-SAT 约束模型）。
- PostgreSQL：业务数据与库存流水。
- Redis：缓存及后续异步任务队列。
- `compose.yaml`：推荐的完整部署方式。

## GitHub Actions 构建镜像

仓库中的 `.github/workflows/docker-image.yml` 支持在 GitHub **Actions → Build and publish Docker images → Run workflow** 手动运行，也支持推送 `v*.*.*` Git tag 自动运行。工作流会构建并推送三个 GHCR 镜像：`<owner>/<repo>-web`、`<owner>/<repo>-api`、`<owner>/<repo>-optimizer`。仓库需允许 Actions 写入 Packages。

## Docker Compose 部署（推荐）

复制 `.env.example` 为服务器上的 `.env`，至少修改 `POSTGRES_PASSWORD`：

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `POSTGRES_DB` | 否 | `mes` | PostgreSQL 数据库名 |
| `POSTGRES_USER` | 否 | `mes` | PostgreSQL 用户 |
| `POSTGRES_PASSWORD` | 是 | 无 | 数据库密码，建议使用随机强密码 |
| `WEB_PORT` | 否 | `8080` | 宿主机对外访问端口 |
| `WEB_ORIGIN` | 否 | `http://localhost:8080` | API CORS 白名单；多个地址用逗号分隔 |
| `SEED_DEMO_DATA` | 否 | `false` | 首次启动是否写入演示数据；生产环境保持 `false` |

`DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_USER`、`DB_PASSWORD` 由 Compose 自动注入 API 容器，一般无需在 `.env` 中重复设置。

### 数据持久化与映射路径

- `postgres_data:/var/lib/postgresql/data`：PostgreSQL 数据，必须持久化并定期备份。
- `redis_data:/data`：Redis 数据；如果只把 Redis 当缓存，可按运维策略清理。
- 前端和 API 不要求挂载宿主机目录；配置通过 `.env` 注入。

```bash
cp .env.example .env
# 编辑 .env，设置 POSTGRES_PASSWORD
docker compose up -d --build
docker compose ps
```

访问 `http://服务器IP:${WEB_PORT}`；API 文档在容器网络内为 `http://api:3000/docs`，如需外部访问请增加端口映射或使用反向代理。

使用 GHCR 预构建镜像时，将 `compose.yaml` 中三个应用服务的 `build` 替换为：

```yaml
web: { image: ghcr.io/OWNER/REPO-web:latest }
api: { image: ghcr.io/OWNER/REPO-api:latest }
optimizer: { image: ghcr.io/OWNER/REPO-optimizer:latest }
```

## Docker run 部署（不使用 Compose）

```bash
docker network create mes-net
docker volume create mes-postgres-data
docker volume create mes-redis-data

docker run -d --name mes-postgres --network mes-net \
  -e POSTGRES_DB=mes -e POSTGRES_USER=mes -e POSTGRES_PASSWORD='请替换为强密码' \
  -v mes-postgres-data:/var/lib/postgresql/data --restart unless-stopped postgres:17-alpine

docker run -d --name mes-redis --network mes-net \
  -v mes-redis-data:/data --restart unless-stopped redis:7-alpine

docker run -d --name mes-optimizer --network mes-net --restart unless-stopped \
  ghcr.io/OWNER/REPO-optimizer:latest

docker run -d --name mes-api --network mes-net --restart unless-stopped \
  -e NODE_ENV=production -e PORT=3000 \
  -e DB_HOST=mes-postgres -e DB_PORT=5432 -e DB_NAME=mes \
  -e DB_USER=mes -e DB_PASSWORD='请替换为强密码' \
  -e WEB_ORIGIN='http://localhost:8080' -e SEED_DEMO_DATA=false \
  ghcr.io/OWNER/REPO-api:latest

docker run -d --name mes-web --network mes-net -p 8080:80 \
  --restart unless-stopped ghcr.io/OWNER/REPO-web:latest
```

API 容器启动时会自动执行迁移。生产环境建议备份 `mes-postgres-data` 并配置 HTTPS 反向代理。

## 本地开发与验证

```bash
cd apps/api && npm ci && npm run build
cd ../web && npm ci && npm run build
cd ../scheduler && python -m py_compile main.py
```

开发环境可先执行 `docker compose up -d postgres redis`，再分别运行 API 和 Web 的 dev 命令。排产会综合订单类型（销售/库存）、交期、数量、设备和模具专属效率、当前模具、换模时长、故障时间窗及供料资源进行推荐。
