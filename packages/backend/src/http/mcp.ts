/**
 * MCP HTTP endpoint 的配置与可覆盖项。
 *
 * 集中放置从环境变量读取的运行时配置，避免散落在 `main.ts` 与 `http/server.ts` 的字符串字面量中。
 *
 * | 环境变量 | 默认 | 作用 |
 * | --- | --- | --- |
 * | `MCP_PATH` | `/mcp` | 单 endpoint 挂载路径 |
 * | `MCP_NOVEL_ID_HEADER` | `x-novel-id` | 工具用作目标小说 ID 的请求头名（实际逻辑在 `mcp/context.ts`） |
 *
 * 注：DNS 反向绑定（Host/Origin）校验由 `createMcpFastifyApp` 提供，但它内部用一个独立 Fastify 实例；
 * 本项目把 MCP 挂在主 Fastify 上（与 `/api/*` 共用），因此无需（也无需重复）启用该机制——
 * 若需要发布到公网，应在反向代理层（Caddy/Nginx）做 Host 校验。
 */

/** MCP 单 endpoint 挂载路径（兼容带/不带前导斜杠的环境变量）。 */
export const MCP_PATH = normalizePath(process.env.MCP_PATH ?? '/mcp');

function normalizePath(raw: string): string {
    return raw.startsWith('/') ? raw : `/${raw}`;
}
