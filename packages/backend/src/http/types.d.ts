/**
 * Fastify 请求类型的本地扩展。
 *
 * 仅在本 HTTP 二进制内部使用，不对外暴露类型；前端/MCP 都通过 `@novel-writer/shared` 引用 DTO。
 */

import type { Novel } from '../lib/novel.js';

declare module 'fastify' {
    interface FastifyRequest {
        /** 在 `/:novelId` 前置 hook 中加载的小说实例。 */
        novel?: Novel;
    }
}

export {};
