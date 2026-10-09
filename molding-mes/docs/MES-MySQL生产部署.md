# MES 生产部署（MySQL 8）

生产环境一律用 MySQL：SQLite 适合演示与单机体验，数据量上来后（订单、排产任务、消息、审计日志都在持续增长）在并发写、备份、容量上都会成为瓶颈。服务端本身是双方言（sqlite / mysql），切换只改环境变量，不改业务代码。

## 1. 目录规划

| 路径 | 用途 |
| --- | --- |
| `/opt/docker` | Docker 引擎与镜像（系统盘，不动） |
| `/data/mes/mysql` | MySQL 数据文件（数据盘） |
| `/data/mes/data` | 服务端运行数据（挂载到容器 `/data`） |
| `/data/mes/backup` | 备份（mysqldump 产出） |
| `/data/mes/docker-compose.yml` | 生产编排（用 `deploy/mysql/docker-compose.yml`） |

## 2. 首次部署

```bash
mkdir -p /data/mes/{mysql,data,backup}
# MySQL 容器内以 uid 999 运行，宿主机目录属主不对会起不来
chown -R 999:999 /data/mes/mysql

cd /data/mes
cat > .env <<'EOF'
MYSQL_ROOT_PASSWORD=换成强密码
MYSQL_PASSWORD=换成强密码
JWT_SECRET=换成随机长字符串
PLATFORM_TOKEN=换成随机长字符串
EOF
chmod 600 .env

docker compose -f docker-compose.yml up -d
docker compose ps
```

`server` 会在启动时自动执行 `migrate`：建 25 张表（幂等）+ 增量补列，并初始化一行平台 AI 配置。无需手工建表。

## 3. 初始化公司（全新库）

全新 MySQL 里没有任何公司，先用平台口令注册一家：

```bash
curl -X POST http://127.0.0.1:8080/api/platform/login \
  -H 'Content-Type: application/json' -d '{"token":"<PLATFORM_TOKEN>"}'
# 拿到 token 后
curl -X POST http://127.0.0.1:8080/api/platform/tenants \
  -H 'Content-Type: application/json' -H "Authorization: Bearer <token>" \
  -d '{"code":"demo","name":"某某注塑","adminPhone":"13800000001","adminName":"张管理","adminPassword":"改成自己的密码","maxUsers":50}'
```

返回后管理员即可用手机号 + 密码登录 `http://<host>:8080/admin/`，然后：录入基础数据 → 授权员工（下发初始密码）→ 分配角色。

## 4. 备份与恢复

```bash
# 备份（每天一次即可，GZIP 后通常只有几十 MB）
docker exec mes-mysql sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines molding_mes' \
  | gzip > /data/mes/backup/mes-$(date +%F).sql.gz

# 恢复
gunzip < /data/mes/backup/mes-2026-10-08.sql.gz \
  | docker exec -i mes-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" molding_mes'
```

建议用系统 crontab 每天 03:00 备份，并保留 14 天。

## 4.5 日志：级别与查看方式（v3.7.1）

服务端日志级别由环境变量 `LOG_LEVEL` 控制，**默认 `info`**（compose 里已显式写上）：

```yaml
services:
  server:
    environment:
      LOG_LEVEL: info      # trace / debug / info / warn / error / fatal
```

三处看日志，按场景选：

| 场景 | 方式 |
|---|---|
| 日常看最近发生了什么 | 平台后台 → **运行日志**（读服务端内存环形缓冲，最新 500 条，可按 warn / error 过滤） |
| 查更早的历史 | 服务器 `cd /data/mes && docker compose logs --tail=200 mes-server` |
| 实时跟踪 | `docker compose logs -f --tail=50 mes-server` |

落盘由 compose 的 `logging` 段限制（json-file，`max-size: 10m` × `max-file: 3`），
**不会撑爆系统盘**；内存缓冲只保留 500 条，服务重启即清空，两者互补。

嫌每个请求两条日志太吵：把 `LOG_LEVEL` 改成 `warn` 再 `docker compose up -d`；
排障时临时改 `debug`，查完改回 `info`。

## 5. 运维要点

- **时区**：容器 `TZ=Asia/Shanghai` 且 MySQL `--default-time-zone=+08:00`，两端必须一致；业务时间字段以本地口径 `YYYY-MM-DD HH:MM:SS` 字符串存取。
- **字符集**：`utf8mb4 / utf8mb4_unicode_ci`，建表语句已在代码里写死，不要手工改。
- **内存**：小内存设备调 `--innodb-buffer-pool-size`（一般给总内存 10%~20%）。2GB 内存机器建议 128M。
- **连接数**：默认池 `DB_POOL=10`，`max-connections=100` 足够；并发上来先加池而不是加 max_connections。
- **升级**：换镜像 tag → `docker compose up -d`；启动时自动增量补列（新增列无需手工 ALTER）。改已有列才需要定向迁移。
- **回滚**：保持旧库不动。切回 SQLite 只需把 `DB_DIALECT` 改回 `sqlite` 并挂回原数据目录。

## 6. 从旧的 SQLite 库迁移（仅在需要保留历史数据时）

两套库表结构由同一份 `server/src/db/schema.js` 生成，字段一致。迁移按表导出 INSERT 即可，注意：

1. 先对旧库做 `PRAGMA wal_checkpoint(TRUNCATE)`，否则数据在 `-wal` 里没落盘；
2. 自增主键不要带过来，让 MySQL 重新分配；
3. 布尔字段 SQLite 存 0/1，MySQL 是 `TINYINT(1)`，直接搬即可；
4. 迁移后跑一遍 `node scripts/seed.js --only=validate`（如无此脚本，用 `demo-flow.js` 冒烟）。

如果不需要历史数据（生产从零建档），跳过本节，直接按第 2、3 步全新部署。
