# 前端（Vue 3）

> ✅ **实现状态：已完成。** 本文档描述的前端方案已全部落地于 `packages/frontend/`。

本文档定义用于可视化调用全部接口的 Web 前端。前端**仅消费 [HTTP API](./http-api.md)**，不直接接触 MCP。

## 目标

- 通过可视化界面调用 `Novel` 类的**全部**公开能力（包含 LLM 不可见的管理类接口）
- 单一工具栏覆盖"小说管理 + 目录浏览 + 文档编辑 + 语义检索"四大场景
- 体验上接近"轻量 IDE/Notion 文档库"

## 技术栈

| 维度     | 选型                         | 理由                                       |
| -------- | ---------------------------- | ------------------------------------------ |
| 框架     | Vue 3 + `<script setup>`     | 用户指定                                   |
| 构建     | Vite                         | 生态默认                                   |
| 语言     | TypeScript                   | 与后端一致                                 |
| 样式     | SCSS（`sass` + Dart Sass）   | 嵌套、变量、混入更利于组织主题与组件样式   |
| 路由     | Vue Router                   | 视图分页                                   |
| 状态     | Pinia（可选）                | 小说列表/当前选中态                        |
| UI 库    | Element Plus                 | 树/表格/对话框组件成熟，主题与暗色模式完善 |
| HTTP     | axios（实例 + 拦截器）       | 拦截器统一处理 baseURL、错误、取消请求     |
| 文档编辑 | 原生 `<textarea>`/`el-input` | 直接编辑纯文本，无需 Markdown 渲染/语法    |
| 包管理   | pnpm（与 monorepo 一致）     | 新建 `packages/frontend`                   |
| 类型共享 | 独立包 `packages/shared`     | 前后端同 monorepo 引用，避免字段漂移       |

> **Element Plus 使用约定**：**不使用** `app.use(ElementPlus)` 全局注册，而是在每个 `.vue` 文件中 `import { ElButton } from 'element-plus'` 按需引入组件，以获得完整的 TypeScript 类型提示。模板内使用大驼峰 `<ElButton>`；全局仅导入 `element-plus/dist/index.css` 样式。

**不引入的功能**：

- ❌ Markdown 编辑器（不复用 bytemd / md-editor-v3），文档一律按纯文本编辑
- ❌ 正则表达式替换（前端不实现 `/edit`、`body.infoEdit` 通道）

## 工作区结构（已落地）

```
packages/
├── shared/                 # ★ 前后端共享类型与约束
│   ├── package.json        #   name: @novel-writer/shared
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts        # 统一导出
│       └── dto.ts          # 接口入参/出参 DTO 类型
└── frontend/
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig.json
    ├── index.html
    └── src/
        ├── main.ts
        ├── App.vue
        ├── router/index.ts
        ├── api/
        │   ├── client.ts          # axios 实例 + 拦截器：baseURL、错误归一化
        │   └── novel.ts           # 与 HTTP API 对应的类型化方法
        ├── stores/
        │   ├── novels.ts          # 小说列表 + 当前小说
        │   └── editor.ts          # 当前编辑文档
        ├── views/
        │   ├── NovelList.vue      # 选择/创建/删除小说
        │   ├── NovelWorkspace.vue # 工作区（左树 + 右内容）
        │   └── NovelSettings.vue   # 修改小说 info（writeInfo，整体覆盖）
        ├── components/
        │   ├── CategoryTree.vue   # 目录树（基于 el-tree）
        │   ├── DocumentEditor.vue # 纯文本编辑（el-input textarea）
        │   └── SearchPanel.vue    # 语义检索面板
        ├── styles/
        │   ├── index.scss         # 全局入口 @use 子模块
        │   ├── variables.scss     # 颜色/间距/字号变量
        │   ├── element.scss       # Element Plus 主题覆盖
        │   └── reset.scss         # 简单 reset
        └── vite-env.d.ts
```

