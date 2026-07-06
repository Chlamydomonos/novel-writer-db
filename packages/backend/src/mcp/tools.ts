/**
 * MCP 工具定义与注册。
 *
 * 暴露给 LLM 的工具白名单依据 [docs/mcp-server.md](../../docs/mcp-server.md#暴露的工具白名单)：
 * 凡 `novel.ts` 中**未**标注 `// 该接口不暴露给LLM` 的方法都对应一个 MCP 工具。
 *
 * 设计要点：
 * - 工具入参 schema 用 `z.object({...})` 包裹后交给 `McpServer.registerTool(name, { inputSchema: ... })`，
 *   SDK 会自动转换为 JSON Schema 并在调用前做校验，保证与 HTTP API 端 (`http/schemas.ts`) 一致。
 *   主动用 `z.object()` 包裹以消除 v2 SDK 对 raw shape 形式的 `@deprecated` 警告，
 *   同时避免 SDK 内部 `z.object()` 包裹可能引起的 transform 漂移。
 * - 目标小说完全由请求头 `x-novel-id` 决定；工具 handler 不接收 `novelId` 参数，而是通过
 *   v2 的 `ctx.http?.req?.headers` 调用 `getNovelFromHeaders` 实例化 `Novel` 后再执行
 *   （文档 §请求头与小说绑定）。
 * - 业务异常（包括 `EditFailError`）以 `isError: true` 的形式原样回传给 LLM，不抛协议层错误，
 *   便于 LLM 重试或放弃（文档 §安全与边界）。
 */

import { z } from 'zod';
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';
import { ROOT_CATEGORY_NAMES } from '@novel-writer/shared';
import { getNovelFromHeaders } from './context.js';

// ===========================================================================
// 共享 schema 片段（raw shape 形式，可直接喂给 registerTool）
// ===========================================================================

/** 路径：绝对路径，以 `/` 起始。深层语义由业务层完成。 */
const PathField = z.string().min(1).startsWith('/');

// ===========================================================================
// 辅助：把业务异常转成 `isError` 结果（错误文本回传给 LLM）
// ===========================================================================

/**
 * 把任意抛出的错误转换为 `CallToolResult`，保留异常类名前缀，便于 LLM 识别。
 *
 * 文档明确要求把 `EditFailError` 等失败原样回传给 LLM，因此这里**不区分**错误类型，
 * 一律以 isError 形式返回 —— MCP 协议级错误（抛 throw）会触发客户端 transports 的重连/重试，
 * 对 LLM 而言反而更不友好。
 */
function errorResult(err: unknown): CallToolResult {
    const tag = err instanceof Error ? err.constructor.name : 'Unknown';
    const message = err instanceof Error ? err.message : String(err);
    const text = `[${tag}] ${message}`;
    return {
        isError: true,
        content: [{ type: 'text', text }],
    };
}

/**
 * 把任意成功输出字符串化回 `CallToolResult`。
 *
 * MCP 工具结果以 `content[].text` 形式回传；本项目对工具结果统一用单条 JSON 文本，
 * 便于 LLM 解析与跨语言客户端兼容（强类型的 `structuredContent` 留给未来扩展）。
 */
function okResult(payload: unknown): CallToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
    };
}

// ===========================================================================
// 工具注册入口
// ===========================================================================

/**
 * 在给定的 `McpServer` 上注册全部 10 个"暴露给 LLM"的工具。
 *
 * @param server 待注册工具的 MCP server（由 `buildMcpServer` 创建）
 */
