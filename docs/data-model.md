# 数据模型

本文档梳理数据存储结构，是 HTTP API、MCP 工具设计的前置约束。

## 关系层：Sequelize 模型

三个 Sequelize 模型位于 `packages/backend/src/lib/db/models/`，全部 `timestamps: false`。

### `Novel`（`models/novel.ts`）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | INTEGER | PK, AUTO_INCREMENT | |
| `name` | STRING | NOT NULL | 小说名，**唯一性不在表约束层**，由业务层 `Novel.create` 检查 |
| `info` | STRING | NOT NULL, DEFAULT `''` | 小说基本信息（自由文本） |

关系：`HasMany(Category)`，外键 `novelId` `ON DELETE CASCADE`。

### `Category`（`models/category.ts`）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | INTEGER | PK, AUTO_INCREMENT | |
| `name` | STRING | NOT NULL | 目录名 |
| `novelId` | INTEGER | nullable | **仅顶层（根）Category** 拥有，指向所属 Novel |
| `parentId` | INTEGER | nullable | **仅非顶层 Category** 拥有，指向父 Category |

> ⚠️ `novelId` 与 `parentId` 是**互斥**的：根目录用 `novelId`，子目录用 `parentId`。代码中通过"先查 `parentId`，未命中再查 `novelId`"的方式区分层级（见 `Novel.findCategory`）。设计新接口时需沿用此约定。

关系：
- `BelongsTo(Novel)`（外键 `novelId` `ON DELETE CASCADE`）
- `BelongsTo(Category)` 作为 parent（自引用）
- `HasMany(Category)` 作为 children
- `HasMany(Document)`（外键 `categoryId` `ON DELETE CASCADE`）

### `Document`（`models/document.ts`）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | INTEGER | PK, AUTO_INCREMENT | **即 ChromaDB 中的 doc id（字符串化）** |
| `name` | STRING | NOT NULL | 必须以 `.md` 结尾 |
| `categoryId` | INTEGER | NOT NULL | 所属 Category |

关系：`BelongsTo(Category)`（外键 `categoryId` `ON DELETE CASCADE`）。

> 文档**正文不存表**——只存元数据。正文与向量统一存放在 ChromaDB（见下文）。

### 根 Category 的初始化

`Novel.create()` 在事务中创建 Novel 后立即创建三条根 Category：

```ts
const settings  = await Category.create({ name: '设定', novelId: model.id }, ...);
const outlines  = await Category.create({ name: '大纲', novelId: model.id }, ...);
const texts     = await Category.create({ name: '正文', novelId: model.id }, ...);
```

它们的名字固定为 `'设定' | '大纲' | '正文'`，类型导出为 `RootCategoryName`。

## 路径约定

绝对路径以 `/` 开头，层级用 `/` 分隔：

```
/设定                     <- 根目录
/设定/世界                  <- 子目录
/设定/世界/魔法体系.md        <- 文档
```

代码中**禁止**：
- 路径不以 `/` 开头 → `InvalidPathError`
- 路径只到根目录层级（`splitted.length < 2` 在读写时）→ `InvalidPathError`
- 任何路径段包含 `.`（避免与文件名扩展名混淆）→ `InvalidPathError`
- 操作目标不是 `.md`（读/写/删文档时）→ `InvalidPathError`

## 向量层：ChromaDB

### Collection 命名

```
category#<rootCategoryId>
```

每个根 Category 对应一个 Chroma collection。`Novel.create` 在提交事务后为三个根目录各创建一个 collection。

### Document 与向量条目的对应

| Chroma 字段 | 来源 |
| --- | --- |
| `id` | `Document.id.toString()` |
| `document` | 文档正文 |
| 向量 | 由 `embeddingFunction` 自动生成 |

embeddingFunction 配置（`db/embedding.ts`）：

```ts
new OpenAIEmbeddingFunction({
    apiBase: 'http://embedding:8000/v1',
    apiKey: '--',
    modelName: '/models/Qwen3-Embedding-0.6B-f16.gguf',
});
```

即调用 llama.cpp 容器提供的 OpenAI 兼容 `/v1/embeddings` 接口。

### 检索（`Novel.search`）

- 入参：`rootCategory: RootCategoryName`、`texts: string[]`、`limit: number ∈ [1,20]`
- 通过 rootCategory 名查到根 Category 行 → 推导 collection 名
- `collection.query({ queryTexts: texts, nResults: limit })` 由 Chroma 编码查询文本
- 对返回的多查询结果**按 documentId 去重**（保留首次出现顺序），再通过 `getDocumentPath` 拼接路径
- 返回 `{ path, text }[]`

## 业务异常映射

`lib/errors.ts` 中定义的异常及对应业务含义（HTTP 状态码建议见 [HTTP API](./http-api.md#错误响应)）：

| 异常类 | 代表场景 | 建议 HTTP 状态码 |
| --- | --- | --- |
| `ExistError` | 创建重名小说 | `409 Conflict` |
| `NotExistError` | 路径/ID 不存在 | `404 Not Found` |
| `InvalidPathError` | 路径格式不合法、写根目录等 | `400 Bad Request` |
| `OutOfBoundsError` | `limit` 越界、空入参 | `400 Bad Request` |
| `EditFailError` | 正则替换后字符串未变化 | `422 Unprocessable Entity` |

## 事务与一致性

> 修复后（见 git 历史）的写操作事务边界如下。统一原则：**Sequelize 事务只包含 SQL 写入**；ChromaDB 操作移出事务，作为 SQL 提交后的"尽力而为"步骤执行。这是为了规避"Chroma 抛错导致 SQL 回滚但向量无法恢复"以及"Chroma 卡死阻塞唯一 SQLite 连接"等问题。

| 操作 | 顺序 |
| --- | --- |
| `Novel.create` | ① 事务：创建 Novel + 三个根 Category → ② 事务外：为三个根分别 `createCollection` |
| `write` | ① 事务：创建/复用 Category 与 Document，返回 `{ documentId, rootCategoryId }` → ② 事务外：`collection.upsert` |
| `deleteDocument` | ① 事务：根据路径取出 documentId 并 `destroy` → ② 事务外：`collection.delete(ids)` |
| `deleteCategory` | ① 递归收集 `documentIds`（`await findFiles`）→ ② 事务：`Document.destroy(Op.in)` + `Category.destroy` → ③ 事务外：`collection.delete(ids)` |
| `destroy` | ① 查出三个根 Category → ② 事务：`Novel.destroy` → ③ 事务外：对三 collection 逐个 `deleteCollection`（每条独立 try/catch） |

### 修复后的残留语义风险

新两阶段顺序的代价：**Chroma 写失败会造成 SQL 已提交但向量缺失**（孤儿元数据）。考虑到本系统是辅助写作工具且均为本地调用，这是可接受的权衡；后续若需进一步可恢复性，可引入以下增强（非必须）：

- 在 `Document` 表加 `vector_synced: boolean` 列，Chroma 成功后置位；查询侧过滤未同步行
- 对孤儿条目提供后台 reconcile 任务（扫描元数据 → 补写/补删向量）

## 关联路径反查（用于 `search`）

`getDocumentPath(id)`：

```
Document(id) -> categoryId -> Category 链向上回溯直到 root Category -> 拼成 /a/b/c/name.md
```

> 实现说明：循环中使用 `findByPk(currentId)` 逐级上溯（曾存在使用 `findByPk(categoryId)` 的死循环 bug，已修复）。
