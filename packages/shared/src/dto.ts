/**
 * novel-writer-db 前后端共享 DTO 类型定义。
 *
 * 这些类型对应后端 `Novel` 类的全部公开方法，以及 [HTTP API](../../docs/http-api.md) 的请求/响应模型。
 * 业务校验逻辑（如 `limit` 边界）由后端 `Novel.xxx` 抛出 `OutOfBoundsError`/`InvalidPathError` 等业务异常。
 *
 * 路径约定：所有 `path` 均为绝对路径，以 `/` 起始，根目录取值为 `/设定`、`/大纲`、`/正文`。
 * 文档路径以 `.md` 结尾，至少两级（形如 `/<根目录>/<文件名>.md`）。
 */

// ===========================================================================
// 基础类型
// ===========================================================================

/** 三个根目录的固定名称，创建小说时自动生成，且不可删除/重命名。 */
export type RootCategoryName = '设定' | '大纲' | '正文';

/** 与 `RootCategoryName` 对应的常量数组，可用于运行时枚举/校验/UI 下拉项。 */
export const ROOT_CATEGORY_NAMES: readonly RootCategoryName[] = ['设定', '大纲', '正文'] as const;

/**
 * 目录树节点（仅一层）。
 *
 * 对应 `Novel.listAsJson` 的返回，亦用于 `GET /api/novels/:id/tree`。
 *
 * - `category`：目录（含根目录与子目录）
 * - `document`：`*.md` 文档
 */
export type TreeNodeType = 'category' | 'document';

export interface TreeNode {
    type: TreeNodeType;
    /** 节点名称，目录无后缀，文档为 `xxx.md`。 */
    name: string;
}

// ===========================================================================
// 业务异常模型
// ===========================================================================

/** 后端 REST/MCP 统一错误响应外壳。 */
export interface ApiErrorBody {
    error: ApiErrorDetail;
}

export interface ApiErrorDetail {
    /** 异常类型的短标识，对应后端异常类名，如 `NotExistError`。 */
    type: string;
    /** 面向人类展示的错误信息。 */
    message: string;
}

/** 已知的业务异常类型名，与后端 `lib/errors.ts` 中的异常一一对应。 */
export type KnownErrorType =
    | 'InvalidPathError' // 400
    | 'OutOfBoundsError' // 400
    | 'NotExistError' // 404
    | 'ExistError' // 409
    | 'EditFailError' // 422
    | 'Unknown'; // 5xx / 解析失败兜底

// ===========================================================================
// 小说（Novel）相关 DTO
// ===========================================================================

/** 小说列表项，对应 `Novel.listAll` / `GET /api/novels`。 */
export interface NovelSummary {
    id: number;
    name: string;
}

/** 小说详情，对应 `Novel.byID` / `GET /api/novels/:id` / `POST /api/novels` 的响应。 */
export interface NovelDetail extends NovelSummary {
    info: string;
}

/** 创建小说请求体，对应 `POST /api/novels`。 */
export interface CreateNovelRequest {
    name: string;
}

/**
 * 修改小说元信息请求体，对应 `PATCH /api/novels/:id`（合并语义）。
 *
 * 三个字段任意可选；`info` 与 `infoEdit` 互斥（同时出现时由后端决定优先级或报错）。
 */
export interface PatchNovelRequest {
    /** 触发 `Novel.rename`（新名称不能与其它小说重名）。 */
    name?: string;
    /** 触发 `Novel.writeInfo`，整体覆盖 `info`。 */
    info?: string;
    /** 触发 `Novel.editInfo`，按正则替换 `info`；若未产生变化抛 `EditFailError`（422）。 */
    infoEdit?: {
        regex: string;
        replace: string;
        flags?: string;
    };
}

// ===========================================================================
// 目录浏览 / 树相关 DTO
// ===========================================================================

/** `GET /api/novels/:id/list` 与 `GET /api/novels/:id/tree` 的查询串参数。 */
export interface ListQuery {
    /** 绝对目录路径，如 `/设定`。 */
    path: string;
    /** 是否递归（仅 `list` 接口生效；递归最大深度由后端固定为 5）。 */
    recursive?: boolean;
}

/** `GET /api/novels/:id/list` 与 `/tree` 的响应。 */
export type ListResponse = TreeNode[];
/**
 * `GET /api/novels/:id/list`（人类可读缩进格式）的原始响应类型，是缩进文本。
 * 仅作为别名以便区分接口风格；实际类型为 `string`。 */
export type ListTextResponse = string;

// ===========================================================================
// 文档读写相关 DTO
// ===========================================================================

/** 文档引用（含正文），对应 `Novel.read` 返回项、`POST /read` 响应项。 */
export interface DocumentRef {
    /** 绝对路径，如 `/设定/世界/人物卡.md`。 */
    path: string;
    /** 文档正文（markdown 纯文本）。 */
    text: string;
}

/** 批量读取请求体，对应 `POST /api/novels/:id/read`。至少提供一个路径。 */
export interface ReadRequest {
    paths: string[];
}

/** 批量读取响应。 */
export type ReadResponse = DocumentRef[];

/** 写入文档请求体（整体覆盖），对应 `POST /api/novels/:id/write`。 */
export interface WriteDocumentRequest {
    /** 绝对路径，至少两级（`splitted.length >= 2`），禁止写入根目录本身。 */
    path: string;
    text: string;
}

/**
 * 正则替换编辑文档请求体，对应 `POST /api/novels/:id/edit`。
 *
 * 后端读取 → 替换 → 整体写回；若替换前后无变化抛 `EditFailError`（422）。
 */
export interface EditDocumentRequest {
    path: string;
    regex: string;
    replace: string;
    /** 可选，正则 flag，如 `g`、`gi`。 */
    flags?: string;
}

// ===========================================================================
// 语义检索相关 DTO
// ===========================================================================

/** 语义检索请求体，对应 `POST /api/novels/:id/search`。 */
export interface SearchRequest {
    /** 限定在三个根目录之一内检索。 */
    rootCategory: RootCategoryName;
    /** 一到多条查询关键词。 */
    texts: string[];
    /** 返回结果数量，取值范围 `1..20`，越界由后端抛 `OutOfBoundsError`。 */
    limit: number;
}

/** 语义检索单条结果。 */
export interface SearchResultItem {
    /** 绝对路径。 */
    path: string;
    /** 文档正文（或 chunk 摘要，由后端决定）。 */
    text: string;
}

/** 语义检索响应。 */
export type SearchResponse = SearchResultItem[];
