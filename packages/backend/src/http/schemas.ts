/**
 * 运行时校验 schema（Zod）。
 *
 * 每个编写期对应 DTO 接口在路由 handler 的形参/返回类型处显式声明，依靠 `z.infer` 与
 * `@novel-writer/shared` 的同名 DTO 接口做合同约束，避免漂移。
 */

import { z } from 'zod';
import { NOVEL_ARCHIVE_FORMAT, NOVEL_ARCHIVE_VERSION, ROOT_CATEGORY_NAMES } from '@novel-writer/shared';
import type { ArchiveNode, NovelArchive } from '@novel-writer/shared';
import type { ImportNode } from '@novel-writer/shared/dto-experiment';

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

export const createCategorySchema = z.object({
    path: absolutePath,
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

export const moveDocumentSchema = z.object({
    /** 源文档绝对路径。 */
    path: absolutePath,
    /** 目标文档绝对路径（换目录/改名）。 */
    to: absolutePath,
});

export const searchSchema = z.object({
    rootCategory: z.enum(ROOT_CATEGORY_NAMES),
    texts: z.array(z.string()).min(1),
    limit: z.number().int().min(1).max(20),
});

// ===========================================================================
// 小说归档（导入）
// ===========================================================================

/** 归档树节点（递归），结构与 `ImportNode` 一致。 */
const archiveNodeSchema: z.ZodType<ArchiveNode> = z.lazy(() =>
    z
        .object({
            name: z.string().min(1),
            content: z.string().optional(),
            children: z.array(archiveNodeSchema).optional(),
        })
        .refine(
            (n) => {
                const isDoc = n.name.endsWith('.md');
                if (isDoc) return n.content !== undefined && (n.children === undefined || n.children.length === 0);
                return n.content === undefined;
            },
            { message: '文档节点（.md）必须有 content 且无 children；目录节点不能有 content' },
        ),
);

/**
 * 归档文件（gzip 解压后的 JSON）结构校验。
 *
 * 更细的路径规则（非法名称、重名、目录不含 `.` 等）由 `Novel.importArchive` 内的
 * `normalizeArchive` 校验并抛出 `InvalidPathError`。
 */
export const novelArchiveSchema: z.ZodType<NovelArchive> = z.object({
    format: z.literal(NOVEL_ARCHIVE_FORMAT),
    version: z.literal(NOVEL_ARCHIVE_VERSION),
    exportedAt: z.string(),
    novel: z.object({
        name: z.string(),
        info: z.string(),
    }),
    roots: z.array(
        z.object({
            root: z.enum(ROOT_CATEGORY_NAMES),
            tree: z.array(archiveNodeSchema),
        }),
    ),
});

// ===========================================================================
// 实验相关 schema
// ===========================================================================

/** 导入节点（递归） */
const importNodeSchema: z.ZodType<ImportNode> = z.lazy(() =>
    z
        .object({
            name: z.string().min(1),
            content: z.string().optional(),
            children: z.array(importNodeSchema).optional(),
        })
        .refine(
            (n) => {
                const isDoc = n.name.endsWith('.md');
                if (isDoc) return n.content !== undefined && (n.children === undefined || n.children.length === 0);
                return n.content === undefined;
            },
            { message: '文档节点（.md）必须有 content 且无 children；目录节点不能有 content' },
        ),
);

export const importExperimentSchema = z.object({
    settings: z.array(importNodeSchema).optional().default([]),
    outlines: z.array(importNodeSchema).optional().default([]),
    chapters: z.array(importNodeSchema).optional().default([]),
});

export const testQuerySchema = z.object({
    query: z.string().min(1),
    rootCategory: z.enum(ROOT_CATEGORY_NAMES),
    relevantPaths: z.array(z.string().min(1).startsWith('/')).min(1),
});

export const runExperimentSchema = z.object({
    k: z.number().int().min(1).max(20).optional().default(5),
    queries: z.array(testQuerySchema).min(1),
});
