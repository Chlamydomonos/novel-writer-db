# syntax=docker/dockerfile:1.7
#
# 后端镜像：HTTP API + MCP 同进程，仅监听容器内 :3000。
# 对外由 nginx 反代（见 docs/deployment.md），本镜像不发布宿主机端口。

# ---------------------------------------------------------------------------
# build stage：编译 TS + 安装全部依赖（含 dev，tsc 需要）
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# sqlite3 原生 binding 编译工具链（pnpm-workspace.yaml 已 allowBuilds: sqlite3）
RUN apk add --no-cache python3 make g++ sqlite-dev

RUN corepack enable

# 先 COPY workspace 描述与 lockfile，利于 docker 层缓存
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# backend 通过 workspace:* 依赖 @novel-writer/shared，必须一并 COPY 进上下文
COPY packages/shared  ./packages/shared
COPY packages/backend ./packages/backend

RUN pnpm install --frozen-lockfile

# backend 的 tsc 会通过 shared 的 exports 字段读取 dist/*.d.ts，必须先编译 shared
RUN pnpm --filter @novel-writer/shared build
RUN pnpm --filter backend build

# ---------------------------------------------------------------------------
# runtime stage：仅装生产依赖，跑编译产物
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 生产依赖中的 @sequelize/sqlite3 仍是 native 模块，pnpm install --prod 时会重新编译
RUN apk add --no-cache python3 make g++ sqlite-dev

RUN corepack enable

# 仅保留运行所需清单文件与产物
COPY --from=build /app/package.json            /app/package.json
COPY --from=build /app/pnpm-workspace.yaml     /app/pnpm-workspace.yaml
COPY --from=build /app/pnpm-lock.yaml          /app/pnpm-lock.yaml
COPY --from=build /app/packages/backend/package.json /app/packages/backend/package.json
COPY --from=build /app/packages/backend/dist   /app/packages/backend/dist
COPY --from=build /app/packages/shared/package.json  /app/packages/shared/package.json
COPY --from=build /app/packages/shared/dist    /app/packages/shared/dist

RUN pnpm install --frozen-lockfile --prod

# SQLite 数据卷挂载点（与 db/sequelize.ts 的 storage: '/data/db.sqlite3' 对齐）
VOLUME ["/data"]

EXPOSE 3000
CMD ["node", "packages/backend/dist/main.js"]
