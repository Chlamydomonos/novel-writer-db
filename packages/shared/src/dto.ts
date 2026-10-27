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

/**
 * 小说归档导入的运行时状态。
 *
 * 仅保存在后端进程内存中（不落库）：`importing` 表示后台正在重建内容与向量，
 * `failed` 表示上一次导失败且尚未重试，正常小说不带该字段。
 */
export type NovelImportPhase = 'importing' | 'failed';

/**
 * 小说列表项，对应 `Novel.listAll` / `GET /api/novels`。
 *
 * `importPhase` / `importError` 由后端根据内存中的导入状态附加，与数据库无关。
 */
export interface NovelSummary {
    id: number;
    name: string;
    /** 后台导入状态；仅当该小说正在导入或上一次导入失败时出现。 */
    importPhase?: NovelImportPhase;
    /** 导入失败原因（仅 `importPhase === 'failed'` 时出现）。 */
    importError?: string;
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

/** 创建空目录请求体，对应 `POST /api/novels/:id/categories`。 */
export interface CreateCategoryRequest {
    /** 要创建的目录绝对路径，如 `/设定/世界观`。 */
    path: string;
}

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
// 文档链接（自动解析维护）
// ===========================================================================

/**
 * `DocumentLink` 入链目标在指向文档被删除后被改写成的字面量。
 *
 * 普通目标为以 `/` 开头的绝对路径，与该字面量无歧义。链接表由后端在写入/编辑文档时
 * 自动解析维护，不对 API 直接暴露写入接口。
 */
export const DELETED_LINK_TARGET = 'deleted';

/** 移动（含重命名）文档请求体，对应 `POST /api/novels/:id/move`。 */
export interface MoveDocumentRequest {
    /** 源文档绝对路径，如 `/设定/人物卡.md`。 */
    path: string;
    /** 目标文档绝对路径（目录不存在时自动创建），如 `/大纲/第一卷/人物卡.md`。 */
    to: string;
}

/** 移动文档响应/返回值。 */
export interface MoveDocumentResult {
    /** 旧绝对路径。 */
    from: string;
    /** 新绝对路径。 */
    to: string;
    /** 被重写指向新位置的链接记录数。 */
    updatedLinks: number;
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

// ===========================================================================
// 小说归档（导出 / 导入）
// ===========================================================================

/**
 * 归档文件格式标识。导出文件是 **gzip 压缩的 JSON**，解压后 `format` 字段必须等于该值。
 */
export const NOVEL_ARCHIVE_FORMAT = 'novel-writer-db';

/** 归档文件版本号；后续结构变更时递增，导入端据此拒绝不认识的版本。 */
export const NOVEL_ARCHIVE_VERSION = 1;

/**
 * 归档中的树节点（递归），与 `ImportNode` 结构一致：
 *
 * - 目录节点：只有 `name` 与（可选的）`children`，没有 `content`；
 * - 文档节点：`name` 以 `.md` 结尾，带 `content`（正文），没有 `children`。
 */
export interface ArchiveNode {
    name: string;
    content?: string | undefined;
    children?: ArchiveNode[] | undefined;
}

/** 单个根目录的归档内容。 */
export interface NovelArchiveRoot {
    /** 根目录名，`设定` / `大纲` / `正文` 之一。 */
    root: RootCategoryName;
    /** 该根目录下的整棵树。 */
    tree: ArchiveNode[];
}

/**
 * 导出文件（gzip 压缩前的 JSON）。
 *
 * **仅包含文本**：目录结构与文档正文；不包含 ChromaDB 向量。导入时后端会重新嵌入全部文档。
 */
export interface NovelArchive {
    format: typeof NOVEL_ARCHIVE_FORMAT;
    version: typeof NOVEL_ARCHIVE_VERSION;
    /** 导出时间（ISO 8601），仅作溯源信息。 */
    exportedAt: string;
    /** 导出时的元信息，仅作溯源信息（导入到已存在小说时**不会**覆盖目标小说的名称与简介）。 */
    novel: {
        name: string;
        info: string;
    };
    /** 三个根目录的树（即使某个根目录为空也会出现）。 */
    roots: NovelArchiveRoot[];
}

/**
 * `POST /api/novels/:id/import` 的响应体（`202 Accepted`）。
 *
 * 导入在后台执行（重建目录/文档并重新嵌入全部向量），故立即返回，避免长连接被反代超时切断。
 * 进度通过 `GET /api/novels` 上的 `importPhase` 轮询观测；接口完成后该字段消失，失败则为 `failed`。
 */
export interface ImportNovelAccepted {
    novelId: number;
    /** 目标小说名称（未因导入而改变）。 */
    name: string;
    /** 固定为 `importing`，指示后台任务已开始。 */
    importPhase: 'importing';
}

/**
 * 归档导入完成后台任务的统计结果（**不直接返回给客户端**）。
 *
 * 作为 `Novel.importArchive` 的返回值记录到日志，便于排查导入规模。
 */
export interface ImportNovelResult {
    novelId: number;
    /** 目标小说名称（未因导入而改变）。 */
    name: string;
    stats: {
        /** 新建的目录数（不含三个根目录）。 */
        categories: number;
        /** 写入并重新向量化的文档数。 */
        documents: number;
    };
}
