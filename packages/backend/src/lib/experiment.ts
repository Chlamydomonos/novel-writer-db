/**
 * 实验核心业务逻辑。
 *
 * 提供实验数据的导入、删除、列表查询，以及三根目录 vs 混合存储的对比检索实验。
 */

import { performance } from 'node:perf_hooks';
import type { RootCategoryName } from '@novel-writer/shared';
import { ROOT_CATEGORY_NAMES } from '@novel-writer/shared';
import type {
    AggregateMetrics,
    ImportExperimentResponse,
    ImportNode,
    PerQueryMetrics,
    RunExperimentResponse,
    TestQuery,
} from '@novel-writer/shared/dto-experiment';
import { getChroma } from './db/chroma.js';
import { embeddingFunction } from './db/embedding.js';
import { Experiment as ExperimentModel } from './db/models/experiment.js';
import { ExistError } from './errors.js';
import { Novel } from './novel.js';

// ===========================================================================
// 导入实验数据
// ===========================================================================

export interface ImportResult {
    experimentId: number;
    novelId: number;
    name: string;
    stats: {
        settingDocs: number;
        outlineDocs: number;
        chapterDocs: number;
        totalDocs: number;
    };
}

interface DocRecord {
    path: string;
    documentId: number;
    rootCategory: RootCategoryName;
    content: string;
}

export async function importExperiment(
    name: string,
    settings: ImportNode[],
    outlines: ImportNode[],
    chapters: ImportNode[],
): Promise<ImportExperimentResponse> {
    // 1. 创建小说（三根目录 + Chroma collection）
    const novel = await Novel.create(name);

    const docRecords: DocRecord[] = [];

    // 2. 导入三根目录数据
    const settingDocs = await importTree(novel, '/设定', '设定', settings, docRecords);
    const outlineDocs = await importTree(novel, '/大纲', '大纲', outlines, docRecords);
    const chapterDocs = await importTree(novel, '/正文', '正文', chapters, docRecords);

    const totalDocs = settingDocs + outlineDocs + chapterDocs;

    // 3. 创建实验记录（先创建以获取 experimentId）
    const mixedCollectionName = `experiment_mixed_placeholder`;
    const experiment = await ExperimentModel.create({
        novelId: novel.id,
        name,
        mixedCollectionName,
    });

    // 用正确的 collection name 更新
    const realCollectionName = `experiment_mixed_${experiment.id}`;
    experiment.mixedCollectionName = realCollectionName;
    await experiment.save();

    // 4. 构建混合 ChromaDB collection
    await buildMixedCollection(realCollectionName, docRecords);

    return {
        experimentId: experiment.id,
        novelId: novel.id,
        name,
        stats: {
            settingDocs,
            outlineDocs,
            chapterDocs,
            totalDocs,
        },
    };
}

// ===========================================================================
// 递归导入树
// ===========================================================================

async function importTree(
    novel: Novel,
    rootPath: string,
    rootCategory: RootCategoryName,
    nodes: ImportNode[],
    docRecords: DocRecord[],
): Promise<number> {
    let docCount = 0;
    for (const node of nodes) {
        const path = `${rootPath}/${node.name}`;
        if (node.name.endsWith('.md')) {
            if (node.content === undefined) {
                throw new Error(`文档节点 "${path}" 缺少 content`);
            }
            const { documentId } = await novel.write(path, node.content);
            docRecords.push({ path, documentId, rootCategory, content: node.content });
            docCount++;
        } else {
            // 目录节点：先确保目录存在
            try {
                await novel.createCategory(path);
            } catch (e) {
                if (!(e instanceof ExistError)) throw e;
                // 已存在则忽略
            }
            docCount += await importTree(novel, path, rootCategory, node.children ?? [], docRecords);
        }
    }
    return docCount;
}

// ===========================================================================
// 构建混合 collection
// ===========================================================================

async function buildMixedCollection(collectionName: string, docRecords: DocRecord[]): Promise<void> {
    if (docRecords.length === 0) return;

    const chroma = await getChroma();
    const collection = await chroma.createCollection({
        name: collectionName,
        embeddingFunction,
    });

    await collection.upsert({
        ids: docRecords.map((d) => d.documentId.toString()),
        documents: docRecords.map((d) => d.content),
        metadatas: docRecords.map((d) => ({ rootCategory: d.rootCategory, path: d.path })),
    });
}

// ===========================================================================
// 删除实验数据
// ===========================================================================

export async function deleteExperiment(experimentId: number): Promise<void> {
    const experiment = await ExperimentModel.findByPk(experimentId);
    if (!experiment) {
        throw new Error(`实验 id=${experimentId} 不存在`);
    }

    // 1. 删除混合 collection
    const chroma = await getChroma();
    try {
        await chroma.deleteCollection({ name: experiment.mixedCollectionName });
    } catch {
        // collection 可能已不存在，忽略
    }

    // 2. 删除小说（级联三根目录 + 各自的 Chroma collection）
    try {
        const novel = await Novel.byID(experiment.novelId);
        await novel.destroy();
    } catch {
        // 小说可能已删除，忽略
    }

    // 3. 删除实验记录
    await experiment.destroy();
}

// ===========================================================================
// 列出实验
// ===========================================================================

export async function listExperiments(): Promise<
    Array<{ id: number; name: string; novelId: number; createdAt: string }>
