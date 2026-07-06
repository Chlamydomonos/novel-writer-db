# 部署

本文档说明如何把后端（HTTP API + MCP）与前端纳入 `docker-compose.yml` 整体编排。

## 现状

当前 `docker-compose.yml` 已编排两个**基础设施**容器：

| 服务 | 用途 | 是否暴露端口 |
| --- | --- | --- |
| `chroma` | 向量库 | `8000:8000` |
| `embedding` | Qwen3 嵌入（GPU） | 不暴露 |

两者位于自定义网络 `main` 中，通过服务名互访。

## 目标拓扑

```
            宿主机
              │
   ┌──────────┴────────────┐
   │ :3000  :80            │   对外
   ▼                       ▼
┌──────────────────────────────────┐
│ main 网络                          │
│                                    │
│  ┌──────────┐                      │
│  │ backend  │ ─── HTTP API + MCP   │
│  └────┬─────┘                      │
│       │   ┌─────────────┐          │
│       ├──►│ chroma      │          │
│       │   └─────────────┘          │
│       │   ┌─────────────┐          │
│       └──►│ embedding   │ (GPU)    │
│           └─────────────┘          │
│  ┌──────────┐                      │
│  │ frontend │ (静态托管 SPA)         │
│  └──────────┘                      │
└────────────────────────────────────┘
```

## 新增 compose 服务

### `backend`

后端**必须容器化**，因为代码以服务名访问 chroma/embedding（见 [技术架构](./architecture.md#运行时依赖外部服务)）。

```yaml
services:
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
      # 后端无需对外暴露 chroma/embedding 端口（仅服务内通信）
      NODE_ENV: production
      PORT: '3000'
    ports:
      - '3000:3000'
    volumes:
      # SQLite 存储路径在 db/sequelize.ts 中写死为 /data/db.sqlite3
      - ./local/backendData:/data
    networks:
      - main
```

> 注意：`db/sequelize.ts` 中 `storage: '/data/db.sqlite3'`，必须把宿主目录挂载到容器 `/data` 才能持久化。

### `frontend`

两种取法任选其一：

**A. 容器化 Nginx 托管静态产物**（推荐生产）

```yaml
  frontend:
    restart: unless-stopped
    build:
      context: .
      dockerfile: packages/frontend/Dockerfile
    container_name: frontend
    depends_on:
      - backend
    ports:
      - '80:80'
    networks:
      - main
```

Nginx 配置（`packages/frontend/nginx.conf`）将 `/api/*` 与 `/mcp` 反代到 `backend:3000`：

```nginx
location /api/ { proxy_pass http://backend:3000; }
location /mcp  { proxy_pass http://backend:3000; }
location / { try_files $uri $uri/ /index.html; }
```

**B. 后端直接托管**：后端在 `/` 提供 `packages/frontend/dist` 的静态文件，前端访问 `http://host:3000/`。无需额外服务，但耦合度高，仅推荐单机本地场景。

## Dockerfile 模板

### `packages/backend/Dockerfile`

```dockerfile
# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/backend ./packages/backend
RUN pnpm install --frozen-lockfile
RUN pnpm --filter backend build

# ---- runtime stage ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/packages/backend/package.json ./packages/backend/
COPY --from=build /app/packages/backend/dist ./packages/backend/dist
RUN corepack enable && pnpm install --frozen-lockfile --prod
EXPOSE 3000
CMD ["node", "packages/backend/dist/main.js"]
```

> SQLite 数据卷挂载到 `/data`，与 `db/sequelize.ts` 的 `storage` 一致。

### `packages/frontend/Dockerfile`

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/frontend ./packages/frontend
COPY packages/shared ./packages/shared   # 若使用 shared 包
RUN pnpm install --frozen-lockfile
RUN pnpm --filter frontend build

FROM nginx:alpine AS runtime
COPY --from=build /app/packages/frontend/dist /usr/share/nginx/html
COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

## pnpm workspace 注意事项

- `pnpm-workspace.yaml` 已声明 `packages: [packages/*]`，新增 `packages/frontend`（和可选的 `packages/shared`）会自动被识别
- Docker build 时务必把整个仓库根的 `pnpm-lock.yaml` 与 `pnpm-workspace.yaml` 一并 COPY 进去，以保持 lockfile 上下文一致
- `allowBuilds: sqlite3: true` 已在 workspace 配置中允许 native 构建，后端 Dockerfile 使用 alpine 时需安装 `python3 make g++`（用于编译 sqlite3 原生 binding），或换 `node:22-bookworm-slim`

### sqlite3 原生编译补充

```dockerfile
# build 阶段开头追加
RUN apk add --no-cache python3 make g++ sqlite-dev
```

## 环境变量约定

后端建议支持以下可配置项（在 `main.ts` 中读取），未设置则采用默认：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP / MCP 共用监听端口 |
| `MCP_PATH` | `/mcp` | MCP endpoint 路径 |
| `MCP_NOVEL_ID_HEADER` | `X-Novel-Id` | 目标小说请求头名 |
| `CHROMA_HOST` / `CHROMA_PORT` | `chroma` / `8000` | 向量库（容器内写死，可预留） |
| `EMBEDDING_BASE` | `http://embedding:8000/v1` | 嵌入服务 |

当前 `db/embedding.ts` 与 `db/chroma.ts` 是硬编码的，**部署文档建议在落地 PR 中把这两处改为读环境变量**，便于本地裸跑/迁移。

## 启动顺序与健康检查

```yaml
depends_on:
  chroma:
    condition: service_healthy
  embedding:
    condition: service_healthy
```

两个上游容器已配置 healthcheck，后端在二者就绪后启动，避免连接失败。

## 开发态快速启动

开发期不强制使用容器：

1. `docker compose up -d chroma embedding` —— 只启动基础设施
2. 修改 `db/chroma.ts` 与 `db/embedding.ts`，把 `chroma` 改为 `localhost`、`embedding` 改为 `localhost`
3. `pnpm install`
4. `pnpm --filter backend dev`（需自行加 dev 脚本，例如 `tsx watch src/main.ts`）
5. `pnpm --filter frontend dev` —— Vite 代理 `/api → localhost:3000`

## 验收清单

- [ ] `docker compose up` 可一键拉起 chroma / embedding / backend / frontend
- [ ] 访问 `http://localhost:80`（或 `:3000`）可进入前端
- [ ] `http://localhost:3000/api/novels` 返回 JSON
- [ ] MCP 客户端连 `http://localhost:3000/mcp` 并携带 `X-Novel-Id` 可成功调用工具
- [ ] 宿主机重启后，`./local/backendData` 与 `./local/chromaData` 持久化数据
