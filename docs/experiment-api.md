# 对照实验 API 设计

> **状态：设计阶段，尚未实现。** 本文档定义一组用于"三根目录 vs 混合存储"语义检索对比实验的 REST API。

## 1. 背景与目标

当前系统按小说创建三个根目录（`/设定`、`/大纲`、`/正文`），每个根目录对应一个独立的 ChromaDB collection，检索时仅在指定根目录的 collection 内查询。这种设计天然隔离了不同类型的数据，但需要定量验证其**防止数据污染**（跨根目录的无关文档混入检索结果）的能力。

为此引入一组实验 API，支持：

1. 从 JSON 文件批量导入结构化数据，同时构建三根目录数据 + 一个**混合存储** ChromaDB collection（所有文档不分目录混存）。
2. 一键删除实验导入的全部数据。
3. 给定一组测试查询及其标注的相关文档（ground truth），在三根目录与混合存储上分别执行检索，自动计算 **平均检索延迟、Recall@K、MRR**，并统计混合存储中的跨根目录污染率。

---

## 2. 数据模型扩展

### 2.1 `Experiment` 表（Sequelize，新增）

用于追踪每次实验导入，记录混合 collection 名称等元信息。

| 字段                  | 类型    | 约束               | 说明                                      |
| --------------------- | ------- | ------------------ | ----------------------------------------- |
| `id`                  | INTEGER | PK, AUTO_INCREMENT |                                           |
| `novelId`             | INTEGER | NOT NULL, FK       | 导入数据所创建的小说；`ON DELETE CASCADE` |
| `name`                | STRING  | NOT NULL           | 实验名称（用于列表展示）                  |
| `mixedCollectionName` | STRING  | NOT NULL           | 混合存储的 ChromaDB collection 名称       |
| `createdAt`           | DATE    | NOT NULL           | 创建时间                                  |

关系：`BelongsTo(Novel)`，外键 `novelId`。

> 该表为**新增** Sequelize 模型，位于 `packages/backend/src/lib/db/models/experiment.ts`。

### 2.2 混合 ChromaDB Collection

每个实验创建一个专用的混合 collection：

- **命名**：`experiment_mixed_${experimentId}`
- **内容**：所有导入文档（来自设定/大纲/正文三根目录下的全部 `.md` 文件）混合存入
- **Chroma metadata**：每条向量条目附带 `{ rootCategory: string, path: string }` 元数据，用于事后判断检索结果来自哪个根目录

```ts
// 伪代码：写入混合 collection 时附加 metadata
await mixedCollection.upsert({
    ids: [documentId.toString()],
    documents: [content],
    metadatas: [{ rootCategory: '设定', path: '/设定/世界/魔法体系.md' }],
});
```

> ⚠️ 现有三根目录 collection 写入 (`Novel.write`) **不使用** Chroma metadata 字段，需在对比实验中新写入混合 collection 时独立附加。

---

## 3. JSON 导入格式

### 3.1 完整格式

```json
{
    "settings": [
        {
            "name": "世界",
            "children": [
                {
                    "name": "魔法体系.md",
                    "content": "本世界的魔法体系基于元素共鸣……（长文本）"
                },
                {
                    "name": "地理",
                    "children": [
                        {
                            "name": "北境.md",
                            "content": "北境终年冰封……"
                        }
                    ]
                }
            ]
        },
        {
            "name": "角色.md",
            "content": "主角是一位年轻的剑客……"
        }
    ],
    "outlines": [
        {
            "name": "第一卷.md",
            "content": "第一卷概要：主角离开故乡……"
        }
    ],
    "chapters": [
        {
            "name": "第1章.md",
            "content": "第一章正文：清晨的阳光透过窗棂……"
        }
    ]
}
```

> `testQueries` 不属于导入 JSON。测试查询集在执行对比实验时由 `/run` 接口在请求体中单独传入（见 §4.4）。

### 3.2 字段说明

| 字段       | 类型  | 必填 | 说明                              |
| ---------- | ----- | ---- | --------------------------------- |
| `settings` | array | 否   | 导入到 `/设定` 根目录下的树形节点 |
| `outlines` | array | 否   | 导入到 `/大纲` 根目录下的树形节点 |
| `chapters` | array | 否   | 导入到 `/正文` 根目录下的树形节点 |

### 3.3 树节点定义

每个节点为：

```ts
type ImportNode = {
    name: string; // 目录名（不含 `.`）或文档名（以 `.md` 结尾）
    content?: string; // 仅叶子文档节点有此字段
    children?: ImportNode[]; // 仅目录节点有此字段
};
```

