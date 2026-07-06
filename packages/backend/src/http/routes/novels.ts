/**
 * `/api/novels*` 路由实现，覆盖 `Novel.listAll/byID/create/rename/writeInfo/editInfo/destroy`。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Novel } from '../../lib/novel.js';
import type { NovelDetail, NovelSummary } from '@novel-writer/shared';
import { createNovelSchema, patchNovelSchema } from '../schemas.js';
import { sendError } from '../errors.js';

export async function registerNovelRoutes(app: FastifyInstance) {
    // -----------------------------------------------------------------------
    // 列出全部小说
    // -----------------------------------------------------------------------
    app.get('/api/novels', async (): Promise<NovelSummary[]> => {
        return await Novel.listAll();
    });

    // -----------------------------------------------------------------------
    // 创建小说
    // -----------------------------------------------------------------------
    app.post('/api/novels', async (request, reply): Promise<NovelDetail> => {
        const parsed = createNovelSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: { type: 'InvalidPathError', message: parsed.error.message } });
        }
        // name 重名时由业务层抛 ExistError → 409。
        const novel = await Novel.create(parsed.data.name);
        return detailOf(novel);
    });

    // -----------------------------------------------------------------------
    // 获取 / 修改 / 删除 单本小说
    // -----------------------------------------------------------------------
    const withNovel = { preHandler: loadNovelOrError };

    app.get('/api/novels/:novelId', { ...withNovel }, (request) => detailOf(request.novel!));

    app.patch('/api/novels/:novelId', { ...withNovel }, async (request, reply) => {
        const parsed = patchNovelSchema.safeParse(request.body ?? {});
        if (!parsed.success) {
            return reply.code(400).send({ error: { type: 'InvalidPathError', message: parsed.error.message } });
        }

        const novel = request.novel!;
        const { name, info, infoEdit } = parsed.data;
        // schema 已保证 info / infoEdit 互斥
        if (info !== undefined) {
            await novel.writeInfo(info);
        } else if (infoEdit !== undefined) {
            await novel.editInfo(infoEdit.regex, infoEdit.replace, infoEdit.flags);
        }
        if (name !== undefined) {
            await novel.rename(name);
        }

        // info/rename 已就地更新实例字段，直接返回实例视图。
        return detailOf(novel);
    });

    app.delete('/api/novels/:novelId', { ...withNovel }, async (request, reply) => {
        await request.novel!.destroy();
        return reply.code(204).send();
    });
}

// ===========================================================================
// 内部工具
// ===========================================================================

function detailOf(novel: Novel): NovelDetail {
    return { id: novel.id, name: novel.name, info: novel.info };
}

/**
 * `:novelId` 前置 hook：解析、加载 Novel 实例。
 *
 * 失败时直接回送错误响应；成功时把 `novel` 挂在 request 上。
 */
export async function loadNovelOrError(request: FastifyRequest, reply: FastifyReply) {
    const raw = (request.params as { novelId?: string }).novelId;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
        return reply
            .code(400)
            .send({ error: { type: 'InvalidPathError', message: `\`novelId\` 必须为正整数，收到: ${raw}` } });
    }
    try {
        request.novel = await Novel.byID(id);
    } catch (err) {
        return sendError(reply, err);
    }
}
