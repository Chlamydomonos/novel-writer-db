# 部署

> ✅ **实现状态：已完成。** 本文档描述的 Docker Compose 编排方案已全部落地，可通过 `docker compose up` 一键启动全部服务。

本文档说明如何把 nginx（统一反向代理 + 静态托管）、后端（HTTP API + MCP）与前端（Vue SPA）纳入 `docker-compose.yml` 整体编排。整套对外**只发布一个端口**（默认宿主机 `:3912` → 容器内 nginx `:80`），其余服务全部收敛到 compose 内部网络 `main`。

## 设计原则

- **唯一出口**：`nginx` 容器是整个系统对外的唯一入口，宿主机只发布 `3912:80`（外部 `:3912` → 容器内 nginx `:80`）。
- **服务名内网通信**：`backend` / `chroma` / `embedding` 都只在 `main` 网络可达，不再向宿主机发布端口。
- **同源策略**：前端静态产物、`/api/*`、`/mcp` 全部由 nginx 同一域名 / 同一端口提供，前后端同源，避免 CORS。
- **请求头透传**：nginx 默认透传自定义头（如 `X-Novel-Id`），无需特殊配置。

## 与上一版方案差异

| 维度     | 旧方案                                            | 新方案                                           |
| -------- | ------------------------------------------------- | ------------------------------------------------ |
| 对外端口 | `3000`(backend) + `80`(frontend) + `8000`(chroma) | **仅 `3912`**(nginx)                             |
| backend  | `ports: 3000:3000`                                | 仅 `expose: 3000`，反代入口收敛到 nginx          |
| chroma   | `ports: 8000:8000`                                | 仅 `expose: 8000`，下线对外端口                  |
| frontend | 名为 frontend 的 nginx 容器，但后端 :3000 也对外  | 改名为 `nginx`，并成为唯一出口；后端不再发布端口 |

## 现状

当前 `docker-compose.yml` 已编排全部四个服务容器：

| 服务        | 用途                    | 对外端口                  |
| ----------- | ----------------------- | ------------------------- |
| `nginx`     | 前端静态托管 + 反向代理 | `3912:80`（唯一对外端口） |
| `backend`   | HTTP API + MCP          | 仅 `expose: 3000`         |
| `chroma`    | 向量库                  | 仅 `expose: 8000`         |
| `embedding` | Qwen3 嵌入（GPU）       | 不暴露                    |

四者位于自定义网络 `main` 中，通过服务名互访。

## 目标拓扑

```
                宿主机
                  │
              :3912（唯一对外端口，映射到容器内 :80）
                  ▼
        ┌─────────────────────┐
        │       nginx          │  前端 dist 静态托管 +
        │  （frontend 服务）     │  反代 /api、/mcp → backend:3000
        └──────────┬──────────┘
                   │ main 网络（仅 expose，不发布）
       ┌───────────┼───────────────────┐
       ▼           ▼                   ▼
 backend:3000  chroma:8000       embedding:8000
 (HTTP + MCP)  (向量库)           (Qwen3 嵌入, GPU)
```

请求分流（在 nginx 内）：

- `GET /`、`/assets/*` 等静态资源 → 前端 bundle `packages/frontend/dist`
- 任意方法 `/api/*` → 反代 `backend:3000`
- 任意方法 `/mcp` → 反代 `backend:3000`（保留请求头 + 关 buffering 支持流式）

## compose 服务

### `nginx`（唯一对外出口，承载前端 + 反向代理）

```yaml
services:
    nginx:
        restart: unless-stopped
        build:
            context: .
            dockerfile: packages/frontend/Dockerfile
        container_name: nginx
        depends_on:
            - backend
        ports:
            - '3912:80' # 宿主机 3912 → 容器 80；整个 compose 仅此一端口对外
        networks:
            - main
```

### `backend`