- **`name` 不含 `.` 且无 `content`** → 目录节点（Category），可有 `children`。
- **`name` 以 `.md` 结尾且有 `content`** → 文档节点（Document），`children` 必须为空或不存在。

根级数组元素可以是目录节点或文档节点。例如 `settings` 数组里直接放 `{ "name": "角色.md", "content": "..." }` 表示 `/设定/角色.md`。

### 3.4 TestQuery 定义

```ts
type TestQuery = {
    query: string; // 检索用的自然语言查询
    rootCategory: RootCategoryName; // 该查询对应的"正确"根目录（用于判定混合存储中的污染）
    relevantPaths: string[]; // ground truth：标注为相关的文档绝对路径
};
```

---

## 4. API 设计

### 4.1 导入实验数据

```
POST /api/experiments/import?name=<实验名称>
Content-Type: application/json
```

**查询参数**：

| 参数   | 类型   | 必填 | 说明                             |
| ------ | ------ | ---- | -------------------------------- |
| `name` | string | 是   | 实验名称（同时也是创建的小说名） |

**请求体**：见 §3.1 完整 JSON 格式（仅含 `settings`/`outlines`/`chapters`）。

**处理流程**：

1. **校验** JSON 结构（Zod schema 运行时校验）。
2. **创建小说**：调用 `Novel.create(name)`，自动生成 `/设定`、`/大纲`、`/正文` 三根目录及其 Chroma collection。
3. **遍历导入**：对 `settings` / `outlines` / `chapters` 分别递归遍历：
    - 目录节点 → 调用 `Novel.createCategory(path)`
    - 文档节点 → 调用 `Novel.write(path, content)`
        > 由于 `Novel.write` 内部已自动创建缺失的中间目录，可以简化为一律调用 `Novel.write`，但为避免目标目录已存在时报 `ExistError`（409），采用"先确保目录存在，再写文档"的两步策略。或者直接用 `Novel.write` 全路径，因为它内部查找不到父目录时会自动 `Category.create`——**需要确认**：`Novel.write` 对已存在的目录会走 `findOne` 命中分支，不会抛 `ExistError`，只有 `Novel.createCategory` 对已存在的目标目录会抛 `ExistError`。因此导入时统一走 `Novel.write` 路径即可。
4. **构建混合 collection**：
    - 创建 ChromaDB collection：`experiment_mixed_${experimentId}`，使用与现有相同的 `embeddingFunction`。
    - 遍历所有导入的文档，按 documentId 逐一 `upsert` 到混合 collection，每条附 `metadata: { rootCategory, path }`。
5. **持久化实验记录**：在 `Experiment` 表中写入一行，记录 `novelId`、`name`、`mixedCollectionName`。

**响应**（200）：

```json
{
    "experimentId": 1,
    "novelId": 3,
    "name": "武侠世界观-实验1",
    "stats": {
        "settingDocs": 2,
        "outlineDocs": 1,
        "chapterDocs": 1,
        "totalDocs": 4
    }
}
```

**错误**：

- `409` — 小说名（实验名）已存在（`ExistError`）
- `400` — JSON 格式不合法

### 4.2 删除实验数据

```
DELETE /api/experiments/:experimentId
```

**处理流程**：

1. 查询 `Experiment` 表获取 `novelId` 与 `mixedCollectionName`。
2. 删除混合 collection：`chroma.deleteCollection({ name: mixedCollectionName })`。
3. 删除小说：`Novel.byID(novelId).destroy()`（级联删除三根目录 Categories/Documents + 各自的 Chroma collection）。
4. 删除 `Experiment` 行。

> 步骤 2–4 均为幂等操作；即使某些 collection 已被删除也不影响主流程（try/catch 吞掉）。

**响应**：`204 No Content`

**错误**：

- `404` — 实验不存在

### 4.3 列出实验

```
GET /api/experiments
```

**响应**（200）：

```json
[
    { "id": 1, "name": "武侠世界观-实验1", "novelId": 3, "createdAt": "2026-07-30T08:00:00.000Z" },
    { "id": 2, "name": "科幻宇宙-实验2", "novelId": 4, "createdAt": "2026-07-30T09:00:00.000Z" }
]
```

### 4.4 执行对比实验

```
POST /api/experiments/:experimentId/run
Content-Type: application/json
```

**请求体**：

```json
{
    "k": 5,
    "queries": [
        {
            "query": "魔法体系的基本原理",
            "rootCategory": "设定",
            "relevantPaths": ["/设定/世界/魔法体系.md"]
        }
    ]
}
```

