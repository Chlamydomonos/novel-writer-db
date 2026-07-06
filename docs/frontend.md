# 前端（Vue 3）

本文档定义用于可视化调用全部接口的 Web 前端。前端**仅消费 [HTTP API](./http-api.md)**，不直接接触 MCP。

## 目标

- 通过可视化界面调用 `Novel` 类的**全部**公开能力（包含 LLM 不可见的管理类接口）
- 单一工具栏覆盖"小说管理 + 目录浏览 + 文档编辑 + 语义检索"四大场景
- 体验上接近"轻量 IDE/Notion 文档库"

## 技术栈

| 维度 | 选型 | 理由 |
| --- | --- | --- |
| 框架 | Vue 3 + `<script setup>` | 用户指定 |
| 构建 | Vite | 生态默认 |
| 语言 | TypeScript | 与后端一致 |
| 路由 | Vue Router | 视图分页 |
| 状态 | Pinia（可选） | 小说列表/当前选中态 |
| UI 库 | Element Plus 或 Naive UI | 树/表格/对话框组件成熟 |
| Markdown 编辑 | `@bytedance/bytemd` 或 `md-editor-v3` | 兼顾读 / 编辑 / 正则替换 |
| 网络 | 原生 `fetch` 封装 | 无需重型库 |
| 包管理 | pnpm（与 monorepo 一致） | 新建 `packages/frontend` |

## 工作区结构

```
packages/frontend/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── index.html
└── src/
    ├── main.ts
    ├── App.vue
    ├── router/index.ts
    ├── api/
    │   ├── client.ts          # fetch 封装：baseURL、错误抛出
    │   └── novel.ts           # 与 HTTP API 对应的类型化方法
    ├── stores/
    │   ├── novels.ts          # 小说列表 + 当前小说
    │   └── editor.ts          # 当前编辑文档
    ├── views/
    │   ├── NovelList.vue      # 选择/创建/删除小说
    │   ├── NovelWorkspace.vue # 工作区（左树 + 右内容）
    │   └── Settings.vue       # 修改小说 info（writeInfo/editInfo）
    ├── components/
    │   ├── CategoryTree.vue   # 目录树
    │   ├── DocumentEditor.vue # markdown 编辑器
    │   ├── SearchPanel.vue    # 语义检索面板
    │   └── RegexEditDialog.vue# 正则编辑对话框（适用于 info / 文档）
    └── types/
        └── dto.ts             # 与后端 dto 共享，或独立声明
```

## 视图划分

### 1. 小说列表 `NovelList.vue`

- 列出 `GET /api/novels`
- 创建：表单提交 `POST /api/novels`（带唯一性校验提示）
- 进入工作区 / 删除（带确认）
- 简要显示小说 `info`（通过 `GET /api/novels/:id` 拉取）

### 2. 工作区 `NovelWorkspace.vue`

主操作界面，左中右三栏：

```
┌──────────────┬────────────────────────┬──────────────┐
│  目录树        │  文档编辑区              │  语义检索面板   │
│ CategoryTree │   DocumentEditor        │  SearchPanel  │
├──────────────┼────────────────────────┼──────────────┤
│ 设定           │ # 标题                  │ 关键词: [    ] │
│  🗂️ 世界       │ 文档正文 …              │ 分类: 设定 ▾  │
│   📄 人物卡.md │                        │ 数量: 10     │
│  📁 地理       │                        │ [搜索]        │
│ 大纲           │                        │              │
│ 正文           │ [保存] [正则编辑] [删除]   │ 结果:        │
│ [新建目录]      │                        │  - 人物卡.md │
│ [新建文档]      │                        │  - 魔法体系.md│
└──────────────┴────────────────────────┴──────────────┘
```

#### 目录树 `CategoryTree.vue`

