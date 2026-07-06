/**
 * MCP 工具调用上下文：从请求头解析目标小说。
 *
 * 设计目标见 [docs/mcp-server.md](../../docs/mcp-server.md#请求头与小说绑定)：
 * - 单次请求即绑定小说，自定义请求头（默认 `X-Novel-Id`）注入；
 * - 服务端在每次工具调用前重新读取最新的请求头，允许客户端中途切换目标小说；
 * - 请求头缺失/非数字 → `InvalidPathError`（最终映射 400）；小说不存在 → `NotExistError`（404）。
 *
 * 本模块只负责"取头 → 取 Novel 实例"，不做任何路径合法性校验（那由 `Novel.*` 与各工具 schema 负责）。
 *
 * > MCP SDK v2 起，handler context 的 `ctx.http?.req` 是标准 Web `Request`；
 * > 因此 `headers` 用标准 `Headers` 对象（`.get()` 取值；同名多值会被自动合并为 `, ` 连接的字符串）。
 */

import { Novel } from '../lib/novel.js';
import { InvalidPathError } from '../lib/errors.js';

/** 自定义请求头名，可通过环境变量覆盖（便于反向代理规范，见部署文档）。`Headers` 默认大小写不敏感。 */
export const MCP_NOVEL_ID_HEADER = process.env.MCP_NOVEL_ID_HEADER?.toLowerCase() ?? 'x-novel-id';

/**
 * 从 MCP 工具调用的请求头（HTTP transport 注入到 `ctx.http?.req?.headers`）取 `Novel` 实例。
 *
 * v2 起该方法接收的是标准 Web `Headers` 对象；若调用的 transport 不提供请求头（如 stdio），
 * `headers` 为 `undefined` → 抛 `InvalidPathError`。
 *
 * @param headers 来自 `ctx.http?.req?.headers`（标准 `Headers`）
 * @returns 已加载的小说实例
 */
export async function getNovelFromHeaders(headers: Headers | undefined): Promise<Novel> {
    const raw = headers?.get(MCP_NOVEL_ID_HEADER);
    // 排除 null（header 不存在）/ undefined（headers 不存在）/ 空串
    if (!raw) {
        throw new InvalidPathError(`缺少请求头 \`${MCP_NOVEL_ID_HEADER}\`（目标小说 ID）`);
    }
    return await resolveNovelById(raw);
}

/** 把请求头字面量解析为正整数 ID 并加载 `Novel`，ID 非法 → `InvalidPathError`；不存在 → `NotExistError`。 */
async function resolveNovelById(raw: string): Promise<Novel> {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
        throw new InvalidPathError(`请求头 \`${MCP_NOVEL_ID_HEADER}\` 必须为正整数，收到: ${raw}`);
    }
    // 小说不存在时由 Novel.byID 抛 NotExistError（→ 404）。
    return await Novel.byID(id);
}
