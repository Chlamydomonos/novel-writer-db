/**
 * `/api/novels*` 路由实现，覆盖 `Novel.listAll/byID/create/rename/writeInfo/editInfo/destroy`
 * 以及归档的导出 / 导入。
 *
 * 导入采用**后台任务**模型：校验归档后立刻返回 `202`，重活（重建内容 + 重新嵌入全部向量）
 * 在进程内异步执行，进度通过 `GET /api/novels` 附加的 `importPhase` 字段轮询观测。
 * 这样单次 HTTP 请求始终很短，不会被 nginx `proxy_read_timeout` 切断。
 */

import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ImportNovelAccepted, NovelArchive, NovelDetail, NovelSummary } from '@novel-writer/shared';
import { Novel } from '../../lib/novel.js';
import {
    beginImport,
    clearImportState,
    completeImport,
    failImport,
    getImportState,
    isImporting,
} from '../../lib/import-state.js';
import { createNovelSchema, novelArchiveSchema, patchNovelSchema } from '../schemas.js';
import { sendError } from '../errors.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** 导入请求体上限（gzip 压缩后的字节数）。 */
const IMPORT_BODY_LIMIT = 128 * 1024 * 1024;

export async function registerNovelRoutes(app: FastifyInstance) {
    // -----------------------------------------------------------------------
    // 列出全部小说（附带内存中的导入状态）
    // -----------------------------------------------------------------------
    app.get('/api/novels', async (): Promise<NovelSummary[]> => {
        const list = await Novel.listAll();
        return list.map((novel) => withImportState(novel));
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
        const novel = request.novel!;
        await novel.destroy();
        // 清掉可能残留的导入状态（`failed` 记录），避免内存滞留。
        clearImportState(novel.id);
        return reply.code(204).send();
    });

    // -----------------------------------------------------------------------
    // 导出：gzip 压缩的 JSON 归档（仅文本，不含向量）
    //
    // 响应为 `application/gzip` 附件，文件名优先使用小说名（RFC 5987 `filename*`），
    // 同时提供 ASCII 兜底名，兼容不识别 `filename*` 的客户端。
    // -----------------------------------------------------------------------
    app.get('/api/novels/:novelId/export', { ...withNovel }, async (request, reply) => {
        const novel = request.novel!;
        const archive = await novel.exportArchive();
        const body = await gzipAsync(Buffer.from(JSON.stringify(archive), 'utf8'));

        const filename = `${novel.name.trim() || `novel-${novel.id}`}.nwd.gz`;
        const encodedFilename = encodeURIComponent(filename).replace(
            /['()*]/g,
            (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
        );

        return reply
            .header('Content-Type', 'application/gzip')
            .header(
                'Content-Disposition',
                `attachment; filename="novel-${novel.id}.nwd.gz"; filename*=UTF-8''${encodedFilename}`,
            )
            .send(body);
    });

    // -----------------------------------------------------------------------
    // 导入：请求体为 gzip 压缩的归档 JSON
    //
    // 覆盖目标小说的全部目录与文档（名称 / 简介保持不变），并重新计算所有向量。
    //
    // 两阶段执行，避免长连接被反代超时切断：
    //   1) 同步阶段（请求内）：解压 + JSON 解析 + 结构校验 → 失败可立即返回 400；
    //   2) 后台阶段（响应后）：落库 + 重建 collection + 重新嵌入 → 完成后清除状态。
    //
    // 进度不通过本接口回传（连接已断开），而是由 `GET /api/novels` 的 `importPhase` 暴露。
    // `novelId` 前置 hook 不能复用 `loadNovelOrError`——后者会拒绝"导入中"的小说。
    // -----------------------------------------------------------------------
    app.post(
        '/api/novels/:novelId/import',
        { bodyLimit: IMPORT_BODY_LIMIT },
        async (request, reply): Promise<ImportNovelAccepted> => {
            const raw = (request.params as { novelId?: string }).novelId;
            const id = Number(raw);
            if (!Number.isInteger(id) || id <= 0) {
                return reply.code(400).send({
                    error: { type: 'InvalidPathError', message: `\`novelId\` 必须为正整数，收到: ${raw}` },
                });
            }

            const body: unknown = request.body;
            if (!Buffer.isBuffer(body)) {
                return reply.code(400).send({
                    error: {
                        type: 'InvalidPathError',
                        message: '请求体必须是 gzip 压缩的归档文件（Content-Type: application/gzip）',
                    },
                });
            }

            // 先占用槽位，避免同一小说并发导入（解析期间也视为占用，故此处即占据）。
            if (!beginImport(id)) {
                return reply.code(409).send({
                    error: { type: 'ExistError', message: `ID为${id}的小说正在导入中，请等待完成后再试` },
                });
            }

            // 占位后任何提前返回都必须释放/标记，否则小说会被永久卡在"导入中"。
            const reject = (message: string) => {
                failImport(id, message);
                return reply.code(400).send({ error: { type: 'InvalidPathError', message } });
            };

            let novel: Novel;
            try {
                novel = await Novel.byID(id);
            } catch (err) {
                clearImportState(id);
                return sendError(reply, err);
            }

            let archive: NovelArchive;
            try {
                const json: unknown = JSON.parse((await gunzipAsync(body)).toString('utf8'));
                const parsed = novelArchiveSchema.safeParse(json);
                if (!parsed.success) {
                    return reject(parsed.error.message);
                }
                archive = parsed.data;
            } catch (err) {
                return reject(`无法解析归档文件：${err instanceof Error ? err.message : String(err)}`);
            }

            // 响应先发出去（连接立即结束），后台任务在进程内继续跑。
            void runImportInBackground(novel, archive, app.log);

            return reply.code(202).send({ novelId: novel.id, name: novel.name, importPhase: 'importing' });
        },
    );
}

/**
 * 后台执行归档导入：重建目录/文档、重算全部向量，并维护内存状态。
 *
 * 不 await、不抛错（异常一律转成 `failed` 状态），因此不会影响任何请求的生命周期。
 */
async function runImportInBackground(novel: Novel, archive: NovelArchive, log: FastifyBaseLogger) {
    const startedAt = Date.now();
    try {
        const result = await novel.importArchive(archive);
        completeImport(novel.id);
        log.info(
            {
                novelId: novel.id,
                categories: result.stats.categories,
                documents: result.stats.documents,
                elapsedMs: Date.now() - startedAt,
            },
            '归档导入完成',
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failImport(novel.id, message);
        log.error({ err, novelId: novel.id }, '归档导入失败');
    }
}

// ===========================================================================
// 内部工具
// ===========================================================================

/**
 * 把内存中的导入状态附加到列表项上（无状态则原样返回）。
 *
 * 用泛型保持入参的额外字段（如 `NovelDetail.info`），避免调用处再做类型断言。
 */
function withImportState<T extends NovelSummary>(novel: T): T {
    const state = getImportState(novel.id);
    if (!state) {
        return novel;
    }
    return state.error === undefined
        ? { ...novel, importPhase: state.phase }
        : { ...novel, importPhase: state.phase, importError: state.error };
}

function detailOf(novel: Novel): NovelDetail {
    return withImportState<NovelDetail>({ id: novel.id, name: novel.name, info: novel.info });
}

/**
 * `:novelId` 前置 hook：解析、加载 Novel 实例。
 *
 * 失败时直接回送错误响应；成功时把 `novel` 挂在 request 上。
 *
 * 若该小说正有后台导入任务在跑，则拒绝本次请求（409）：此时目录/文档正在被清空重建，
 * 任何读写都可能看到半成品状态。导入接口自身不使用本 hook（见 `POST .../import`）。
 */
export async function loadNovelOrError(request: FastifyRequest, reply: FastifyReply) {
    const raw = (request.params as { novelId?: string }).novelId;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
        return reply
            .code(400)
            .send({ error: { type: 'InvalidPathError', message: `\`novelId\` 必须为正整数，收到: ${raw}` } });
    }
    if (isImporting(id)) {
        return reply.code(409).send({
            error: { type: 'ExistError', message: `ID为${id}的小说正在导入中，请等待完成后重试` },
        });
    }
    try {
        request.novel = await Novel.byID(id);
    } catch (err) {
        return sendError(reply, err);
    }
}
