/**
 * 归档导入的**内存**状态表（不落库、不修改数据库结构）。
 *
 * 设计背景：一本小说重新嵌入全部文档可能耗时数分钟，若在单个 HTTP 请求内同步完成，
 * 会被反向代理（nginx `proxy_read_timeout`）切断。因此导入改为后台任务：
 * `POST /api/novels/:id/import` 校验归档后立即返回 `202`，
 * 导入进度由 `GET /api/novels` 上附加的 `importPhase` 字段暴露，前端轮询感知。
 *
 * 状态语义：
 * - `importing`：后台任务进行中（该小说的其它 API 请求会被拒绝为 409）；
 * - `failed`：上一次导入失败，保留错误信息直到下次导入或进程重启；
 * - 无记录：正常。导入成功后记录立即删除。
 *
 * 局限：仅存在于进程内存，进程重启后丢失（导入任务也随之丢失）。
 */

import type { NovelImportPhase } from '@novel-writer/shared';

export interface ImportState {
    phase: NovelImportPhase;
    /** 开始时间（epoch ms）。 */
    startedAt: number;
    /** 失败原因，仅 `phase === 'failed'` 时存在。 */
    error?: string;
}

const states = new Map<number, ImportState>();

/**
 * 尝试占据某本小说的导入槽位。
 *
 * @returns `true` 表示已开始（调用方负责后续 `completeImport` / `failImport`）；
 *          `false` 表示该小说已在导入中。
 */
export function beginImport(novelId: number): boolean {
    const current = states.get(novelId);
    if (current?.phase === 'importing') {
        return false;
    }
    states.set(novelId, { phase: 'importing', startedAt: Date.now() });
    return true;
}

/** 是否正有导入任务在跑（`failed` 不算，允许重试及其它操作）。 */
export function isImporting(novelId: number): boolean {
    return states.get(novelId)?.phase === 'importing';
}

/** 读取状态快照（供 `GET /api/novels` 附加字段）。 */
export function getImportState(novelId: number): ImportState | undefined {
    return states.get(novelId);
}

/** 导入成功：清除记录，小说回到正常状态。 */
export function completeImport(novelId: number): void {
    states.delete(novelId);
}

/** 导入失败：保留 `failed` 状态与原因，供前端提示（下次 `beginImport` 会覆盖）。 */
export function failImport(novelId: number, error: string): void {
    states.set(novelId, { phase: 'failed', startedAt: states.get(novelId)?.startedAt ?? Date.now(), error });
}

/** 清除记录（小说被删除时调用，避免内存残留）。 */
export function clearImportState(novelId: number): void {
    states.delete(novelId);
}