> {
    const experiments = await ExperimentModel.findAll({ order: [['createdAt', 'DESC']] });
    return experiments.map((e) => ({
        id: e.id,
        name: e.name,
        novelId: e.novelId,
        createdAt: (e.createdAt as Date).toISOString(),
    }));
}

// ===========================================================================
// 执行对比实验
// ===========================================================================

export async function runExperiment(
    experimentId: number,
    k: number,
    queries: TestQuery[],
): Promise<RunExperimentResponse> {
    const experiment = await ExperimentModel.findByPk(experimentId);
    if (!experiment) {
        throw new Error(`实验 id=${experimentId} 不存在`);
    }

    const novel = await Novel.byID(experiment.novelId);

    const chroma = await getChroma();
    const mixedCollection = await chroma.getCollection({
        name: experiment.mixedCollectionName,
        embeddingFunction,
    });

    const perQuery: PerQueryMetrics[] = [];

    let threeRootTotalLatency = 0;
    let threeRootTotalRecall = 0;
    let threeRootTotalMmr = 0;

    let mixedTotalLatency = 0;
    let mixedTotalRecall = 0;
    let mixedTotalMmr = 0;
    let mixedTotalContaminated = 0;
    let mixedTotalResults = 0;

    for (const tq of queries) {
        // ---- 组 A：三根目录检索 ----
        const start3 = performance.now();
        const resultsA = await novel.search(tq.rootCategory, [tq.query], k);
        const latencyA = performance.now() - start3;

        const pathsA = resultsA.map((r) => r.path);
        const recallA = computeRecall(pathsA, tq.relevantPaths);
        const rrA = computeReciprocalRank(pathsA, tq.relevantPaths);

        // ---- 组 B：混合存储检索 ----
        const startB = performance.now();
        const rawB = await mixedCollection.query({
            queryTexts: [tq.query],
            nResults: k,
        });
        const latencyB = performance.now() - startB;

        // 提取混合存储结果
        const pathsB: string[] = [];
        let contaminatedB = 0;
        const idsB = rawB.ids[0] ?? [];
        const metadatasB = rawB.metadatas[0] ?? [];

        for (let i = 0; i < idsB.length; i++) {
            const meta = metadatasB[i] as { rootCategory?: string; path?: string } | undefined;
            const resultPath = meta?.path ?? `(unknown #${idsB[i]})`;
            pathsB.push(resultPath);

            if (meta?.rootCategory && meta.rootCategory !== tq.rootCategory) {
                contaminatedB++;
            }
        }

        const recallB = computeRecall(pathsB, tq.relevantPaths);
        const rrB = computeReciprocalRank(pathsB, tq.relevantPaths);

        // 累加
        threeRootTotalLatency += latencyA;
        threeRootTotalRecall += recallA;
        threeRootTotalMmr += rrA;

        mixedTotalLatency += latencyB;
        mixedTotalRecall += recallB;
        mixedTotalMmr += rrB;
        mixedTotalContaminated += contaminatedB;
        mixedTotalResults += pathsB.length;

        perQuery.push({
            query: tq.query,
            targetRoot: tq.rootCategory,
            threeRoot: {
                latencyMs: Math.round(latencyA * 100) / 100,
                results: pathsA,
                recall: Math.round(recallA * 1000) / 1000,
                reciprocalRank: Math.round(rrA * 1000) / 1000,
            },
            mixed: {
                latencyMs: Math.round(latencyB * 100) / 100,
                results: pathsB,
                recall: Math.round(recallB * 1000) / 1000,
                reciprocalRank: Math.round(rrB * 1000) / 1000,
                contaminated: contaminatedB,
            },
        });
    }

    const n = queries.length;

    const threeRoot: AggregateMetrics = {
        avgLatencyMs: Math.round((threeRootTotalLatency / n) * 100) / 100,
        recallAtK: Math.round((threeRootTotalRecall / n) * 1000) / 1000,
        mrr: Math.round((threeRootTotalMmr / n) * 1000) / 1000,
    };

    const mixed: AggregateMetrics & { contaminationRate: number } = {
        avgLatencyMs: Math.round((mixedTotalLatency / n) * 100) / 100,
        recallAtK: Math.round((mixedTotalRecall / n) * 1000) / 1000,
        mrr: Math.round((mixedTotalMmr / n) * 1000) / 1000,
        contaminationRate:
            mixedTotalResults > 0 ? Math.round((mixedTotalContaminated / mixedTotalResults) * 1000) / 1000 : 0,
    };

    return {
        experimentId,
        k,
        queryCount: n,
        threeRoot,
        mixed,
        perQuery,
    };
}

// ===========================================================================
// 指标计算工具
// ===========================================================================

function computeRecall(retrievedPaths: string[], relevantPaths: string[]): number {
    if (relevantPaths.length === 0) return 1;
    const retrievedSet = new Set(retrievedPaths);
    const matched = relevantPaths.filter((p) => retrievedSet.has(p)).length;
    return matched / relevantPaths.length;
}

function computeReciprocalRank(retrievedPaths: string[], relevantPaths: string[]): number {
    const relevantSet = new Set(relevantPaths);
    for (let i = 0; i < retrievedPaths.length; i++) {
        const path = retrievedPaths[i];
        if (path !== undefined && relevantSet.has(path)) {
            return 1 / (i + 1);
        }
    }
    return 0;
}
