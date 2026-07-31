/**
 * 实验相关共享 DTO 类型。
 */

import type { RootCategoryName } from './dto.js';

// ===========================================================================
// 导入相关
// ===========================================================================

/** 导入 JSON 中的树节点（递归）。 */
export interface ImportNode {
    name: string;
    content?: string | undefined;
    children?: ImportNode[] | undefined;
}

/** POST /api/experiments/import 请求体。 */
export interface ImportExperimentRequest {
    settings?: ImportNode[];
    outlines?: ImportNode[];
    chapters?: ImportNode[];
}

/** POST /api/experiments/import 响应体。 */
export interface ImportExperimentResponse {
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

// ===========================================================================
// 实验列表
// ===========================================================================

/** GET /api/experiments 响应项。 */
export interface ExperimentSummary {
    id: number;
    name: string;
    novelId: number;
    createdAt: string;
}

// ===========================================================================
// 执行对比实验
// ===========================================================================

/** 单条测试查询。 */
export interface TestQuery {
    query: string;
    rootCategory: RootCategoryName;
    relevantPaths: string[];
}

/** POST /api/experiments/:experimentId/run 请求体。 */
export interface RunExperimentRequest {
    k?: number;
    queries: TestQuery[];
}

/** 单条检索结果指标。 */
export interface PerQueryMetrics {
    query: string;
    targetRoot: string;
    threeRoot: {
        latencyMs: number;
        results: string[];
        recall: number;
        reciprocalRank: number;
    };
    mixed: {
        latencyMs: number;
        results: string[];
        recall: number;
        reciprocalRank: number;
        contaminated: number;
    };
}

/** 聚合指标。 */
export interface AggregateMetrics {
    avgLatencyMs: number;
    recallAtK: number;
    mrr: number;
}

/** POST /api/experiments/:experimentId/run 响应体。 */
export interface RunExperimentResponse {
    experimentId: number;
    k: number;
    queryCount: number;
    threeRoot: AggregateMetrics;
    mixed: AggregateMetrics & { contaminationRate: number };
    perQuery: PerQueryMetrics[];
}
