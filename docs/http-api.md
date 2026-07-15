# HTTP API

> ✅ **实现状态：已完成。** HTTP 层已基于 Fastify v5 落地于 `packages/backend/src/http/`，覆盖 `Novel` 类的全部公开方法。

本文档定义后端为**前端**与 **MCP 服务器**共同依赖的 REST 接口——它是后续两个子系统的底座。**HTTP 层已基于 Fastify v5 落地**（实作指引见文末），本章同时作为该层的契约说明。

## 设计原则

- **统一响应**：成功 200 返回 JSON；失败按下方错误响应模型返回。
- **小说定位**：URL 路径中以 `/api/novels/:novelId` 前缀来定位小说（与 MCP 通过请求头定位形成对照）。
- **无认证**：本系统为本地辅助工具，不在文档中处理认证；如需暴露公网应另加反向代理。
- **正文传输**：以 `text/plain` 传输 markdown 正文，元数据以 `application/json`。
- **覆盖所有能力**：HTTP API 覆盖 `Novel` 类的全部公开方法（含 LLM 不可见的 `byID`/`listAll`/`create`/`rename`/`destroy`）。
- **类型单一来源**：所有请求/响应的 TypeScript 类型定义在 `@novel-writer/shared` 的 `dto.ts`，后端在 `http/` 层只写 Zod schema（运行时校验），不再重复声明同名接口。

## 路由总览

| 方法     | 路径                              | 对应 `Novel` 方法                   | 说明                         |
| -------- | --------------------------------- | ----------------------------------- | ---------------------------- |
| `GET`    | `/api/novels`                     | `listAll`                           | 列出全部小说                 |
| `POST`   | `/api/novels`                     | `create`                            | 创建小说                     |
| `GET`    | `/api/novels/:novelId`            | `byID`                              | 获取小说基本信息             |
| `PATCH`  | `/api/novels/:novelId`            | `rename` / `writeInfo` / `editInfo` | 修改小说元信息               |
| `DELETE` | `/api/novels/:novelId`            | `destroy`                           | 删除小说                     |
| `GET`    | `/api/novels/:novelId/list`       | `list`                              | 列出某路径下的内容           |
| `GET`    | `/api/novels/:novelId/tree`       | `listAsJson`                        | 以 JSON 形式列目录（仅一层） |
| `POST`   | `/api/novels/:novelId/categories` | `createCategory`                    | 创建空目录                   |
| `POST`   | `/api/novels/:novelId/read`       | `read`                              | 批量读取文档                 |
| `POST`   | `/api/novels/:novelId/write`      | `write`                             | 写入（覆盖）文档             |
| `POST`   | `/api/novels/:novelId/edit`       | `edit`                              | 正则替换编辑文档             |
| `POST`   | `/api/novels/:novelId/search`     | `search`                            | 语义检索                     |
| `DELETE` | `/api/novels/:novelId/documents`  | `deleteDocument`                    | 删除文档                     |
| `DELETE` | `/api/novels/:novelId/categories` | `deleteCategory`                    | 删除目录                     |

## 错误响应

所有错误统一格式：

```json
{
    "error": {
        "type": "NotExistError",
        "message": "ID为3的小说不存在"
    }
}
```

