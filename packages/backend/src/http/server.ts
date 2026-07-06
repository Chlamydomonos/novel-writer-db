/**
 * Fastify 应用装配。
 *
 * - 注册所有路由（novels / documents / categories）
 * - 全局错误处理器：把业务异常映射为统一错误响应体
 *
 * 不在此处监听端口；端口绑定由 `main.ts` 处理，便于测试时使用 `app.inject`。
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { sendError } from './errors.js';
import { registerCategoryRoutes } from './routes/categories.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerNovelRoutes } from './routes/novels.js';

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

    return app;
}
