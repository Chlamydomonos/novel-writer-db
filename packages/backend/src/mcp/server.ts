/**
 * MCP server 装配工厂。
 *
 * v2 起 transport 由 `createMcpHandler` 自行托管（不再是"创建 McpServer + connect transport"两步），
 * 因此本模块只对外暴露一个 **per-request factory**（`createMcpHandler` 期望的形态）：
 *   `() => McpServer`
 * 每次 HTTP 请求都会调用一次该 factory，返回的 `McpServer` 实例仅服务当次请求，
 * 天然隔离了不同小说/会话间的状态。
 *
 * 真正把 factory 挂到 HTTP `/mcp` 路径的逻辑在 `http/server.ts` 的 `buildApp` 中，
 * 使用 `createMcpHandler` + `toNodeHandler` 完成（见
 * [docs/mcp-server.md](../../docs/mcp-server.md) 与 SDK 文档 `serving/fastify.md`）。
 */

import { McpServer } from '@modelcontextprotocol/server';
import { registerNovelTools } from './tools.js';

/** MCP server 对外通告的名称与版本（协议 initialize 阶段返回）。 */
export const MCP_SERVER_NAME = 'novel-writer-mcp';
export const MCP_SERVER_VERSION = '0.1.0';

/**
 * 创建一个新的 `McpServer` 并注册全部 9 个 MCP 工具。
 *
 * 这是 `createMcpHandler` 期望的 factory：每次 HTTP 请求都会调用一次，
 * 由于每次返回的是全新实例，无需担心跨小说的状态串扰。
 *
 * @returns 已装配工具、尚未绑定到任何 transport 的 `McpServer`
 */
export function buildMcpServer(): McpServer {
    const server = new McpServer(
        { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        {
            // 简短的运维指引；具体工具使用方式由各工具 description 提供。
            instructions:
                '本服务器暴露单个小说项目的文档/目录/语义检索能力。' +
                '目标小说由请求头 `X-Novel-Id` 决定，可在多轮对话间切换。',
        },
    );

    registerNovelTools(server);

    return server;
}