- 数据来源：`GET /api/novels/:id/list?path=/设定&recursive=true`，每个根目录单独拉取
- 由于 `list` 返回的是缩进文本，前端解析后构建树（emoji 区分节点类型）
- 右键菜单：新建子目录、新建文档、删除目录（根目录禁用删除）
- 拖拽改层级（**未来增强**，HTTP API 暂未提供 move 接口）

#### 文档编辑区 `DocumentEditor.vue`

- 双击树中的文档 → 调 `POST /read` 拉正文 → 显示
- 操作按钮对应接口：

| 按钮 | 接口 |
| --- | --- |
| 保存 | `POST /write`（整体覆盖，传完整正文） |
| 正则编辑… | 弹出 `RegexEditDialog` → `POST /edit` |
| 删除 | 二次确认 → `DELETE /documents` |
| 另存为 | 调用 `POST /write` 用新路径 |

#### 检索面板 `SearchPanel.vue`

- 选 `rootCategory`（设定/大纲/正文）、`texts`（多行 → 数组）、`limit`（1–20）
- 提交 `POST /search`
- 结果列表点击 → 在文档编辑区打开（自动调 read）

### 3. 设置 `Settings.vue`

- 显示并可整体覆盖 `info`（`PATCH /info`，即 `PATCH /api/novels/:id` body `{ info }`）
- 提供正则编辑入口（`body.infoEdit`）
- **重命名小说**走同一 `PATCH` 接口的 `body.name`
- 危险操作：删除小说（跳回列表）

## 客户端封装（`api/client.ts`）

```ts
const BASE = '/api';        // 通过 vite proxy 转发到后端

export class ApiError extends Error {
    constructor(public status: number, public type: string, message: string) {
        super(message);
    }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(BASE + path, {
        headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
        ...init,
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(res.status, body?.error?.type ?? 'Unknown', body?.error?.message ?? res.statusText);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
}
```

> 把 `ApiError.type` 透传给 UI 层做友好提示（例如 `EditFailError` → "替换未产生变化"）。

## Vite 代理（开发期）

```ts
// vite.config.ts
export default defineConfig({
    server: {
        proxy: {
            '/api': 'http://localhost:3000',
        },
    },
});
```

生产部署下前端构建产物由后端静态托管或由反向代理分发，详见 [部署](./deployment.md)。

## 错误展示约定

| 状态 / `error.type` | UI 行为 |
| --- | --- |
| `400`（`InvalidPathError`/`OutOfBoundsError`） | inline 提示输入错误，不关闭对话框 |
| `404`（`NotExistError`） | 提示 + 刷新目录树（可能已被其它客户端删除） |
| `409`（`ExistError`） | 创建表单显示重名错误 |
| `422`（`EditFailError`） | 在正则编辑对话框中提示"未产生变化，请调整正则" |
| `5xx` | 全局 toast + 重试按钮 |

## 类型共享建议

为避免前后端字段漂移：

- **方案 A（推荐）**：把 `dto.ts` 提取到 `packages/shared/`，前后端同 monorepo 引用
- 方案 B：前端独立 `types/dto.ts`，由人工/CI 比对，约束字段一一对应

核心类型：

```ts
export type RootCategoryName = '设定' | '大纲' | '正文';
export interface NovelSummary { id: number; name: string; }
export interface NovelDetail extends NovelSummary { info: string; }
export interface DocumentRef { path: string; text: string; }
export type TreeNodeType = 'category' | 'document';
export interface TreeNode { type: TreeNodeType; name: string; }
```

## 验收清单

- [ ] 可列出/创建/删除/重命名小说
- [ ] 可在三个根目录下浏览（递归开关）
- [ ] 可读/写/正则编辑/删除 `.md` 文档
- [ ] 可按根目录做语义检索并点击结果打开文档
- [ ] 可正则编辑小说 `info`
- [ ] 全部业务异常有清晰 UI 反馈
- [ ] 在 `pnpm-workspace.yaml` 已声明的 `packages/*` 下被自动识别
