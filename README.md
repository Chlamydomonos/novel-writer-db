# novel-writer-db

一个用于辅助小说写作的**向量化知识库**。以目录树的形式组织小说的设定、大纲和正文，并基于 ChromaDB 提供语义检索能力，配合本地部署的 Qwen3 嵌入模型实现端到端的向量编码。

同时对外暴露两套接口：

- **HTTP REST API + Vue 前端** —— 供人工通过 Web 界面对小说进行全生命周期管理。
- **MCP 服务器（Streamable HTTP）** —— 供 LLM / Agent 工具调用，**仅限编辑**指定小说的内容；目标小说 ID 通过 HTTP 请求头注入。

## 技术栈

| 层            | 技术                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------ |
| 运行时 / 语言 | Node.js（ESM）+ TypeScript（`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`） |
| 包管理        | pnpm workspace（monorepo）                                                                       |
| 后端框架      | Fastify                                                                                          |
| 关系数据库    | SQLite（经 Sequelize 7 alpha 持久化元数据）                                                      |
| 向量数据库    | ChromaDB                                                                                         |
| 嵌入模型      | Qwen3-Embedding-0.6B（`gguf`，由 llama.cpp 提供 OpenAI 兼容接口，GPU 加速）                      |
| MCP           | `@modelcontextprotocol/server` + `/node` + `/fastify`（v2 beta）+ `zod`                          |
| 前端          | Vue 3 `<script setup>` + Vite 8 + Pinia + vue-router + Element Plus（按需引入）                  |

## 仓库结构

```
novel-writer-db/
├── docker-compose.yml        # 全栈编排：chroma / embedding / backend / nginx(frontend)
├── pnpm-workspace.yaml
├── docs/                     # 设计文档（架构 / 数据模型 / HTTP API / MCP / 前端 / 部署）
├── local/                    # 本地持久化数据（sqlite、chroma、models）
└── packages/
    ├── shared/               # @novel-writer/shared：前后端共享的 DTO / Zod schema
    ├── backend/              # Fastify + Sequelize + ChromaDB + MCP 服务器
    │   ├── src/http/         # REST 路由、schema、错误映射
    │   ├── src/lib/          # 业务核心（Novel 类）、DB 模型、向量库
    │   └── src/mcp/          # MCP 工具注册与服务端装配
    └── frontend/             # Vue 3 SPA，构建为静态资源由 nginx 提供服务
```

## 核心设计

- **目录约定**：每个小说创建时自动生成三个**根目录**（名称固定不可删除）——`设定`（世界观/角色/物品）、`大纲`（故事结构）、`正文`（章节文本）。根目录下可创建任意层级的子目录与 markdown 文档。
- **向量按根目录分库**：ChromaDB collection 名为 `category#<rootCategoryId>`，避免设定 / 大纲 / 正文之间相互污染检索结果，`search` 可按根目录限定范围。
- **能力分层**：`Novel` 类区分"暴露给 LLM"与"不暴露给 LLM"两组方法。HTTP API 覆盖全部能力，MCP 仅暴露受限工具集，防止 LLM 越权（如创建 / 删除小说）。
- **小说 ID 注入**：MCP 服务器无状态，每次请求通过 HTTP 请求头（`X-Novel-Id`，可由 `MCP_NOVEL_ID_HEADER` 环境变量覆盖）读取目标小说 ID，构造对应 `Novel` 实例后调用方法——单个 MCP endpoint 即可服务所有小说。

## 快速开始

### 先决条件

- [Docker](https://www.docker.com/) + Docker Compose（**推荐**，最简单的方式）
- 若使用 NVIDIA GPU 加速嵌入服务，需安装 [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/)
- 准备好 Qwen3 嵌入模型文件，放置于 `local/models/Qwen3-Embedding-0.6B-f16.gguf`

### 一键启动

```bash
docker-compose up -d --build
```

启动后：

| 服务              | 端口                      | 说明                                              |
| ----------------- | ------------------------- | ------------------------------------------------- |
| **nginx（前端）** | 宿主机 `3912` → 容器 `80` | **唯一对外出口**，提供 SPA、代理 `/api` 与 `/mcp` |
| backend           | 仅内部 `expose`           | Fastify REST + MCP                                |
| chroma            | 仅内部 `expose`           | 向量数据库                                        |
| embedding         | 仅内部 `expose`           | llama.cpp 嵌入服务（GPU 加速）                    |

在浏览器打开 `http://localhost:3912` 即可使用 Web 界面。LLM / Agent 可通过 `http://localhost:3912/mcp` 接入 MCP（需在请求头中携带目标小说 ID）。

### 本地开发（可选）

```bash
pnpm install                 # 安装全部 workspace 依赖
pnpm --filter backend dev    # 后端开发
pnpm --filter frontend dev   # 前端开发（vite proxy 默认指向 :3912）
```

## 文档

完整设计文档位于 [`docs/`](./docs)：

- [项目总览](./docs/README.md)
- [技术架构](./docs/architecture.md)
- [数据模型](./docs/data-model.md)
- [HTTP API](./docs/http-api.md)
- [MCP 服务器](./docs/mcp-server.md)
- [前端](./docs/frontend.md)
- [部署](./docs/deployment.md)
