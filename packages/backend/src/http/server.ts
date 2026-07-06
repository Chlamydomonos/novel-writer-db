/**
 * Fastify 应用装配。
 *
 * - 注册所有路由（novels / documents / categories / **MCP `/mcp`**）
 * - 全局错误处理器：把业务异常映射为统一错误响应体
 * - MCP 路由通过 `createMcpHandler` + `toNodeHandler` 接入（SDK v2 推荐姿势，
 *   见 `docs/mcp-server.md` 与 SDK 文档 `serving/fastify.md`）
 *
 * 不在此处监听端口；端口绑定由 `main.ts` 处理，便于测试时使用 `app.inject`。
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { sendError } from './errors.js';
import { registerCategoryRoutes } from './routes/categories.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerNovelRoutes } from './routes/novels.js';
import { buildMcpServer } from '../mcp/server.js';
import { MCP_PATH } from './mcp.js';

export async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({
        logger: true,
    });

    // 全局错误处理器：handler 抛出的异常在此统一映射。
    app.setErrorHandler((err, _request, reply) => {
        // Fastify 自身的 schema 校验错误 → 400
        if (err instanceof Error && 'validation' in err) {
            return reply.code(400).send({ error: { type: 'InvalidPathError', message: err.message } });
        }
        return sendError(reply, err);
    });

    await app.register(registerNovelRoutes);
    await app.register(registerDocumentRoutes);
    await app.register(registerCategoryRoutes);

    // ---------------------------------------------------------------------
    // 挂载 MCP 单 endpoint：`POST|GET|DELETE /mcp`。
    //
    // `createMcpHandler(factory)` 把 factory 包成 web 标准 handler；
    // `toNodeHandler` 把 web 标准 handler 适配成 Node (req,res) 风格。
    // 每个 HTTP 请求 factory 会跑一次 → 每次请求一个全新的 McpServer 实例，
    // 天然隔离不同小说（目标小说由 `X-Novel-Id` 请求头决定）。
    //
    // Fastify 会自动解析 JSON body，故 `request.body` 已是对象，按 SDK 文档建议
    // 作为 `toNodeHandler` 第三个参数传入，避免重复读取已消费的请求流。
    // ---------------------------------------------------------------------
    const handler = createMcpHandler(() => buildMcpServer());
    const nodeHandler = toNodeHandler(handler);
    app.all(MCP_PATH, (request, reply) => {
        // toNodeHandler 返回 Promise<void>（已通过 reply.raw 写回响应）。
        //
        // 类型断言：`toNodeHandler` 的入参是 SDK 的 `NodeIncomingMessageLike`,
        // 与 Fastify 的 `request.raw: IncomingMessage` 在 `exactOptionalPropertyTypes: true`
        // 严苛模式下不可直接赋值（SDK 文档示例本身也按此形态桥接,运行期行为一致）。
        return nodeHandler(
            request.raw as Parameters<typeof nodeHandler>[0],
            reply.raw,
            request.body as Parameters<typeof nodeHandler>[2],
        );
    });

    return app;
}
