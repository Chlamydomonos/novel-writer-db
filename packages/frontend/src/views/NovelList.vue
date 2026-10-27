<script setup lang="ts">
// NovelList.vue — 小说列表页：列出/创建/删除小说、进入工作区、导入/导出归档
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import {
    ElButton,
    ElInput,
    ElTable,
    ElTableColumn,
    ElPopconfirm,
    ElMessage,
    ElMessageBox,
    ElEmpty,
    ElCard,
    ElTag,
    ElTooltip,
} from 'element-plus';
import { Plus, Edit, Delete, Setting, Download, Upload } from '@element-plus/icons-vue';
import { useNovelsStore } from '@/stores/novels';
import * as api from '@/api/novel';
import { ApiError } from '@/api/client';
import type { NovelSummary } from '@novel-writer/shared';

const router = useRouter();
const novelsStore = useNovelsStore();

// ===========================================================================
// 新建小说表单
// ===========================================================================
const newName = ref('');
const creating = ref(false);
const createError = ref('');

async function handleCreate() {
    const name = newName.value.trim();
    if (!name) return;
    createError.value = '';
    creating.value = true;
    try {
        await api.createNovel({ name });
        newName.value = '';
        await novelsStore.fetchNovels();
    } catch (e) {
        if (e instanceof ApiError && e.type === 'ExistError') {
            createError.value = '小说名已存在，请换一个名称。';
        } else {
            createError.value = '创建失败，请稍后重试。';
        }
    } finally {
        creating.value = false;
    }
}

// ===========================================================================
// 删除小说
// ===========================================================================
async function handleDelete(novel: NovelSummary) {
    try {
        await api.deleteNovel(novel.id);
        ElMessage.success(`已删除「${novel.name}」`);
        await novelsStore.fetchNovels();
    } catch {
        ElMessage.error('删除失败，请稍后重试。');
    }
}

// ===========================================================================
// 进入工作区
// ===========================================================================
function enterWorkspace(id: number) {
    novelsStore.currentId = id;
    router.push(`/novel/${id}`);
}

function enterSettings(id: number) {
    router.push(`/novel/${id}/settings`);
}

// ===========================================================================
// 导出 / 导入归档
// ===========================================================================
// 说明：
// - 导出为 gzip 压缩的 JSON（仅文本，不含向量），下载可能较慢故不设超时；
// - 导入由后端**后台执行**：接口校验归档后立即返回 202（连接随即结束，因此不会被 nginx
//   超时切断），随后重建内容并重算所有向量。进度通过轮询列表的 `importPhase` 字段感知。
const POLL_INTERVAL_MS = 2000;

const fileInput = ref<HTMLInputElement | null>(null);
/** 等待选择文件的导入目标（点击「导入」→ 确认 → 打开文件选择框）。 */
const pendingImport = ref<NovelSummary | null>(null);
const exportingId = ref<number | null>(null);
/** 正在上传归档的小说 ID（仅覆盖上传请求本身的短暂耗时）。 */
const uploadingId = ref<number | null>(null);

/** 需要跟踪导入结果的小说：id → 名称（用于完成/失败时提示）。 */
const trackedImports = new Map<number, string>();
/** 轮询定时器句柄；`null` 表示未在轮询。 */
let pollTimer: number | null = null;

function errorText(e: unknown, fallback: string) {
    if (e instanceof Error && e.message) {
        return `${fallback}：${e.message}`;
    }
    return `${fallback}，请稍后重试。`;
}

function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // 立即 revoke 会让部分浏览器下载中断，延后释放。
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 该行是否处于"导入中"（此时所有会读写该小说的操作都应禁用）。 */
function isImporting(novel: NovelSummary) {
    return novel.importPhase === 'importing';
}

async function handleExport(novel: NovelSummary) {
    exportingId.value = novel.id;
    try {
        const blob = await api.exportNovel(novel.id);
        downloadBlob(blob, `${novel.name.trim() || `novel-${novel.id}`}.nwd.gz`);
        ElMessage.success(`已导出「${novel.name}」`);
    } catch (e) {
        ElMessage.error(errorText(e, '导出失败'));
    } finally {
        exportingId.value = null;
    }
}