| 字段      | 类型        | 必填 | 默认值 | 说明                           |
| --------- | ----------- | ---- | ------ | ------------------------------ |
| `k`       | number      | 否   | 5      | Recall@K 的 K 值，范围 [1, 20] |
| `queries` | TestQuery[] | 是   | —      | 测试查询集，含 ground truth    |

**处理流程**：

对每条 `TestQuery` 分别执行两组检索：

**组 A：三根目录检索**（现有能力）

- 调用 `Novel.search(rootCategory, [query], k)`，在对应根目录的 collection 中查询。
- 记录：延迟 $t_A$（ms）、返回结果 `resultsA: { path, text }[]`。

**组 B：混合存储检索**

- 在 `experiment_mixed_${experimentId}` collection 中执行 `query({ queryTexts: [query], nResults: k })`。
- 记录：延迟 $t_B$（ms）、返回结果 `resultsB: { path, text, metadata: { rootCategory } }[]`。

**指标计算**（所有查询聚合）：

| 指标                  | 计算方式                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 平均检索延迟（ms）    | $\bar{t} = \frac{1}{n}\sum t_i$，分别报告 A、B 两组                                                                                                     |
| Recall@K              | $\frac{1}{n}\sum \frac{\vert \text{retrieved}_K \cap \text{relevant} \vert}{\vert \text{relevant} \vert}$，分别报告 A、B 两组                           |
| MRR                   | $\frac{1}{n}\sum \frac{1}{\text{rank}_i}$，其中 $\text{rank}_i$ 为第一个相关文档在结果中的排名（1-indexed）；若无相关文档，该项为 0。分别报告 A、B 两组 |
| **污染率**（仅 B 组） | $\frac{\text{来自非 target rootCategory 的结果数}}{\text{总返回结果数}}$，即混合存储中来自错误根目录的结果占比                                          |

**响应**（200）：

```json
{
    "experimentId": 1,
    "k": 5,
    "queryCount": 4,
    "threeRoot": {
        "avgLatencyMs": 45.2,
        "recallAtK": 0.875,
        "mrr": 0.833
    },
    "mixed": {
        "avgLatencyMs": 48.1,
        "recallAtK": 0.75,
        "mrr": 0.708,
        "contaminationRate": 0.35
    },
    "perQuery": [
        {
            "query": "魔法体系的基本原理",
            "targetRoot": "设定",
            "threeRoot": {
                "latencyMs": 42,
                "results": ["/设定/世界/魔法体系.md"],
                "recall": 1.0,
                "reciprocalRank": 1.0
            },
            "mixed": {
                "latencyMs": 45,
                "results": ["/设定/角色.md", "/设定/世界/魔法体系.md", "/大纲/第一卷.md"],
                "recall": 1.0,
                "reciprocalRank": 0.5,
                "contaminated": 2
            }
        }
    ]
}
```

**错误**：

- `404` — 实验不存在
- `400` — queries 为空或未提供

---

## 5. 路由注册

在 `packages/backend/src/http/routes/experiments.ts` 新增路由文件：

```ts
export async function registerExperimentRoutes(app: FastifyInstance) {
  app.post('/api/experiments/import', ..., importHandler);
  app.get('/api/experiments', ..., listHandler);
  app.delete('/api/experiments/:experimentId', ..., deleteHandler);
  app.post('/api/experiments/:experimentId/run', ..., runHandler);
}
```

在 `packages/backend/src/http/server.ts` 中注册：

```ts
import { registerExperimentRoutes } from './routes/experiments.js';
// ...
await registerExperimentRoutes(app);
```

### 5.1 Zod Schema（新增）

`packages/backend/src/http/schemas.ts` 中新增：

```ts
// 导入节点（递归）
const importNodeSchema: z.ZodType<ImportNode> = z.lazy(() =>
    z
        .object({
            name: z.string().min(1),
            content: z.string().optional(),
            children: z.array(importNodeSchema).optional(),
        })
        .refine(
            (n) => {
                const isDoc = n.name.endsWith('.md');
                if (isDoc) return n.content !== undefined && (n.children === undefined || n.children.length === 0);
                return n.content === undefined;
            },
            { message: '文档节点（.md）必须有 content 且无 children；目录节点不能有 content' },
        ),
);

const testQuerySchema = z.object({
    query: z.string().min(1),
    rootCategory: z.enum(ROOT_CATEGORY_NAMES),
    relevantPaths: z.array(z.string().min(1).startsWith('/')).min(1),
});

export const importExperimentSchema = z.object({
    settings: z.array(importNodeSchema).optional().default([]),
    outlines: z.array(importNodeSchema).optional().default([]),
    chapters: z.array(importNodeSchema).optional().default([]),
});

export const runExperimentSchema = z.object({
    k: z.number().int().min(1).max(20).optional().default(5),
    queries: z.array(testQuerySchema).min(1),
});
```