> `@novel-writer/shared` 是 workspace 协议依赖（`"@novel-writer/shared": "workspace:*"`），Vite 解析 TS 源无需预编译，类型天然漂移检测由 `tsc --noEmit` 共担。

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
│ 正文           │ [保存] [另存为] [删除]    │ 结果:        │
│ [新建目录]      │                        │  - 人物卡.md │
│ [新建文档]      │                        │  - 魔法体系.md│
└──────────────┴────────────────────────┴──────────────┘
```

#### 目录树 `CategoryTree.vue`

- 基于Element Plus的 `el-tree`，`:data` 直接绑定 `TreeNode[]`（来自 shared 包的类型）
- 数据来源：`GET /api/novels/:id/list?path=/设定&recursive=true`，每个根目录单独拉取
- 由于 `list` 返回的是缩进文本，前端解析后构建树（emoji 区分节点类型）
- Element Plus的右键菜单由 `@node-contextmenu` 触发 `el-dropdown` 实现：新建子目录、新建文档、删除目录（根目录禁用删除）
- 拖拽改层级（**未来增强**，HTTP API 暂未提供 move 接口）

#### 文档编辑区 `DocumentEditor.vue`

- 单击树中的文档 → 调 `POST /read` 拉正文 → 显示到 `el-input type="textarea"`（可全屏/最大化）
- 操作按钮对应接口：

| 按钮   | 接口                                  |
| ------ | ------------------------------------- |
| 保存   | `POST /write`（整体覆盖，传完整正文） |
| 另存为 | 调用 `POST /write` 用新路径           |
| 删除   | 二次确认 → `DELETE /documents`        |

> 不再提供 Markdown 预览与正则替换；编辑即纯文本改动，保存即整体覆盖。

#### 检索面板 `SearchPanel.vue`

- 用 `el-select` 选 `rootCategory`（设定/大纲/正文）、`el-input` 多行收集 `texts`（按行 → 数组）、`el-input-number` 限定 `limit`（1–20）
- 提交 `POST /search`，结果展示在下方 `el-scrollbar` 列表中
- 结果列表点击 → 在文档编辑区打开（自动调 read）

### 3. 设置 `NovelSettings.vue`

- 显示并可整体覆盖 `info`（`PATCH /info`，即 `PATCH /api/novels/:id` body `{ info }`），通过 `el-input type="textarea"`
- **重命名小说**走同一 `PATCH` 接口的 `body.name`
- 危险操作：删除小说（跳回列表）

> 前端不暴露正则编辑（`body.infoEdit`）通道，info 修改只走整体覆盖。

## 客户端封装（`api/client.ts`）

使用 axios + 拦截器统一处理 baseURL、错误归一化与取消令牌。

```ts
import axios, { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';

export class ApiError extends Error {
    constructor(
        public status: number,
        public type: string,
        message: string,
    ) {
        super(message);
    }
}

const http: AxiosInstance = axios.create({
    baseURL: '/api', // 通过 vite proxy 转发到后端
    timeout: 30_000,
    headers: { 'Content-Type': 'application/json' },
});

// 请求拦截：可在此注入小说 ID 头、traceId 等
http.interceptors.request.use((cfg: InternalAxiosRequestConfig) => {
    return cfg;
});

// 响应拦截：统一抛出 ApiError，UI 只需捕获一种异常
http.interceptors.response.use(
    (res) => (res.status === 204 ? undefined : res.data),
    (err: AxiosError<{ error?: { type?: string; message?: string } }>) => {
        const status = err.response?.status ?? 0;
        const type = err.response?.data?.error?.type ?? 'Unknown';
        const message = err.response?.data?.error?.message ?? err.message;
        return Promise.reject(new ApiError(status, type, message));
    },
);

export { http };
```

调用方写法（`api/novel.ts`）：

```ts
import { http } from './client';
import type { NovelSummary } from '@novel-writer/shared';

export const listNovels = () => http.get<unknown, NovelSummary[]>('/novels');
export const createNovel = (name: string) => http.post<unknown, NovelSummary>('/novels', { name });
```

> 把 `ApiError.type` 透传给 UI 层做友好提示（例如 `ExistError` → "小说名已存在"）。

## 全局样式与主题（`styles/`）

入口 `main.ts` 只导入 CSS（**不全局注册组件**，组件在各 `.vue` 中按需 import，详见上文 Element Plus 使用约定）：

```ts
import 'element-plus/dist/index.css';
import './styles/index.scss'; // 必须在 element-plus css 之后，便于覆盖
```

`styles/` 子模块职责：

| 文件             | 作用                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `variables.scss` | `:root { --app-bg: ...; --app-padding: ...; }` 业务变量，且 `@use` 给 `element.scss`                                                   |
| `element.scss`   | 覆盖 Element Plus CSS 变量，如 `:root { --el-color-primary: #... ; }`                                                                  |
| `reset.scss`     | 简单 reset / box-sizing / 链接默认样式                                                                                                 |
| `index.scss`     | `@use 'reset'; @use 'variables'; @use 'element';`，组件内 `<style scoped lang="scss">` 通过 `@use '@/styles/variables' as *;` 复用变量 |

> Vite 选用 `sass-embedded`（Dart Sass 推荐实现），`pnpm add -D sass-embedded sass` 即可；`@use` 优先于 `@import`。

## Vite 代理（开发期）

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
    plugins: [vue()],
    resolve: {
        alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
        proxy: { '/api': 'http://localhost:3000' },
    },
    css: {
        preprocessorOptions: {
            scss: { api: 'modern-compiler' }, // 启用 sass-embedded
        },
    },
});
```

生产部署下前端构建产物由后端静态托管或由反向代理分发，详见 [部署](./deployment.md)。

## 错误展示约定

| 状态 / `error.type`                            | UI 行为                                                   |
| ---------------------------------------------- | --------------------------------------------------------- |
| `400`（`InvalidPathError`/`OutOfBoundsError`） | inline 提示输入错误，不关闭对话框                         |
| `404`（`NotExistError`）                       | 提示（`ElMessage`）+ 刷新目录树（可能已被其它客户端删除） |
| `409`（`ExistError`）                          | 创建表单显示重名错误                                      |
| `5xx`                                          | 全局 toast（`ElNotification`）+ 重试按钮                  |

## 类型共享方案（`packages/shared`）

为避免前后端字段漂移，统一采用**方案 A**：抽离独立包 `@novel-writer/shared`，前后端以 `workspace:*` 协议依赖，引用 TS 源（无需预编译），由 `tsc --noEmit` 两侧共同约束字段一致性。

### 包结构

```
packages/shared/
├── package.json        # "name": "@novel-writer/shared"
├── tsconfig.json
└── src/
    ├── index.ts        # 统一导出
    └── dto.ts          # 所有 DTO
