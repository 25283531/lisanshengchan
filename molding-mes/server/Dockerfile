# 注塑生产协同 MES · 服务端镜像
#
# 构建（上下文必须是 molding-mes/，因为镜像内还要带上管理后台静态页）：
#   cd molding-mes
#   docker build -f server/Dockerfile -t molding-mes-server:3.4 .
#
# 运行（sqlite 单机）：
#   docker run -d --name molding-mes -p 8080:8080 \
#     -v mes-data:/data \
#     -e JWT_SECRET=请改成随机长字符串 -e PLATFORM_TOKEN=请改成自己的口令 \
#     molding-mes-server:3.4
# 管理后台：http://<host>:8080/admin/
#
# MySQL 生产部署见 docker-compose.yml（镜像内已含 mysql2 驱动，只需改环境变量）。

FROM node:22-bookworm-slim

ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DB_DIALECT=sqlite \
    DB_FILE=/data/mes.db \
    SERVE_ADMIN_WEB=true

RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server

# 依赖单独一层：源码变动时不必重装依赖
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server/src ./src
COPY server/scripts ./scripts
COPY admin-web /app/admin-web

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 启动时自动建表/补列（src/index.js 内 migrate），首次运行无需手工 migrate
CMD ["node", "src/index.js"]
