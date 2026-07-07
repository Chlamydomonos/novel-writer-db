/**
 * `/api/novels/:novelId/{list,tree,categories}` 路由实现。
 *
 * 覆盖 `Novel.list/listAsJson/createCategory/deleteCategory`。
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ListResponse } from '@novel-writer/shared';
import { createCategorySchema, listQuerySchema } from '../schemas.js';
import { loadNovelOrError } from './novels.js';

export async function registerCategoryRoutes(app: FastifyInstance) {
    const withNovel = { preHandler: loadNovelOrError };

    // -----------------------------------------------------------------------
    // 列出某路径下的内容（人类可读缩进文本）
    // -----------------------------------------------------------------------
    app.get('/api/novels/:novelId/list', { ...withNovel }, async (request, reply) => {
        const parsed = listQuerySchema.safeParse(request.query);
        if (!parsed.success) {
            return reply.code(400).send({ error: { type: 'InvalidPathError', message: parsed.error.message } });
        }
        const text = await request.novel!.list(parsed.data.path, parsed.data.recursive);
        // 文档约定返回 text/plain
        return reply.type('text/plain; charset=utf-8').send(text);
    });

    // -----------------------------------------------------------------------
    // 以 JSON 列目录（仅一层）
    // -----------------------------------------------------------------------
    app.get('/api/novels/:novelId/tree', { ...withNovel }, async (request, reply): Promise<ListResponse> => {
        const parsed = listQuerySchema.pick({ path: true }).safeParse(request.query);
        if (!parsed.success) {
            return reply.code(400).send({ error: { type: 'InvalidPathError', message: parsed.error.message } });
        }
        return await request.novel!.listAsJson(parsed.data.path);
    });

    // -----------------------------------------------------------------------
    // 创建空目录（支持按路径逐级创建中间目录）
    // -----------------------------------------------------------------------
    app.post('/api/novels/:novelId/categories', { ...withNovel }, async (request, reply) => {
        const parsed = createCategorySchema.safeParse(request.body ?? {});
        if (!parsed.success) {
            return reply.code(400).send({ error: { type: 'InvalidPathError', message: parsed.error.message } });
        }
        await request.novel!.createCategory(parsed.data.path);
        return reply.code(204).send();
    });

    // -----------------------------------------------------------------------
    // 删除目录（禁止删除根目录）
    // -----------------------------------------------------------------------
    app.delete('/api/novels/:novelId/categories', { ...withNovel }, async (request, reply) => {
        const path = (request.query as Record<string, string | undefined>)['path'];
        if (!path) {
            return reply.code(400).send({ error: { type: 'InvalidPathError', message: '缺少必填查询参数 `path`' } });
        }
        await request.novel!.deleteCategory(path);
        return reply.code(204).send();
    });
}

// 仅用于显式标注 reply 参数被使用
export type { FastifyReply };