```

### `package.json`

```json
{
    "name": "@novel-writer/shared",
    "version": "0.0.0",
    "private": true,
    "type": "module",
    "exports": {
        ".": "./src/index.ts",
        "./dto": "./src/dto.ts"
    }
}
```

> 显式 `exports` 让 Vite 与 Node ESM 都能直接吃下 TS 源；后端若用 `tsx` 同理。

### 引用方式

```ts
// 前端 packages/frontend/package.json
{ "dependencies": { "@novel-writer/shared": "workspace:*" } }

// 后端 packages/backend/package.json
{ "dependencies": { "@novel-writer/shared": "workspace:*" } }
```

### 核心类型

```ts
// packages/shared/src/dto.ts
export type RootCategoryName = '设定' | '大纲' | '正文';

export interface NovelSummary {
    id: number;
    name: string;
}
export interface NovelDetail extends NovelSummary {
    info: string;
}

export interface DocumentRef {
    path: string;
    text: string;
}

export interface SearchResultItem {
    path: string;
    text: string;
    score?: number;
}
export interface SearchRequest {
    rootCategory: RootCategoryName;
    texts: string[];
    limit: number;
}

export type TreeNodeType = 'category' | 'document';
export interface TreeNode {
    type: TreeNodeType;
    name: string;
    children?: TreeNode[];
}
```

### 一致性保障

- 前端 `packages/frontend/tsconfig.json` 与后端均 `references` 指向 `packages/shared/tsconfig.json`（Composite TS Project）
- 根目录 CI 任务 `pnpm -r tsc --noEmit` 双侧共同编译，任意一方修改字段将立即在对方报告类型错误

## 验收清单

**功能**

- [x] 可列出/创建/删除/重命名小说
- [x] 可在三个根目录下浏览（递归开关）
- [x] 可读/写/删除 `.md` 文档（按纯文本编辑）
- [x] 可按根目录做语义检索并点击结果打开文档
- [x] 可整体覆盖小说 `info`
- [x] 全部业务异常有清晰 UI 反馈

**工程**

- [x] `@novel-writer/shared` 包已建立并被前后端引用
- [x] 使用 Element Plus 作为 UI 库（树/表格/对话框/通知），按需 import 而非全局注册
- [x] 使用 axios 实例 + 拦截器统一请求与错误
- [x] 使用 SCSS（`sass-embedded`），样式按 `styles/` 目录组织
- [x] 在 `pnpm-workspace.yaml` 已声明的 `packages/*` 下被自动识别