### 5.2 Shared DTO 类型（新增）

`packages/backend/src/lib/experiment.ts` 中新增核心逻辑（或复用 `Novel` 类能力）。

DTO 类型可扩展 `@novel-writer/shared/src/dto.ts`，或在新文件 `packages/shared/src/dto-experiment.ts` 中定义，由 `shared/src/index.ts` 再导出。

---

## 6. 实现要点

### 6.1 递归导入实现

```ts
async function importTree(
    novel: Novel,
    rootPath: string,
    rootCategory: RootCategoryName,
    nodes: ImportNode[],
): Promise<number> {
    let docCount = 0;
    for (const node of nodes) {
        const path = `${rootPath}/${node.name}`;
        if (node.name.endsWith('.md')) {
            const { documentId } = await novel.write(path, node.content!);
            docIds.push({ path, documentId, rootCategory });
            docCount++;
        } else {
            // 目录节点：先确保目录存在
            try {
                await novel.createCategory(path);
            } catch (e) {
                if (!(e instanceof ExistError)) throw e;
                // 已存在则忽略
            }
            docCount += await importTree(novel, path, rootCategory, node.children ?? []);
        }
    }
    return docCount;
}
```

### 6.2 混合 Collection 构建

```ts
async function buildMixedCollection(
    experimentId: number,
    docRecords: Array<{ path: string; documentId: number; rootCategory: string }>,
) {
    const chroma = await getChroma();
    const collectionName = `experiment_mixed_${experimentId}`;
    const collection = await chroma.createCollection({ name: collectionName, embeddingFunction });

    // docRecords 由 importTree 过程中积累，documentId 来自 Novel.write 的返回值（方案 B）
    const ids = docRecords.map((d) => d.documentId.toString());
    const documents = docRecords.map((d) => d.content); // content 需在导入时一并保留

    await collection.upsert({
        ids,
        documents,
        metadatas: docRecords.map((d) => ({ rootCategory: d.rootCategory, path: d.path })),
    });
}
```

### 6.3 延迟测量

```ts
const start = performance.now();
const results = await novel.search(rootCategory, [query], k);
const latencyMs = performance.now() - start;
```

### 6.4 污染率计算

对混合存储的每条检索结果，检查其 `metadata.rootCategory` 是否等于 `testQuery.rootCategory`：

```ts
const contaminated = mixedResults.filter((r) => r.metadata.rootCategory !== testQuery.rootCategory).length;
const contaminationRate = contaminated / mixedResults.length;
```

---

## 7. 文件变更清单

| 文件                                               | 变更类型 | 说明                                              |
| -------------------------------------------------- | -------- | ------------------------------------------------- |
| `packages/backend/src/lib/novel.ts`                | 修改     | `Novel.write` 返回值改为 `{ documentId: number }` |
| `packages/backend/src/lib/db/models/experiment.ts` | 新增     | Experiment Sequelize 模型                         |
| `packages/backend/src/lib/db/sequelize.ts`         | 修改     | 注册 Experiment 模型                              |
| `packages/backend/src/lib/experiment.ts`           | 新增     | 实验核心业务逻辑                                  |
| `packages/backend/src/http/routes/experiments.ts`  | 新增     | 实验 REST 路由                                    |
| `packages/backend/src/http/server.ts`              | 修改     | 注册实验路由                                      |
| `packages/backend/src/http/schemas.ts`             | 修改     | 新增 import/run 实验的 Zod schema                 |
| `packages/shared/src/dto-experiment.ts`            | 新增     | 共享 DTO 类型                                     |
| `packages/shared/src/index.ts`                     | 修改     | 再导出实验 DTO                                    |

---

## 8. 已决策项

1. **documentId 获取（方案 B）**：给 `Novel.write` 增加返回值 `{ documentId: number }`。导入时在 `importTree` 中直接捕获 `documentId`，无需额外查询。现有调用方（HTTP routes、MCP tools）中 `Novel.write` 的返回值未被使用，改为返回对象不影响兼容性。

2. **testQueries 不存库**：`testQueries` 不作为导入 JSON 的一部分，也不存入 `Experiment` 表。每次执行 `/run` 时由用户在请求体中传入 `queries` 字段（必填）。

3. **不考虑扩展性**：当前 `Experiment` 表字段仅包含 `id`/`novelId`/`name`/`mixedCollectionName`/`createdAt`，不预留 `config` JSON 等扩展字段。
