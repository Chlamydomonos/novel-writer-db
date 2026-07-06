# HTTP API

本文档定义后端需要为**前端**与 **MCP 服务器**共同依赖的 REST 接口。这是后续两个子系统的底座。

## 设计原则

- **统一响应**：成功 200 返回 JSON；失败按下方错误响应模型返回。
- **小说定位**：URL 路径中以 `/api/novels/:novelId` 前缀来定位小说（与 MCP 通过请求头定位形成对照）。
- **无认证**：本系统为本地辅助工具，不在文档中处理认证；如需暴露公网应另加反向代理。
- **正文传输**：以 `text/plain` 传输 markdown 正文，元数据以 `application/json`。
- **覆盖所有能力**：HTTP API 覆盖 `Novel` 类的全部公开方法（含 LLM 不可见的 `byID`/`listAll`/`create`/`rename`/`destroy`）。
- **类型单一来源**：所有请求/响应的 TypeScript 类型定义在 `@novel-writer/shared` 的 `dto.ts`，后端在 `http/` 层只写 Zod schema（运行时校验），不再重复声明同名接口。

## 路由总览

| 方法 | 路径 | 对应 `Novel` 方法 | 说明 |
| --- | --- | --- | --- |
| `GET`    | `/api/novels` | `listAll` | 列出全部小说 |
| `POST`   | `/api/novels` | `create` | 创建小说 |
| `GET`    | `/api/novels/:novelId` | `byID` | 获取小说基本信息 |
| `PATCH`  | `/api/novels/:novelId` | `rename` / `writeInfo` / `editInfo` | 修改小说元信息 |
| `DELETE` | `/api/novels/:novelId` | `destroy` | 删除小说 |
| `GET`    | `/api/novels/:novelId/list` | `list` | 列出某路径下的内容 |
| `GET`    | `/api/novels/:novelId/tree` | `listAsJson` | 以 JSON 形式列目录（仅一层） |
| `POST`   | `/api/novels/:novelId/read` | `read` | 批量读取文档 |
| `POST`   | `/api/novels/:novelId/write` | `write` | 写入（覆盖）文档 |
| `POST`   | `/api/novels/:novelId/edit` | `edit` | 正则替换编辑文档 |
| `POST`   | `/api/novels/:novelId/search` | `search` | 语义检索 |
| `DELETE` | `/api/novels/:novelId/documents` | `deleteDocument` | 删除文档 |
| `DELETE` | `/api/novels/:novelId/categories` | `deleteCategory` | 删除目录 |

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

| 异常 | 状态码 |
| --- | --- |
| `InvalidPathError`, `OutOfBoundsError` | `400` |
| `NotExistError` | `404` |
| `ExistError` | `409` |
| `EditFailError` | `422` |
| 其他 `Error` | `500` |

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

| Query | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 必填 | 绝对目录路径 |
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
  { "path": "/正文/序章.md",        "text": "..." }
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
[
  { "path": "/设定/世界/魔法体系.md", "text": "..." }
]
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

## 实作指引

### 文件与目录建议

```
packages/backend/src/
├── main.ts                       # 启动 HTTP server（如使用 Fastify/Express）
├── http/
│   ├── server.ts                 # 路由注册、错误中间件
│   ├── routes/
│   │   ├── novels.ts             # /api/novels*
│   │   ├── documents.ts          # read/write/edit/search/deleteDocument
│   │   └── categories.ts         # list/tree/deleteCategory
│   └── schemas.ts                # Zod schema（运行时校验），类型从 @novel-writer/shared 引入
└── lib/                          # 既有业务层
```

> DTO 类型已统一收敛至 `@novel-writer/shared`（`RootCategoryName`、`DocumentRef`、`SearchRequest` 等）；
> backend 内部不再重复声明接口类型，仅在 `http/schemas.ts` 用 Zod 描述运行时校验。
> 二者通过 `z.infer<typeof XxxZod>` 与 shared 的同名接口做合同约束，避免漂移。

### 错误映射中间件（建议）

```ts
function mapError(err: unknown) {
    if (err instanceof InvalidPathError || err instanceof OutOfBoundsError) return 400;
    if (err instanceof NotExistError) return 404;
    if (err instanceof ExistError)    return 409;
    if (err instanceof EditFailError) return 422;
    return 500;
}
```

### 中间件：解析小说实例

```ts
async function loadNovel(req, res, next) {
    const id = Number(req.params.novelId);
    try {
        req.novel = await Novel.byID(id);   // 不存在直接抛 NotExistError → 404
        next();
    } catch (e) { next(e); }
}
```

### HTTP 框架选型建议

- **Fastify**：性能好，schema 友好，与 Zod 适配。
- 若追求最少依赖可用 Node 原生 `http` + 手写路由（本项目体量允许）。

> 已安装 `zod ^4`，可用来定义所有请求/响应 schema 以复用至 MCP；其静态类型应引用 `@novel-writer/shared` 的同名接口。

## 预告

- MCP 服务器在 HTTP 入口之外，复用 **同一份** `Novel` 业务方法，工具集是其子集，详见 [MCP 服务器](./mcp-server.md)。
- 前端最终通过本节接口完成全部操作，详见 [前端](./frontend.md)。
