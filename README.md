# 智注排产 MES

面向 PP 注塑包装盒工厂的生产排产系统，包含产品/BOM、原料库存、设备与模具效率矩阵、供料线、订单/工单、故障、排产建议、甘特图和报工看板。

## 版本说明

| 版本 | 代码位置 | 形态 | 说明 |
| --- | --- | --- | --- |
| v3.0（当前） | `molding-mes/` | C/S 架构：Node.js + Fastify 服务端、Android（Kotlin + Compose）客户端、平台管理后台 | 多租户 SaaS 化 MES：授权与席位管理、RBAC 五类角色、AI 自然语言下单、自动排产与角色化通知、交接班与报工。详见 [`molding-mes/README.md`](molding-mes/README.md) |
| v1.x / v2.x | 仓库根目录（`apps/web`、`apps/api`、`apps/scheduler`、`compose.yaml`） | B/S 架构：React + NestJS + Python FastAPI | 早期单机版排产系统，保留用于回溯；部署方式见下文 |

> v3.0 与旧版相互独立：旧版继续用根目录的 `compose.yaml` 部署，新版用 `molding-mes/docker-compose.yml`，两者数据模型不互通。

### v3.0 快速开始

```bash
cd molding-mes/server
cp .env.example .env        # 修改 JWT_SECRET、PLATFORM_TOKEN
npm install
npm run migrate             # 建表（sqlite 或 mysql，由 DB_DIALECT 决定）
npm run seed                # 写入演示数据
npm start                   # 服务端，默认 http://localhost:8080
```

管理后台访问 `http://localhost:8080/admin`，安卓客户端用 Android Studio 打开 `molding-mes/android` 编译。

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