async function handleImportClick(novel: NovelSummary) {
    if (isImporting(novel)) return;
    try {
        await ElMessageBox.confirm(
            `导入会用归档内容覆盖「${novel.name}」现有的全部目录与文档，并重新计算所有向量。此操作不可撤销，建议先导出备份。`,
            '确认导入',
            { type: 'warning', confirmButtonText: '继续导入', cancelButtonText: '取消' },
        );
    } catch {
        return; // 用户取消
    }
    pendingImport.value = novel;
    fileInput.value?.click();
}

async function handleFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    const novel = pendingImport.value;
    input.value = ''; // 清空以便再次选择同一文件
    pendingImport.value = null;
    if (!file || !novel) {
        return;
    }

    uploadingId.value = novel.id;
    try {
        await api.importNovel(novel.id, file);
        ElMessage.info(`「${novel.name}」已开始导入，可继续使用其他页面，完成后会自动提示`);
        // 记录跟踪目标并立即刷新列表（此时后端已标记为 importing）。
        trackedImports.set(novel.id, novel.name);
        startPolling();
    } catch (e) {
        ElMessage.error(errorText(e, '导入失败'));
    } finally {
        uploadingId.value = null;
    }
}

/** 开始轮询列表以感知导入进度（幂等）。 */
function startPolling() {
    if (pollTimer !== null) {
        // 已在轮询：立即补一次，避免新加入的目标要等到下个周期。
        void pollImportProgress();
        return;
    }
    pollTimer = window.setInterval(() => void pollImportProgress(), POLL_INTERVAL_MS);
    void pollImportProgress();
}

function stopPolling() {
    if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
    }
}

/**
 * 拉取一次列表并结算跟踪中的导入任务：
 * - 状态消失 → 导入成功（后端在完成时清除内存记录）；
 * - `failed` → 提示错误详情；
 * - 小说已不存在 → 静默结束跟踪。
 */
async function pollImportProgress() {
    try {
        await novelsStore.fetchNovels();
    } catch {
        return; // 单次网络抖动忽略，下个周期继续
    }

    const byId = new Map(novelsStore.novels.map((n) => [n.id, n]));
    for (const [id, name] of [...trackedImports]) {
        const item = byId.get(id);
        if (!item) {
            trackedImports.delete(id);
            continue;
        }
        if (item.importPhase === 'failed') {
            trackedImports.delete(id);
            ElMessage.error(`「${name}」导入失败：${item.importError ?? '未知错误'}`);
        } else if (item.importPhase === undefined) {
            trackedImports.delete(id);
            ElMessage.success(`「${name}」导入完成，向量已重算`);
        }
    }

    if (trackedImports.size === 0) {
        stopPolling();
    }
}

// ===========================================================================
// 初始化
// ===========================================================================
onMounted(() => {
    void (async () => {
        await novelsStore.fetchNovels();
        // 页面刷新后仍可能有导入任务在跑：恢复跟踪。
        for (const novel of novelsStore.novels) {
            if (novel.importPhase === 'importing') {
                trackedImports.set(novel.id, novel.name);
            }
        }
        if (trackedImports.size > 0) {
            startPolling();
        }
    })();
});

onUnmounted(stopPolling);
</script>

