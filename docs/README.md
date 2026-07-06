# 项目总览

`novel-writer-db` 是一个用于辅助小说写作的**向量化知识库**。它以目录树的形式组织小说的设定、大纲和正文，并基于 ChromaDB 提供语义检索能力，配合本地部署的 Qwen3 嵌入模型实现端到端的向量编码。

## 项目目标

工作区当前已完成核心业务逻辑（`packages/backend/src/lib/novel.ts`），后续需实现两个对外暴露能力的子系统：

| 子系统 | 协议 | 说明 |
| --- | --- | --- |
| **MCP 服务器** | HTTP（Streamable HTTP） | 供 LLM/Agent 工具调用，**仅限编辑**指定小说的内容；小说 ID 通过 HTTP 请求头传入。 |
| **HTTP API + Vue 前端** | HTTP（REST） | 供人工通过 Web 界面调用所有接口，进行小说的全生命周期管理。 |

## 技术栈

- **运行时**：Node.js（ESM）
- **语言**：TypeScript（`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）
- **包管理**：pnpm workspace（monorepo）
- **关系数据库**：SQLite（经 Sequelize 7 alpha 持久化元数据）
- **向量数据库**：ChromaDB
- **嵌入模型**：Qwen3-Embedding-0.6B（gguf，由 llama.cpp 提供 OpenAI 兼容接口，GPU 加速）
- **MCP**：`@modelcontextprotocol/sdk` + `zod`
- **前端**：Vue 3（计划中）

> 详见 [技术架构](./architecture.md)。

## 目录约定

每个小说创建时，自动生成三个**根目录**（root category），它们的名称固定且不可删除：

| 名称 | 中文含义 | 典型用途 |
| --- | --- | --- |
| `设定` | 世界观/角色/物品 | 存放小说世界观、人物卡等元数据 |
| `大纲` | 故事结构 | 存放分卷、章节大纲 |
| `正文` | 正文内容 | 存放实际章节文本 |

所有根目录下均可创建任意层级的子目录（非根 category）和 markdown 文档（`.md`）。向量索引按**根目录**粒度建立（ChromaDB collection 名为 `category#<rootCategoryId>`）。详见 [数据模型](./data-model.md)。

## 进度路线图

后续工作分为四个阶段，对应文档如下：

1. **HTTP API 层** —— 把 `Novel` 类的能力包装成 REST 接口，作为前端与 MCP 共用的底座。详见 [HTTP API](./http-api.md)。
2. **MCP 服务器** —— 在 HTTP API 之上，暴露受限工具集给 LLM。详见 [MCP 服务器](./mcp-server.md)。
3. **Vue 前端** —— 通过 HTTP API 完成可视化全功能管理。详见 [前端](./frontend.md)。
4. **容器化与部署** —— 把后端/前端一并纳入 `docker-compose.yml`。详见 [部署](./deployment.md)。

## 关键设计决策

- **能力分层**：`Novel` 类中明确区分了"暴露给 LLM"和"不暴露给 LLM"两组方法。前端 HTTP API 应覆盖全部能力；MCP 服务器只暴露前者。这是为了防止 LLM 通过工具调用越权（例如创建/删除小说）。
- **小说 ID 注入**：MCP 服务器无状态，其在每次请求时通过 HTTP 请求头读取目标小说 ID，构造对应的 `Novel` 实例后再调用方法。这意味着单个 MCP endpoint 即可服务所有小说。
- **向量按根目录分库**：避免设定/大纲/正文之间相互污染检索结果，同时使 `search` 工具可以按 `rootCategory` 限定检索范围。