后端**不发布端口**，仅 `expose: 3000` 供同网络的 nginx 访问。后端必须容器化，因为代码以服务名访问 chroma/embedding（见 [技术架构](./architecture.md#运行时依赖外部服务)）。

```yaml
backend:
    restart: unless-stopped
    build:
        context: .
        dockerfile: packages/backend/Dockerfile
    container_name: backend
    depends_on:
        chroma:
            condition: service_healthy
        embedding:
            condition: service_healthy
    environment:
        NODE_ENV: production
        PORT: '3000'
        # 仍需 0.0.0.0：nginx 是另一个容器，不共享 backend 的 loopback
        HOST: '0.0.0.0'
    expose:
        - '3000'
    volumes:
        # SQLite 存储路径在 db/sequelize.ts 中写死为 /data/db.sqlite3
        - ./local/backendData:/data
    networks:
        - main
```

> 关键变化1：原方案 backend 发布 `3000:3000`，新方案改为只 `expose`，对外端口收敛到 nginx 的 `:3912`。注意 `HOST=0.0.0.0` 仍必须设置——nginx 与 backend 是**不同容器**，后者若只绑 `127.0.0.1`，nginx 将连不上。
>
> `db/sequelize.ts` 中 `storage: '/data/db.sqlite3'`，必须把宿主目录挂载到容器 `/data` 才能持久化。

### `chroma` / `embedding`

移除 `chroma` 的 `ports: 8000:8000`，仅保留 `expose: 8000`；`embedding` 本就不对外。两者只在 `main` 网络内可达。

```yaml
chroma:
    # …其余字段不变
    expose:
        - '8000'
    # 删除原 ports: ['8000:8000']
```

```yaml
embedding:
    # …其余字段不变（GPU、healthcheck、command 全部保留）
    expose:
        - '8000'
```

## nginx 配置

文件 `packages/frontend/nginx.conf`，构建时复制到镜像内 `/etc/nginx/conf.d/default.conf`：

```nginx
server {
    listen 80;
    server_name _;

    # 前端静态产物
    root /usr/share/nginx/html;
    index index.html;

    # 后端 REST API（前缀匹配；proxy_pass 末尾不加斜杠，保留 /api/ 前缀）
    location /api/ {
        proxy_pass http://backend:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # MCP Streamable HTTP endpoint（精确匹配，避免被 SPA fallback 拦截）
    location = /mcp {
        proxy_pass http://backend:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # MCP 可能使用 SSE / 长连接流式
        proxy_buffering    off;
        proxy_read_timeout 1h;
    }

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

要点：

- `location = /mcp` 用**精确匹配**，确保不被 `/` 兜底拦截；同时关闭 `proxy_buffering`、放宽 `proxy_read_timeout` 以支持流式响应。
- `/api/` 用前缀匹配，`proxy_pass http://backend:3000;`（末尾**不**加斜杠）会把完整路径（含 `/api/` 前缀）传给后端。
- 前端代码访问 `/api/*` 与 `/mcp` 用相对路径即可，与 nginx 同源，**无 CORS**。
- 自定义请求头 `X-Novel-Id` 在 nginx 默认透传范围内，无需额外 `proxy_set_header`。

## Dockerfile 模板

### `packages/backend/Dockerfile`

```dockerfile
# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app
# 编译 sqlite3 原生 binding 所需工具链
RUN apk add --no-cache python3 make g++ sqlite-dev
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/backend ./packages/backend
COPY packages/shared  ./packages/shared
RUN pnpm install --frozen-lockfile
RUN pnpm --filter backend build

# ---- runtime stage ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/packages/backend/package.json ./packages/backend/
COPY --from=build /app/packages/backend/dist ./packages/backend/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
RUN corepack enable && pnpm install --frozen-lockfile --prod
EXPOSE 3000
CMD ["node", "packages/backend/dist/main.js"]
```

> SQLite 数据卷挂载到 `/data`，与 `db/sequelize.ts` 的 `storage` 一致。
>
> runtime stage 不再需要 `python3/make/g++`（生产依赖中 sqlite3 已编译）。若 `pnpm install --prod` 仍触发 native 重建，可在 runtime 也加 `apk add python3 make g++ sqlite-dev`，或换用 `node:22-bookworm-slim`。

### `packages/frontend/Dockerfile`（即 nginx 镜像，容器内 `EXPOSE 80`；对外端口由 compose `3912:80` 映射）

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/frontend ./packages/frontend
COPY packages/shared  ./packages/shared   # 若前端引用 shared
RUN pnpm install --frozen-lockfile
RUN pnpm --filter frontend build

FROM nginx:alpine AS runtime
COPY --from=build /app/packages/frontend/dist /usr/share/nginx/html
COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

## 完整 `docker-compose.yml` 速览

```yaml
services:
    chroma:
        restart: unless-stopped
        image: chromadb/chroma:latest
        container_name: chroma
        volumes:
            - ./local/chromaData:/data
        expose: ['8000'] # ← 不再发布 8000:8000
        networks: [main]
        healthcheck: # 同现状
            { test: ['CMD-SHELL', "bash -c '...'"], interval: 10s, timeout: 5s, retries: 3 }

    embedding:
        restart: unless-stopped
        image: ghcr.io/ggml-org/llama.cpp:server-cuda
        container_name: embedding
        volumes: [./local/models:/models]
        expose: ['8000']
        networks: [main]
        deploy: # GPU 同现状
            resources:
                reservations:
                    devices:
                        - driver: nvidia
                          count: all
                          capabilities: [gpu]
        command: >
            -m /models/Qwen3-Embedding-0.6B-f16.gguf
            --host 0.0.0.0 --port 8000 --embedding --n-gpu-layers 99
        healthcheck:
            {
                test: ['CMD-SHELL', 'curl -f http://localhost:8000/health || exit 1'],
                interval: 10s,
                timeout: 5s,
                retries: 3,
                start_period: 30s,
            }

    backend:
        restart: unless-stopped
        build:
            context: .
            dockerfile: packages/backend/Dockerfile
        container_name: backend
        depends_on:
            chroma: { condition: service_healthy }
            embedding: { condition: service_healthy }
        environment:
            NODE_ENV: production
            PORT: '3000'
            HOST: '0.0.0.0'
        expose: ['3000'] # ← 不再发布 3000:3000
        volumes: [./local/backendData:/data]
        networks: [main]

    nginx: # ★ 唯一对外出口
        restart: unless-stopped
        build:
            context: .
            dockerfile: packages/frontend/Dockerfile
        container_name: nginx
        depends_on: [backend]
        ports: ['3912:80'] # 宿主机 3912 → 容器 80
        networks: [main]

networks:
    main:
```

## 启动顺序与健康检查

```yaml
backend:
    depends_on:
        chroma:
            condition: service_healthy
        embedding:
            condition: service_healthy

nginx:
    depends_on:
        - backend
```

chroma / embedding 都配置了 healthcheck，后端在二者就绪后启动，nginx 在后端就绪后启动；客户端首屏只接触 nginx，不会感知后端短暂未就绪。

## 环境变量约定

`main.ts` 当前已读取以下变量（其余 MCP 相关项待 MCP 阶段实现）：

| 变量                          | 默认                       | 说明                                                       | 状态      |
| ----------------------------- | -------------------------- | ---------------------------------------------------------- | --------- |
| `PORT`                        | `3000`                     | HTTP / MCP 共用监听端口                                    | ✅ 已实现 |
| `HOST`                        | `127.0.0.1`                | 监听地址；容器化时**必须** `0.0.0.0`（nginx 跨容器访问）   | ✅ 已实现 |
| `MCP_PATH`                    | `/mcp`                     | MCP endpoint 路径；nginx 中对应 `location = /mcp` 精确匹配 | ✅ 已实现 |
| `MCP_NOVEL_ID_HEADER`         | `X-Novel-Id`               | 目标小说请求头名；nginx 默认透传                           | ✅ 已实现 |
| `CHROMA_HOST` / `CHROMA_PORT` | `chroma` / `8000`          | 向量库（容器内服务名写死，可预留）                         | ⚠️ 硬编码 |
| `EMBEDDING_BASE`              | `http://embedding:8000/v1` | 嵌入服务                                                   | ⚠️ 硬编码 |

> nginx 反代时建议显式 `proxy_set_header Host $host;`，避免后端日志/校验拿到内部服务名 `backend`。`X-Novel-Id` 这类自定义头 nginx 默认透传，无需额外配置。
>
> `db/embedding.ts` 与 `db/chroma.ts` 当前仍硬编码服务名/地址；**建议在落地 PR 中把这两处改为读环境变量**，便于本地裸跑 / 迁移。

## 开发态快速启动

开发期不强制使用容器（无需 nginx）：

1. `docker compose up -d chroma embedding` —— 只启动基础设施（注意此时 chroma 无对外端口，可临时加 `ports: 8000:8000` override，或直接进入 backend dev 模式）
2. 修改 `db/chroma.ts` 与 `db/embedding.ts`，把 `chroma` / `embedding` 改为 `localhost`，并将 chroma 的 `ports` 临时打开
3. `pnpm install`
4. `pnpm --filter backend dev`（需自行加 dev 脚本，例如 `tsx watch src/main.ts`）
5. `pnpm --filter frontend dev` —— Vite 代理 `/api/* → http://localhost:3912/api/*`（即宿主机 nginx），由 nginx 二次反代到 backend；与生产路径完全一致

## 验收清单

- [x] `docker compose up` 可一键拉起 chroma / embedding / backend / nginx
- [x] `docker compose ps` 中**只有 nginx** 发布宿主机端口（`3912:80`），backend / chroma / embedding 均无 `ports`
- [x] 访问 `http://localhost:3912` 可进入前端
- [x] `http://localhost:3912/api/novels` 返回 JSON（经 nginx 反代到 backend）
- [x] MCP 客户端连 `http://localhost:3912/mcp` 并携带 `X-Novel-Id` 可成功调用工具
- [x] 宿主机重启后，`./local/backendData` 与 `./local/chromaData` 持久化数据

## pnpm workspace 注意事项

- `pnpm-workspace.yaml` 已声明 `packages: [packages/*]`，新增 `packages/frontend`（和可选的 `packages/shared`）会自动被识别
- Docker build 时务必把整个仓库根的 `pnpm-lock.yaml` 与 `pnpm-workspace.yaml` 一并 COPY 进去，以保持 lockfile 上下文一致
- `allowBuilds: sqlite3: true` 已在 workspace 配置中允许 native 构建，后端 Dockerfile 使用 alpine 时需安装 `python3 make g++`（用于编译 sqlite3 原生 binding），或换 `node:22-bookworm-slim`
