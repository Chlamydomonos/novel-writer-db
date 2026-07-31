/**
 * `/api/experiments*` 路由实现。
 *
 * 覆盖实验的导入、删除、列表、执行对比实验。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ImportExperimentResponse, RunExperimentResponse } from '@novel-writer/shared/dto-experiment';
import type { ExperimentSummary } from '@novel-writer/shared/dto-experiment';
import { importExperiment, deleteExperiment, listExperiments, runExperiment } from '../../lib/experiment.js';
import { NotExistError } from '../../lib/errors.js';
import { importExperimentSchema, runExperimentSchema } from '../schemas.js';

export async function registerExperimentRoutes(app: FastifyInstance) {
    // -----------------------------------------------------------------------
    // 导入实验数据
    // -----------------------------------------------------------------------
    app.post('/api/experiments/import', async (request, reply): Promise<ImportExperimentResponse> => {
        const name = (request.query as Record<string, string | undefined>)['name'];
        if (!name || name.trim().length === 0) {
            return reply.code(400).send({
                error: { type: 'InvalidPathError', message: '缺少必填查询参数 `name`' },
            });
        }

        const parsed = importExperimentSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: { type: 'InvalidPathError', message: parsed.error.message },
            });
        }

        const { settings, outlines, chapters } = parsed.data;
        return await importExperiment(name, settings, outlines, chapters);
    });

    // -----------------------------------------------------------------------
    // 列出全部实验
    // -----------------------------------------------------------------------
    app.get('/api/experiments', async (): Promise<ExperimentSummary[]> => {
        return await listExperiments();
    });

    // -----------------------------------------------------------------------
    // 删除实验
    // -----------------------------------------------------------------------
    app.delete('/api/experiments/:experimentId', async (request, reply) => {
        const raw = (request.params as { experimentId?: string }).experimentId;
        const experimentId = Number(raw);
        if (!Number.isInteger(experimentId) || experimentId <= 0) {
            return reply.code(400).send({
                error: {
                    type: 'InvalidPathError',
                    message: `\`experimentId\` 必须为正整数，收到: ${raw}`,
                },
            });
        }

        try {
            await deleteExperiment(experimentId);
        } catch (err) {
            if (err instanceof Error && err.message.includes('不存在')) {
                return reply.code(404).send({
                    error: { type: 'NotExistError', message: err.message },
                });
            }
            throw err;
        }

        return reply.code(204).send();
    });

    // -----------------------------------------------------------------------
    // 执行对比实验
    // -----------------------------------------------------------------------
    app.post('/api/experiments/:experimentId/run', async (request, reply): Promise<RunExperimentResponse> => {
        const raw = (request.params as { experimentId?: string }).experimentId;
        const experimentId = Number(raw);
        if (!Number.isInteger(experimentId) || experimentId <= 0) {
            return reply.code(400).send({
                error: {
                    type: 'InvalidPathError',
                    message: `\`experimentId\` 必须为正整数，收到: ${raw}`,
                },
            });
        }

        const parsed = runExperimentSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: { type: 'InvalidPathError', message: parsed.error.message },
            });
        }

        try {
            const { k, queries } = parsed.data;
            return await runExperiment(experimentId, k, queries);
        } catch (err) {
            if (err instanceof Error && err.message.includes('不存在')) {
                return reply.code(404).send({
                    error: { type: 'NotExistError', message: err.message },
                });
            }
            throw err;
        }
    });
}
