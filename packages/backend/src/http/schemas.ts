/**
 * 运行时校验 schema（Zod）。
 *
 * 每个编写期对应 DTO 接口在路由 handler 的形参/返回类型处显式声明，依靠 `z.infer` 与
 * `@novel-writer/shared` 的同名 DTO 接口做合同约束，避免漂移。
 */

import { z } from 'zod';
import { ROOT_CATEGORY_NAMES } from '@novel-writer/shared';

// ===========================================================================
// 辅助 schema
// ===========================================================================

/** 路径：绝对路径，以 `/` 起始。深层语义校验由业务层完成。 */
const absolutePath = z.string().min(1).startsWith('/');

// ===========================================================================
// Novels
// ===========================================================================

export const createNovelSchema = z.object({
    name: z.string().min(1),
});

export const patchNovelSchema = z
    .object({
        name: z.string().min(1).optional(),
        info: z.string().optional(),
        infoEdit: z
            .object({
                regex: z.string(),
                replace: z.string(),
                flags: z.string().optional(),
            })
            .optional(),
    })
    .refine((data) => !(data.info !== undefined && data.infoEdit !== undefined), {
        message: '`info` 与 `infoEdit` 互斥，不能同时提供',
    });

// ===========================================================================
// Categories / 列目录
// ===========================================================================

export const listQuerySchema = z.object({
    path: absolutePath,
    recursive: z
        .union([z.string(), z.boolean()])
        .optional()
        .transform((v) => {
            if (v === undefined) return false;
            if (typeof v === 'boolean') return v;
            return v === 'true' || v === '1' || v.toLowerCase() === 'yes';
        }),
});

// ===========================================================================
// Documents
// ===========================================================================

export const readSchema = z.object({
    paths: z.array(absolutePath).min(1),
});

export const writeDocumentSchema = z.object({
    path: absolutePath,
    text: z.string(),
});

export const editDocumentSchema = z.object({
    path: absolutePath,
    regex: z.string(),
    replace: z.string(),
    flags: z.string().optional(),
});

export const searchSchema = z.object({
    rootCategory: z.enum(ROOT_CATEGORY_NAMES),
    texts: z.array(z.string()).min(1),
    limit: z.number().int().min(1).max(20),
});
