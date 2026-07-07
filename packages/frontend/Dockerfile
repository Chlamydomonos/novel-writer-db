# syntax=docker/dockerfile:1.7
#
# 前端镜像：构建期编译 Vite SPA，运行期以 nginx 托管静态产物 + 反代 /api、/mcp。
# 这是整个 compose 对外的唯一出口（:80），其它服务都收敛在内网 main 网络。
# 详见 docs/deployment.md。

# ---------------------------------------------------------------------------
# build stage：pnpm 安装 + 前端 Vite 构建
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable

# 先 COPY workspace 描述与 lockfile，利于 docker 层缓存
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# frontend 当前未直接依赖 @novel-writer/shared，但保留 shared 进上下文
# 以备扩展（且 backend 镜像已采用相同约定）
COPY packages/shared  ./packages/shared
COPY packages/frontend ./packages/frontend

RUN pnpm install --frozen-lockfile

# 即便前端尚未引用 shared，先编译可避免后续接入时类型漂移
RUN pnpm --filter @novel-writer/shared build
RUN pnpm --filter frontend build

# ---------------------------------------------------------------------------
# runtime stage：nginx:alpine 托管静态产物
# ---------------------------------------------------------------------------
FROM nginx:alpine AS runtime

# 清空 nginx 默认站点，避免 default.conf 重复 listen 80
RUN rm -f /etc/nginx/conf.d/default.conf

COPY --from=build /app/packages/frontend/dist /usr/share/nginx/html
COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
