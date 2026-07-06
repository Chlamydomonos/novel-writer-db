/**
 * `/api/novels/:novelId/{read,write,edit,search,documents}` 路由实现。
 *
 * 覆盖 `Novel.read/write/edit/search/deleteDocument`。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DocumentRef, ReadResponse, SearchResponse } from '@novel-writer/shared';
import { editDocumentSchema, readSchema, searchSchema, writeDocumentSchema } from '../schemas.js';
import { loadNovelOrError } from './novels.js';

export async function registerDocumentRoutes(app: FastifyInstance) {
    const withNovel = { preHandler: loadNovelOrError };

    // -----------------------------------------------------------------------
    // 批量读取文档
    // -----------------------------------------------------------------------
    app.post('/api/novels/:novelId/read', { ...withNovel }, async (request, reply): Promise<ReadResponse> => {
        const parsed = readSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: { type: 'InvalidPathError', message: parsed.error.message } });
        }
        const docs = await request.novel!.read(parsed.data.paths);
        return docs satisfies DocumentRef[];
    });

    // -----------------------------------------------------------------------
    // 写入文档（整体覆盖），自动建目录；不允许写根目录
    // -----------------------------------------------------------------------
    app.post('/api/novels/:novelId/write', { ...withNovel }, async (request, reply) => {
        const parsed = writeDocumentSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: { type: 'InvalidPathError', message: parsed.error.message } });
        }
        await request.novel!.write(parsed.data.path, parsed.data.text);
        return reply.code(204).send();
    });

    // -----------------------------------------------------------------------
    // 正则编辑文档（替换前后无变化抛 EditFailError → 422）
    // -----------------------------------------------------------------------
    app.post('/api/novels/:novelId/edit', { ...withNovel }, async (request, reply) => {
        const parsed = editDocumentSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: { type: 'InvalidPathError', message: parsed.error.message } });
        }
        const { path, regex, replace, flags } = parsed.data;
        await request.novel!.edit(path, regex, replace, flags);
        return reply.code(204).send();
    });

    // -----------------------------------------------------------------------
    // 语义检索
    // -----------------------------------------------------------------------
    app.post('/api/novels/:novelId/search', { ...withNovel }, async (request, reply): Promise<SearchResponse> => {
        const parsed = searchSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: { type: 'InvalidPathError', message: parsed.error.message } });
        }
        const { rootCategory, texts, limit } = parsed.data;
        return await request.novel!.search(rootCategory, texts, limit);
    });

    // -----------------------------------------------------------------------
    // 删除文档
    // -----------------------------------------------------------------------
    app.delete('/api/novels/:novelId/documents', { ...withNovel }, async (request, reply) => {
        const path = (request.query as Record<string, string | undefined>)['path'];
        if (!path) {
            return reply.code(400).send({ error: { type: 'InvalidPathError', message: '缺少必填查询参数 `path`' } });
        }
        await request.novel!.deleteDocument(path);
        return reply.code(204).send();
    });
}

// 仅为 `request` 形参使用以避免 lint 警告（Fastify handler 总会接收 request）。
export type { FastifyRequest };
