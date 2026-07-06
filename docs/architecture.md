# 技术架构

本文档描述系统的总体架构、模块边界与运行时依赖。读者在阅读其他实现文档前应先通读本文。

## 模块划分

```
novel-writer-db/                       # pnpm monorepo 根
├── docker-compose.yml                 # 编排 ChromaDB + embedding GPU 服务
├── pnpm-workspace.yaml                # 声明 packages/* 全部为 workspace 包
├── packages/
│   ├── shared/                        # ★ 前后端共享类型与常量
│   │   ├── package.json               #   name: @novel-writer/shared
│   │   └── src/
│   │       ├── index.ts               #   统一导出
│   │       └── dto.ts                 #   RootCategoryName、TreeNode、请求/响应 DTO
│   │
│   ├── backend/                       # 唯一后端工程：HTTP API + MCP 在同一进程
│   │   └── src/
│   │       ├── main.ts                # 启动 Fastify HTTP 服务（读取 PORT/HOST）
│   │       ├── http/                  # ★ HTTP API 层（基于 Fastify）
│   │       │   ├── server.ts          #   装配 app、注册路由、全局错误处理
│   │       │   ├── errors.ts          #   业务异常 → HTTP 状态码映射
│   │       │   ├── schemas.ts         #   Zod 运行时校验 schema
│   │       │   ├── types.d.ts         #   FastifyRequest.novel 字段扩展
│   │       │   └── routes/
│   │       │       ├── novels.ts      #   /api/novels* + 共享 loadNovelOrError hook
│   │       │       ├── documents.ts   #   read/write/edit/search/deleteDocument
│   │       │       └── categories.ts  #   list/tree/deleteCategory
│   │       └── lib/
│   │           ├── novel.ts           # ★ 已完成：核心业务逻辑（依赖 shared）
│   │           ├── errors.ts          # 已完成：业务异常
│   │           └── db/                # 已完成：Sequelize + Chroma 客户端
│   │               ├── sequelize.ts
│   │               ├── chroma.ts
│   │               ├── embedding.ts
│   │               └── models/
│   │                   ├── category.ts
│   │                   ├── document.ts
│   │                   └── novel.ts
│   │
│   └── frontend/                      # 计划中：Vue 3 SPA（引用 shared 类型）
│
└── docs/                              # 本文档目录
```

### 包依赖关系

```
        ┌─────────────────────────────┐
        │  @novel-writer/shared        │  纯类型与常量，无运行时依赖
        │  （dto.ts / index.ts）        │
        └───────┬───────────────┬──────┘
                │ workspace:*   │ workspace:*
                ▼               ▼
        ┌──────────────┐  ┌──────────────┐
        │   backend     │  │   frontend    │
        │ （HTTP + MCP）│  │  （Vue SPA）    │
        └──────────────┘  └──────────────┘
```

> `@novel-writer/shared` 通过 `exports` 字段暴露 `dist`，并由 `composite: true` 的 `tsconfig` 提供跨包类型校验；任意一方修改字段会立即在另一方 `tsc --noEmit` 时暴露漂移。

## 分层架构

````
            ┌────────────────────────────┐
            │  LLM / Agent（外部调用方）    │
            └────────────────────────────┘
                        │ MCP over HTTP
                        ▼
┌────────────────────────────────────────────────────────┐
│ packages/backend                                        │
│                                                          │
│  ┌──────────────────┐         ┌──────────────────┐     │
│  │  MCP 服务端       │         │  HTTP API 路由    │     │
│  │ (Streamable HTTP)│         │  (REST)           │     │
│  └─────────┬────────┘         └─────────┬────────┘     │
│            │       共享业务逻辑层         │              │
│            └────────────┬───────────────┘              │
│                         ▼                                │
│            ┌────────────────────────┐                   │
│            │  lib/novel.ts  Novel 类│  ← 核心能力        │
│            └─────────┬──────────────┘                   │
│                      │                                   │
│       ┌──────────────┴───────────────┐                  │
│       ▼                               ▼                  │
│ ┌──────────┐                  ┌──────────────┐         │
│ │ Sequelize│                  │   ChromaDB    │         │
│ │  (SQLite)│                  │   Client      │         │
│ └──────────┘                  └──────┬───────┘         │
└────────────────────────────────────────┼──────────────────┘
                                          │
                ┌─────────────────────────┼──────────────────┐
                │ docker-compose 编排的网络 │                  │
                ▼                          ▼                  │
        ┌──────────────┐         ┌──────────────────┐       │
        │ chroma 容器    │         │ embedding 容器     │       │
        │ (向量库)       │         │ llama.cpp server  │       │
        │               │         │ (Qwen3-Embedding) │       │
        └──────────────┘         └──────────────────┘       │

↕︎ 类型与常量在前后端之间共享
┌────────────────────────────────────────────────────────┐
│ packages/shared (@novel-writer/shared)                  │
│   RootCategoryName / ROOT_CATEGORY_NAMES / TreeNode     │
│   各 HTTP 端点的 Request/Response DTO / ApiErrorBody    │
└────────────────────────────────────────────────────────┘
        ▲                                   ▲
        │ workspace:*                       │ workspace:*