export function registerNovelTools(server: McpServer): void {
    // -----------------------------------------------------------------------
    // get_info —— 读取小说基本信息（name + info getter）
    // 该能力由 Novel 类的 getter 而非 async 方法提供，因此在工具层补全。
    // -----------------------------------------------------------------------
    server.registerTool(
        'get_info',
        {
            description:
                '读取当前小说的基本信息，返回 `{ name, info }`：' +
                '`name` 为小说名称，`info` 为小说的整段基本信息文本。' +
                '调用需在请求头携带目标小说 ID。',
            inputSchema: z.object({}),
        },
        async (_args, ctx) => {
            try {
                const novel = await getNovelFromHeaders(ctx.http?.req?.headers);
                return okResult({ name: novel.name, info: novel.info });
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    // -----------------------------------------------------------------------
    // write_info —— 整体覆盖小说的 info 字段
    // 成功返回 `{ name, info }`。
    // -----------------------------------------------------------------------
    server.registerTool(
        'write_info',
        {
            description:
                '整体覆盖小说的基本信息（`info` 字段，一段长文本）。' +
                '调用需在请求头携带目标小说 ID。成功返回最新 `{ name, info }`。',
            inputSchema: z.object({
                info: z.string().describe('新的小说基本信息全文'),
            }),
        },
        async ({ info }, ctx) => {
            try {
                const novel = await getNovelFromHeaders(ctx.http?.req?.headers);
                await novel.writeInfo(info);
                return okResult({ name: novel.name, info: novel.info });
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    // -----------------------------------------------------------------------
    // edit_info —— 正则替换编辑 info 字段
    // 无变化抛 EditFailError（这里转 isError）。
    // -----------------------------------------------------------------------
    server.registerTool(
        'edit_info',
        {
            description:
                '对小说基本信息 `info` 字段做正则替换。' +
                '若替换前后字符串相同，返回 EditFailError（可用于判断是否需要调整正则后重试）。',
            inputSchema: z.object({
                regex: z.string().describe('正则表达式源'),
                replace: z.string().describe('替换字符串'),
                flags: z.string().optional().describe('可选正则标志，如 `g`/`gi`'),
            }),
        },
        async ({ regex, replace, flags }, ctx) => {
            try {
                const novel = await getNovelFromHeaders(ctx.http?.req?.headers);
                await novel.editInfo(regex, replace, flags);
                return okResult({ name: novel.name, info: novel.info });
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    // -----------------------------------------------------------------------
    // list —— 列出目录（缩进文本，不含文档正文）
    // -----------------------------------------------------------------------
    server.registerTool(
        'list',
        {
            description:
                '列出指定目录下的内容，返回多行文本，每行格式为 `<emoji> <name>`：' +
                '🗂️ 表示非空目录、📁 表示空目录、📂 表示深度未知目录、📄 表示 markdown 文档。' +
                '目录层级通过缩进表示：每深一层缩进增加 2 个空格（与父级对齐即同一层级）。' +
                '`path` 必须为绝对路径（如 `/设定`）；`recursive=true` 时向下递归最多 5 层。' +
                '注意：返回的文本不包含文档正文。',
            inputSchema: z.object({
                path: PathField,
                recursive: z.boolean().optional().describe('是否递归子目录，默认 false；递归最大深度 5'),
            }),
        },
        async ({ path, recursive }, ctx) => {
            try {
                const novel = await getNovelFromHeaders(ctx.http?.req?.headers);
                const text = await novel.list(path, recursive ?? false);
                return okResult({ text });
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    // -----------------------------------------------------------------------
    // read_documents —— 批量读取 markdown 文档正文
    // -----------------------------------------------------------------------
    server.registerTool(
        'read_documents',
        {
            description:
                '批量读取 markdown 文档正文。`paths` 为绝对路径数组，每个路径必须以 `.md` 结尾，至少 1 个。' +
                '返回 `{ path, text }[]`。',
            inputSchema: z.object({
                paths: z.array(PathField).min(1).describe('绝对文件路径数组，每个必须以 `.md` 结尾'),
            }),
        },
        async ({ paths }, ctx) => {
            try {
                const novel = await getNovelFromHeaders(ctx.http?.req?.headers);
                const result = await novel.read(paths);
                return okResult(result);
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    // -----------------------------------------------------------------------
    // search —— 语义检索
    // -----------------------------------------------------------------------
    server.registerTool(
        'search',
        {
            description:
                '语义检索：在指定的根目录（`设定`/`大纲`/`正文`）内按文本相似度查询文档。' +
                '`limit` 取值范围 1..20。返回 `{ path, text }[]`。',
            inputSchema: z.object({
                rootCategory: z.enum(ROOT_CATEGORY_NAMES).describe('检索根目录'),
                texts: z.array(z.string()).min(1).describe('查询文本数组，至少 1 个'),
                limit: z.number().int().min(1).max(20).describe('返回结果数量，1..20'),
            }),
        },
        async ({ rootCategory, texts, limit }, ctx) => {
            try {
                const novel = await getNovelFromHeaders(ctx.http?.req?.headers);
                const result = await novel.search(rootCategory, texts, limit);
                return okResult(result);
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    // -----------------------------------------------------------------------
    // write_document —— 整体覆盖（或创建）一个 .md 文档
    // -----------------------------------------------------------------------
    server.registerTool(
        'write_document',
        {
            description:
                '整体覆盖或创建一个 `.md` 文档；中间目录会自动创建。' +
                '`path` 为绝对路径，必须以 `.md` 结尾，且路径项数不小于 2（如 `/设定/人物.md`）——' +
                '该限制用于阻止形如 `/xxx.md` 的访问；对形如 `/设定/xxx.md` 的访问没有限制。' +
                '成功返回 `{ ok: true }`。',
            inputSchema: z.object({
                path: PathField.describe('绝对文件路径，必须以 `.md` 结尾'),
                text: z.string().describe('完整正文'),
            }),
        },
        async ({ path, text }, ctx) => {
            try {
                const novel = await getNovelFromHeaders(ctx.http?.req?.headers);
                await novel.write(path, text);
                return okResult({ ok: true });
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    // -----------------------------------------------------------------------
    // edit_document —— 正则替换编辑指定文档
    // -----------------------------------------------------------------------
    server.registerTool(
        'edit_document',
        {
            description:
                '正则替换编辑指定文档：读取 → 替换 → 整体写回。' +
                '若替换前后无变化，返回 EditFailError（isError），可用于判断是否需调整正则。' +
                '成功返回 `{ ok: true }`。',
            inputSchema: z.object({
                path: PathField.describe('绝对文件路径，必须以 `.md` 结尾'),
                regex: z.string().describe('正则表达式源'),
                replace: z.string().describe('替换文本'),
                flags: z.string().optional().describe('可选正则标志'),
            }),
        },
        async ({ path, regex, replace, flags }, ctx) => {
            try {
                const novel = await getNovelFromHeaders(ctx.http?.req?.headers);
                await novel.edit(path, regex, replace, flags);
                return okResult({ ok: true });
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    // -----------------------------------------------------------------------
    // delete_document —— 删除一个 .md 文档
    // -----------------------------------------------------------------------
    server.registerTool(
        'delete_document',
        {
            description: '删除一个 `.md` 文档。`path` 为绝对文件路径。成功返回 `{ ok: true }`。',
            inputSchema: z.object({
                path: PathField.describe('绝对文件路径，必须以 `.md` 结尾'),
            }),
        },
        async ({ path }, ctx) => {
            try {
                const novel = await getNovelFromHeaders(ctx.http?.req?.headers);
                await novel.deleteDocument(path);
                return okResult({ ok: true });
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    // -----------------------------------------------------------------------
    // delete_category —— 删除一个非根目录及其下全部内容
    // -----------------------------------------------------------------------
    server.registerTool(
        'delete_category',
        {
            description:
                '删除一个**非根**目录及其下全部内容（递归）。' +
                '`path` 为绝对目录路径；若为根目录（`/设定`、`/大纲`、`/正文`）则返回 InvalidPathError。' +
                '成功返回 `{ ok: true }`。',
            inputSchema: z.object({
                path: PathField.describe('绝对目录路径，不含 `.md` 后缀'),
            }),
        },
        async ({ path }, ctx) => {
            try {
                const novel = await getNovelFromHeaders(ctx.http?.req?.headers);
                await novel.deleteCategory(path);
                return okResult({ ok: true });
            } catch (err) {
                return errorResult(err);
            }
        },
    );
}
