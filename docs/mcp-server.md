# MCP 服务器

本文档定义将 `Novel` 类能力暴露给 LLM/Agent 的 **MCP HTTP 服务器**。

## 设计目标

| 关注点 | 决策 |
| --- | --- |
| 传输协议 | **Streamable HTTP**（MCP spec 单 endpoint，POST + SSE 流） |
| 目标小说 | 通过 HTTP 自定义请求头 `X-Novel-Id` 注入 |
| 暴露范围 | **仅"暴露给 LLM"的能力**（即代码中**未**带 `// 该接口不暴露给LLM` 注释的方法） |
| 部署形态 | 与 HTTP API 同进程，不同路径（如 `/mcp`） |

## 暴露的工具白名单

依据 `novel.ts` 中各方法的注释，**暴露给 LLM** 的方法为：

| `Novel` 方法 | 对应 MCP 工具 | 暴露原因 |
| --- | --- | --- |
| `writeInfo(newInfo)` | `write_info` | 修改小说基本信息 |
| `editInfo(regex, replace, flags)` | `edit_info` | 正则编辑小说基本信息 |
| `list(path, recursive)` | `list` | 列出目录 |
| `read(paths)` | `read_documents` | 批量读文档 |
| `search(rootCategory, texts, limit)` | `search` | 语义检索 |
| `write(path, text)` | `write_document` | 写文档（创建/覆盖） |
| `edit(path, regex, replace, flags)` | `edit_document` | 正则替换编辑文档 |
| `deleteDocument(path)` | `delete_document` | 删除文档 |
| `deleteCategory(path)` | `delete_category` | 删除目录（非根） |

**禁止暴露**（带 `// 该接口不暴露给LLM` 注释）：

- `Novel.byID` / `Novel.listAll` / `Novel.create` —— 创建/枚举小说的管理操作
- `Novel.rename` / `Novel.destroy` —— 重命名/删除小说
- `Novel.listAsJson` —— 内部接口，仅供前端使用

> MCP 工具不调用 `listAsJson`；前端如需 JSON 目录树直接走 HTTP `/tree`。

## 工具详细定义

