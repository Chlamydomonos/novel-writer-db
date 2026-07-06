/**
 * 业务异常 → HTTP 状态码映射，与 [HTTP API 错误响应](../../docs/http-api.md#错误响应) 一致。
 */

import type { FastifyReply } from 'fastify';
import type { ApiErrorBody } from '@novel-writer/shared';
import { EditFailError, ExistError, InvalidPathError, NotExistError, OutOfBoundsError } from '../lib/errors.js';

/**
 * 把业务异常映射为 Fastify 响应，写入 `{ error: { type, message } }`。
 *
 * - `InvalidPathError` / `OutOfBoundsError` → 400
 * - `NotExistError` → 404
 * - `ExistError` → 409
 * - `EditFailError` → 422
 * - 其它 → 500
 */
export function mapError(err: unknown): { status: number; body: ApiErrorBody } {
    const toBody = (type: string, message: string): ApiErrorBody => ({
        error: { type, message },
    });

    if (err instanceof InvalidPathError || err instanceof OutOfBoundsError) {
        return { status: 400, body: toBody(err.constructor.name, err.message) };
    }
    if (err instanceof NotExistError) {
        return { status: 404, body: toBody(err.constructor.name, err.message) };
    }
    if (err instanceof ExistError) {
        return { status: 409, body: toBody(err.constructor.name, err.message) };
    }
    if (err instanceof EditFailError) {
        return { status: 422, body: toBody(err.constructor.name, err.message) };
    }

    const message = err instanceof Error ? err.message : String(err);
    return { status: 500, body: toBody('Unknown', message) };
}

/** 把异常写回 reply，保留不含堆栈的对外错误体。 */
export function sendError(reply: FastifyReply, err: unknown) {
    const { status, body } = mapError(err);
    return reply.code(status).send(body);
}