┌──────────────┐                  ┌──────────────────┐
│   backend     │                  │     frontend      │
│ (含 lib/novel)│                  │   （Vue 3 SPA）   │
└──────────────┘                  └──────────────────┘
````

> 后端 `lib/novel.ts` 已从 `@novel-writer/shared` 引入并再导出 `RootCategoryName`/`ROOT_CATEGORY_NAMES`，使既有 `import { RootCategoryName } from '../lib/novel.js'` 的调用方继续工作，同时保证类型单一来源。

## 进程模型

后端**单进程**，同时承载：

| 监听端口（建议） | 路径前缀 | 服务 |
| --- | --- | --- |
| `3000` | `/api/*` | HTTP REST API（供前端） |
| `3000` | `/mcp` | MCP Streamable HTTP endpoint |

> 两者共用同一个 HTTP 服务器，由路径与请求头分流；也可视情况拆为两端口。

### 为什么 HTTP 与 MCP 同进程

- 共享同一个 SQLite 连接池（当前 `pool.max = 1`，必须串行）
- 共享同一个 ChromaDB 客户端单例
- MCP 工具是 HTTP API 的薄包装，复用代码量小

## 运行时依赖（外部服务）

由 `docker-compose.yml` 提供，全部加入 `main` 自定义网络：

| 容器 | 用途 | 对外端口 | 内部地址 |
| --- | --- | --- | --- |
| `chroma` | 向量库 | `8000:8000` | `chroma:8000` |
| `embedding` | Qwen3 嵌入推理（GPU） | 不暴露 | `embedding:8000` |

注意：后端代码以**容器内服务名**访问两者（见 `db/embedding.ts` 的 `apiBase: 'http://embedding:8000/v1'` 与 `db/chroma.ts` 的 `host: 'chroma'`）。后端**必须容器化部署**或通过等同网络配置访问；本地裸跑需要先改这两处为 `localhost:8000` 并通过 `ports` 访问。

## 数据流向

### 写操作（`write`/`edit`/`deleteDocument` 等）

```
HTTP/MCP 入口
  └─> Novel.<method>()
        ├─> [事务] Sequelize 写元数据（Document/Category 行）
        └─> ChromaDB collection.{upsert,delete}()  写向量
```

> 注意：当前实现中 ChromaDB 的写入位于 Sequelize 事务体内，但 ChromaDB **不参与事务**。如果 ChromaDB 写入失败，Sequelize 提交已发生但向量未更新，需在文档 [数据模型](./data-model.md#事务与一致性) 中说明并考虑补偿。

### 读操作（`read`/`search`）

```
HTTP/MCP 入口
  └─> Novel.<method>()
        ├─> Sequelize 读元数据（拿到 documentId、categoryId 等）
        └─> ChromaDB collection.get() / collectionQuery()  取文本
```

### 语义检索（`search`）

1. 入参：`rootCategory ∈ {'设定','大纲','正文'}`、`texts[]`、`limit`
2. 通过根 category 名 → SQL 查出 `rootCategoryId`
3. 打开 `category#<rootCategoryId>` Chroma collection
4. `collection.query({ queryTexts, nResults })` —— Chroma 内部会调用 embeddingFunction 把 `texts` 编码为查询向量，再与库内向量比对
5. 由 `documentId` 反查路径（`Document` → `Category` 链 → `Novel`）拼接绝对路径返回

## 请求生命周期（HTTP API）

[→ 详细的接口定义见 HTTP API 文档](./http-api.md)

HTTP API 已基于 **Fastify** 落地（`packages/backend/src/http/`），三层职责清晰：

1. **错误映射**：`http/errors.ts` 的 `mapError()` 统一把 `lib/errors.ts` 业务异常映射为状态码，并在 `http/server.ts` 通过 `app.setErrorHandler` 兜底 handler 内未捕获的异常（Fastify 自身 schema 校验失败另回 `400`）。
2. **小说实例构造**：所有 `/:novelId` 路由共用 `loadNovelOrError` 预处理器，从 URL 参数解析后调用 `Novel.byID(id)`，并把实例挂到 `request.novel`；不存在时由 `byID` 抛 `NotExistError → 404`。
3. **JSON 序列化**：成功 200 返回 JSON，仅 `GET /list` 返回 `text/plain; charset=utf-8` 缩进文本，`PUT/DELETE` 类返回 `204 No Content`。

## 请求生命周期（MCP）

[→ 详细工具定义见 MCP 文档](./mcp-server.md)

- 入口解析自定义请求头（如 `X-Novel-Id`）
- 仅向 LLM 暴露受限工具集（不含 `create`/`destroy`/`rename` 等）
- 单个 endpoint 服务所有小说，由请求头切换目标

## 非功能性要求

| 维度 | 要求 |
| --- | --- |
| 语言/类型 | TS `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| 模块系统 | 原生 ESM（`"type": "module"`），import 必须带 `.js` 扩展名 |
| 类型共享 | 前后端共用以 `workspace:*` 协议依赖的 `@novel-writer/shared`，单一类型来源 |
| 部署形态 | 仅支持容器化（外部依赖通过服务名访问） |
| SQLite 模式 | WAL + `synchronous=NORMAL` + `busy_timeout=5000`（已设置） |
| SQLite 连接池 | `max=min=1`，所有写入串行 |