<template>
    <div class="novel-list-page">
        <header class="page-header">
            <h1 class="page-title">小说写作助手</h1>
            <p class="page-subtitle">管理你的小说项目，编辑文档，智能检索</p>
        </header>

        <!-- 新建小说 -->
        <ElCard class="create-card" shadow="hover">
            <div class="create-form">
                <ElInput
                    v-model="newName"
                    placeholder="输入小说名称，如「三体」"
                    size="large"
                    clearable
                    :disabled="creating"
                    :class="{ 'is-error': createError }"
                    @keyup.enter="handleCreate"
                >
                    <template #append>
                        <ElButton :icon="Plus" :loading="creating" :disabled="!newName.trim()" @click="handleCreate">
                            创建
                        </ElButton>
                    </template>
                </ElInput>
                <p v-if="createError" class="create-error">{{ createError }}</p>
            </div>
        </ElCard>

        <!-- 小说列表 -->
        <ElCard v-if="novelsStore.novels.length > 0" class="list-card" shadow="hover">
            <ElTable :data="novelsStore.novels" stripe style="width: 100%" row-key="id">
                <ElTableColumn prop="id" label="#" width="60" />
                <ElTableColumn label="小说名称" min-width="200">
                    <template #default="{ row }">
                        <div class="name-cell">
                            <span>{{ (row as NovelSummary).name }}</span>
                            <ElTag
                                v-if="row.importPhase === 'importing'"
                                type="warning"
                                size="small"
                                effect="light"
                                class="status-tag"
                            >
                                导入中…
                            </ElTag>
                            <ElTooltip
                                v-else-if="row.importPhase === 'failed'"
                                :content="row.importError ?? '导入失败'"
                                placement="top"
                            >
                                <ElTag type="danger" size="small" effect="light" class="status-tag">导入失败</ElTag>
                            </ElTooltip>
                        </div>
                    </template>
                </ElTableColumn>
                <ElTableColumn label="操作" width="360" align="center">
                    <template #default="{ row }">
                        <div class="row-actions">
                            <ElButton
                                link
                                type="primary"
                                :icon="Edit"
                                :disabled="isImporting(row as NovelSummary)"
                                @click="enterWorkspace(row.id)"
                            >
                                打开
                            </ElButton>
                            <ElButton
                                link
                                type="info"
                                :icon="Setting"
                                :disabled="isImporting(row as NovelSummary)"
                                @click="enterSettings(row.id)"
                            >
                                设置
                            </ElButton>
                            <ElButton
                                link
                                type="success"
                                :icon="Download"
                                :loading="exportingId === row.id"
                                :disabled="isImporting(row as NovelSummary)"
                                @click="handleExport(row as NovelSummary)"
                            >
                                导出
                            </ElButton>
                            <ElButton
                                link
                                type="warning"
                                :icon="Upload"
                                :loading="uploadingId === row.id || row.importPhase === 'importing'"
                                :disabled="isImporting(row as NovelSummary)"
                                @click="handleImportClick(row as NovelSummary)"
                            >
                                导入
                            </ElButton>
                            <ElPopconfirm
                                :title="`确定要删除「${(row as NovelSummary).name}」吗？此操作不可撤销。`"
                                confirm-button-text="删除"
                                cancel-button-text="取消"
                                @confirm="handleDelete(row as NovelSummary)"
                            >
                                <template #reference>
                                    <ElButton
                                        link
                                        type="danger"
                                        :icon="Delete"
                                        :disabled="isImporting(row as NovelSummary)"
                                    >
                                        删除
                                    </ElButton>
                                </template>
                            </ElPopconfirm>
                        </div>
                    </template>
                </ElTableColumn>
            </ElTable>
        </ElCard>

        <!-- 空状态 -->
        <ElEmpty v-else-if="!novelsStore.loading" description="还没有小说，上方输入名称创建第一本吧" />

        <!-- 导入归档：隐藏的文件选择框（点击「导入」确认后触发） -->
        <input
            ref="fileInput"
            class="file-input"
            type="file"
            accept=".gz,application/gzip,application/x-gzip"
            @change="handleFileChange"
        />
    </div>
</template>

<style scoped lang="scss">
.novel-list-page {
    max-width: 780px;
    margin: 0 auto;
    padding: 40px var(--app-padding);
    display: flex;
    flex-direction: column;
    gap: 24px;
}

.page-header {
    text-align: center;

    .page-title {
        margin: 0;
        font-size: 28px;
        font-weight: 700;
        color: var(--app-fg);
    }

    .page-subtitle {
        margin: 8px 0 0;
        color: var(--app-muted);
        font-size: var(--app-font-base);
    }
}

.create-card {
    :deep(.el-card__body) {
        padding: 20px 24px;
    }
}

.create-form {
    .is-error :deep(.el-input__wrapper) {
        box-shadow: 0 0 0 1px var(--el-color-danger) inset;
    }
}

.create-error {
    margin: 6px 0 0;
    font-size: var(--app-font-sm);
    color: var(--el-color-danger);
}

.list-card {
    :deep(.el-card__body) {
        padding: 0;
    }
}

.row-actions {
    display: flex;
    justify-content: center;
    gap: 4px;
}

.name-cell {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}

.status-tag {
    flex: none;
}

.file-input {
    display: none;
}
</style>