状态码映射（与 [数据模型](./data-model.md#业务异常映射) 一致）：

| 异常                                   | 状态码 |
| -------------------------------------- | ------ |
| `InvalidPathError`, `OutOfBoundsError` | `400`  |
| `NotExistError`                        | `404`  |
| `ExistError`                           | `409`  |
| `EditFailError`                        | `422`  |
| 其他 `Error`                           | `500`  |

## 接口详情

### 列出全部小说

```
GET /api/novels
```

响应：

```json
[
    { "id": 1, "name": "三体" },
    { "id": 2, "name": "冰与火之歌" }
]
```

### 创建小说

```
POST /api/novels
Content-Type: application/json

{ "name": "三体" }
```

响应：

```json
{ "id": 1, "name": "三体", "info": "" }
```

> `Novel.create` 已在内部初始化 `设定/大纲/正文` 三个根目录与对应的 Chroma collection。

### 获取小说基本信息

```
GET /api/novels/:novelId
```

响应：

```json
{ "id": 1, "name": "三体", "info": "硬科幻" }
```

### 修改小说元信息（`PATCH` 合并语义）

```
PATCH /api/novels/:novelId
Content-Type: application/json

{
  "name": "新名称",         // 可选，触发 rename
  "info": "...",           // 可选，触发 writeInfo（整体覆盖）
  "infoEdit": {            // 可选，触发 editInfo（与 info 二选一）
    "regex": "旧",
    "replace": "新",
    "flags": "g"
  }
}
```

响应：同 `GET /api/novels/:novelId`。

### 删除小说

```
DELETE /api/novels/:novelId
```

响应：`204 No Content`。详见 [数据模型 - destroy 注意事项](./data-model.md#事务与一致性)。

### 列出某路径下的内容（人类可读）

```
GET /api/novels/:novelId/list?path=/设定&recursive=true
```

| Query       | 类型    | 默认    | 说明                       |
| ----------- | ------- | ------- | -------------------------- |
| `path`      | string  | 必填    | 绝对目录路径               |
| `recursive` | boolean | `false` | 是否递归；递归最大深度为 5 |

返回 `text/plain`，行格式见 `Novel.list`：

```
🗂️ 世界
  📄 人物卡.md
  📁 地理
```

### 以 JSON 列目录（仅一层）

```
GET /api/novels/:novelId/tree?path=/设定
```

响应：

```json
[
    { "type": "category", "name": "世界" },
    { "type": "document", "name": "序章.md" }
]
```

### 创建空目录

```
POST /api/novels/:novelId/categories
Content-Type: application/json

{ "path": "/设定/世界/地理" }
```

响应：`204 No Content`。

- 仅允许在三个根目录下创建（`/设定`、`/大纲`、`/正文`）。
- 路径可包含不存在的中间目录，后端会逐级创建。
- 若目标目录已存在，返回 `409 ExistError`。

### 批量读取文档

```
POST /api/novels/:novelId/read
Content-Type: application/json

{ "paths": ["/设定/世界/人物卡.md", "/正文/序章.md"] }
```

响应：

```json
[
    { "path": "/设定/世界/人物卡.md", "text": "..." },
    { "path": "/正文/序章.md", "text": "..." }
]
```

### 写入文档（覆盖）

```
POST /api/novels/:novelId/write
Content-Type: application/json

{ "path": "/设定/世界/人物卡.md", "text": "完整正文" }
```

响应：`204 No Content`。自动创建中间目录，但**禁止写入根目录本身**（路径必须 `splitted.length >= 2`）。

### 正则编辑文档

```
POST /api/novels/:novelId/edit
Content-Type: application/json

{
  "path": "/正文/序章.md",
  "regex": "旧时代",
  "replace": "新纪元",
  "flags": "g"
}
```

响应：`204 No Content`；若替换前后无变化则按 `EditFailError` 返回 `422`。

### 语义检索

```
POST /api/novels/:novelId/search
Content-Type: application/json

{
  "rootCategory": "设定",
  "texts": ["魔法的代价"],
  "limit": 10
}
```

响应：

```json
[{ "path": "/设定/世界/魔法体系.md", "text": "..." }]
```

### 删除文档

```
DELETE /api/novels/:novelId/documents?path=/正文/序章.md
```

响应：`204 No Content`。

### 删除目录

```
DELETE /api/novels/:novelId/categories?path=/设定/废弃
```

响应：`204 No Content`。**禁止删除根目录**。

## 实作指引（已落地）

HTTP API 已基于 **Fastify v5** 实现，文件布局如下（与 [技术架构](./architecture.md#模块划分) 一致）：

```text
packages/backend/src/
├── main.ts                       # 启动 Fastify server：读取 PORT/HOST 后 listen
├── http/
│   ├── server.ts                 #   buildApp()：注册路由 + setErrorHandler
│   ├── errors.ts                 #   mapError / sendError：业务异常 → 状态码 + 错误体
│   ├── schemas.ts                #   Zod 运行时校验 schema
│   ├── types.d.ts                #   FastifyRequest.novel 字段扩展声明
│   └── routes/
│       ├── novels.ts             # /api/novels* + 共享 loadNovelOrError 预处理
│       ├── documents.ts          # read/write/edit/search/deleteDocument
│       └── categories.ts         # list/tree/deleteCategory
└── lib/                          # 既有业务层
```

> 单一类型来源：所有请求/响应的静态类型在 `@novel-writer/shared/dto.ts` 定义；
> 后端 `http/schemas.ts` 只用 Zod 描述运行时校验，二者通过 `z.infer<typeof XxxZod>` 与同名 DTO 接口在 handler 形参/返回类型处彼此约束，防止漂移。
> （受项目 `exactOptionalPropertyTypes` 影响，schema 不再使用 `satisfies z.ZodType<DTO>`，改为在路由处显式标注类型。）

### 错误映射：`setErrorHandler`

全局兜底放在 `http/server.ts`，封装于 `http/errors.ts`：

```ts
app.setErrorHandler((err, _request, reply) => {
    if (err instanceof Error && 'validation' in err) {
        return reply.code(400).send({ error: { type: 'InvalidPathError', message: err.message } });
    }
    return sendError(reply, err); // 内部按 mapError 选 400/404/409/422/500
});
```

`mapError` 返回 `{ status, body: ApiErrorBody }`，状态码映射见 [错误响应](#错误响应)。

### 预处理器：解析小说实例

所有 `:novelId` 路由复用 `loadNovelOrError`（`routes/novels.ts` 导出）：

```ts
const withNovel = { preHandler: loadNovelOrError };

app.get('/api/novels/:novelId', { ...withNovel }, (request) => detailOf(request.novel!));
```

其内部 `Number(params.novelId)` 后调用 `Novel.byID(id)`，把实例挂到 `request.novel`；非正整数 → `400 InvalidPathError`，小说不存在 → `404 NotExistError`，均直接 `reply.send` 终止。

### 校验流程

每个 handler 入口先用 `schema.safeParse(request.body)`，失败时回送 `400 InvalidPathError`（错误体复用同一外壳，`message` 为 Zod 错误树）。业务层的语义校验（如 `limit` 上下限）则抛 `OutOfBoundsError` 由全局处理器接管。

### 启动方式

```bash
pnpm --filter backend build
node packages/backend/dist/main.js   # 默认 127.0.0.1:3000；PORT / HOST 可由环境变量覆盖
```

可立即 `curl http://127.0.0.1:3000/api/novels` 验证。

## 关联子系统

- MCP 服务器在 HTTP 入口之外，复用 **同一份** `Novel` 业务方法，工具集是其子集，详见 [MCP 服务器](./mcp-server.md)。
- 前端通过本节接口完成全部操作，详见 [前端](./frontend.md)。