所有工具均无 `novelId` 形参——目标小说完全由请求头 `X-Novel-Id` 决定（见 [请求头与小说绑定](#请求头与小说绑定)）。

### `write_info`

整体覆盖小说的 `info` 字段。

| 入参 | 类型 | 说明 |
| --- | --- | --- |
| `info` | string | 新的小说基本信息全文 |

成功返回：`{ name: string, info: string }`。

### `edit_info`

对 `info` 字段做正则替换。

| 入参 | 类型 | 说明 |
| --- | --- | --- |
| `regex` | string | 正则表达式源 |
| `replace` | string | 替换字符串 |
| `flags` | string? | 可选正则标志 |

成功返回：`{ name: string, info: string }`；若替换前后无变化，返回 `EditFailError`。

### `list`

列出某路径下的内容。返回**单行字符串**（与 `Novel.list` 一致），仅含 emoji、缩进与名称，不返回文档正文。

| 入参 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 绝对目录路径，如 `/设定` |
| `recursive` | boolean | 默认 `false`；递归最大深度 5 |

返回：`{ text: string }`，多行文本（含换行）。建议工具描述中解释 emoji 含义。

### `read_documents`

批量读取 markdown 文档正文。

| 入参 | 类型 | 说明 |
| --- | --- | --- |
| `paths` | string[] | 绝对文件路径数组，每个必须以 `.md` 结尾；至少 1 个 |

返回：`{ path: string, text: string }[]`。

### `search`

语义检索。

| 入参 | 类型 | 说明 |
| --- | --- | --- |
| `rootCategory` | `'设定' \| '大纲' \| '正文'` | 检索根目录 |
| `texts` | string[] | 查询文本数组，至少 1 个 |
| `limit` | number | `1 ≤ x ≤ 20` |

返回：`{ path: string, text: string }[]`。

### `write_document`

整体覆盖（或创建）一个 `.md` 文档；中间目录会自动创建；**禁止写入根目录本身**。

| 入参 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 绝对文件路径 |
| `text` | string | 完整正文 |

返回：成功 `{ ok: true }` 或空。

### `edit_document`

正则替换编辑指定文档。

| 入参 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 绝对文件路径 |
| `regex` | string | 正则源 |
| `replace` | string | 替换文本 |
| `flags` | string? | 可选 |

返回：成功空；无变化抛 `EditFailError`。

### `delete_document`

删除一个 `.md` 文档。

| 入参 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 绝对文件路径 |

返回：成功空。

### `delete_category`

删除一个**非根**目录及其下全部内容（递归）。

| 入参 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 绝对目录路径 |

返回：成功空；若为根目录则抛 `InvalidPathError`。

## 请求头与小说绑定

MCP 协议中 session 一旦建立即可复用，但本系统**单次请求即绑定小说**。约定：

- 自定义请求头：`X-Novel-Id: <number>`
- 服务端在每次工具调用前从上下文中取 `novelId`，调用 `Novel.byID(novelId)` 实例化后再执行
- 若 `X-Novel-Id` 缺失或非数字 → 返回 `400 Bad Request` 的 MCP error
- 若对应小说不存在 → `Novel.byID` 抛 `NotExistError` → MCP error `Resource not found`

> 注意：MCP 协议将"工具可调用"建模在 session 内。即便客户端在多轮对话中保持同一 session，每次工具调用依然会重新读取最新的 `X-Novel-Id`，从而允许客户端中途切换目标小说。

### Trace 示意

```
Client                                 Server (POST /mcp)
  │   tools/call search                    │
  │   header: X-Novel-Id: 3                │
  ├──────────────────────────────────────► │
  │                                        │ const novel = await Novel.byID(3);
  │                                        │ await novel.search('设定', [...], 10);
  │   ◄────────────────────────────────────┤  result
```

## 共享 schema

所有入参 schema 建议使用 **zod** 定义，与 HTTP API 共用同一份 `dto.ts`。例如：

```ts
import { z } from 'zod';

export const RootCategoryNameZod = z.enum(['设定', '大纲', '正文']);

export const SearchSchema = z.object({
    rootCategory: RootCategoryNameZod,
    texts: z.array(z.string()).min(1),
    limit: z.number().int().min(1).max(20),
});

export const ReadSchema = z.object({
    paths: z.array(z.string()).min(1),
});
```

`@modelcontextprotocol/sdk` 提供把 zod schema 直接转为工具 `inputSchema` 的便捷方法，避免手工 OpenAPI 表达。

## 文件与目录建议

```
packages/backend/src/
├── main.ts                  # 启动 HTTP server，挂载 /api 与 /mcp
├── http/                    # 详见 http-api.md
└── mcp/
    ├── server.ts            # 创建 McpServer，注册 tools
    ├── tools.ts             # 工具定义列表（名字/描述/zod schema/处理函数）
    └── context.ts           # 从请求头解析 novelId → Novel 实例（per-call）
```

## 工具描述建议（写给 LLM 看）

工具的 `description` 字段是 LLM 决策能力边界的唯一来源，应**显式说明**：

- 路径是绝对路径、根目录三选一
- `.md` 文件限制、写根目录禁止
- emoji 约定（`🗂️/📁/📂/📄`）

示例（节选）：

```text
list：列出指定目录下的内容。返回多行文本，每行格式 `<emoji> <name>`，
其中 🗂️ 表示非空目录、📁 表示空目录、📂 表示深度未知目录、📄 表示 markdown 文档。
path 必须为绝对路径（如 `/设定`）。recursive 为 true 时向下递归最多 5 层。
```

## 安全与边界

- 工具中**不应**暴露任何能跨小说操作的能力（创建/删除/列出其它小说）。
- 服务端需要在工具调用前再做一次"目标路径所属根目录确实在该 novel 名下"的校验——虽然 `Novel.findCategory` 已经按 `novelId == this.id` 过滤顶层根目录，但工具层不应假设调用方传入的 path 合法。
- 由于 MCP 工具是 LLM 触发，强烈建议把 `edit*` 类操作的失败（包括 `EditFailError`）原样回传给 LLM，以便其重试或放弃。

## 部署与配置

| 项 | 默认值 | 说明 |
| --- | --- | --- |
| `MCP_PATH` | `/mcp` | 单 endpoint 路径 |
| `MCP_NOVEL_ID_HEADER` | `X-Novel-Id` | 自定义请求头名（便于反向代理规范） |

启动后可通过 `mcp-inspector` 或兼容的 MCP 客户端连接 `http://host:3000/mcp` 测试，请求头携带 `X-Novel-Id: 1`。

## 与 HTTP API 的对照

| MCP 工具 | 等价 HTTP API | 备注 |
| --- | --- | --- |
| `list` | `GET /api/novels/:id/list` | 入参等价 |
| `read_documents` | `POST /api/novels/:id/read` | |
| `search` | `POST /api/novels/:id/search` | |
| `write_document` | `POST /api/novels/:id/write` | |
| `edit_document` | `POST /api/novels/:id/edit` | |
| `delete_document` | `DELETE /api/novels/:id/documents` | |
| `delete_category` | `DELETE /api/novels/:id/categories` | |
| `write_info` | `PATCH /api/novels/:id` (body.info) | |
| `edit_info` | `PATCH /api/novels/:id` (body.infoEdit) | |
| —（不暴露） | `GET/POST /api/novels`、`DELETE /api/novels/:id` | 仅前端可见 |
