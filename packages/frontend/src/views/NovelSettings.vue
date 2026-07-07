<script setup lang="ts">
// NovelSettings.vue — 小说设置页：修改 info、重命名、删除小说
import { ref, onMounted, computed, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElButton, ElInput, ElCard, ElMessage, ElMessageBox, ElPopconfirm, ElPageHeader } from 'element-plus';
import { Edit, Delete } from '@element-plus/icons-vue';
import { useNovelsStore } from '@/stores/novels';
import { patchNovel, deleteNovel, getNovel } from '@/api/novel';
import { ApiError } from '@/api/client';
import type { NovelDetail } from '@novel-writer/shared';

const router = useRouter();
const route = useRoute();
const novelsStore = useNovelsStore();

// ===========================================================================
// 小说数据
// ===========================================================================
const novel = ref<NovelDetail | null>(null);
const loading = ref(true);
const loadError = ref('');

const novelId = computed(() => {
    const id = Number(route.params.id);
    return Number.isNaN(id) ? null : id;
});

async function fetchNovel() {
    if (novelId.value === null) return;
    loading.value = true;
    loadError.value = '';
    try {
        novel.value = await getNovel(novelId.value);
    } catch {
        loadError.value = '无法加载小说信息。';
    } finally {
        loading.value = false;
    }
}

onMounted(fetchNovel);

// ===========================================================================
// 重命名
// ===========================================================================
const renameVisible = ref(false);
const renameName = ref('');
const renameSaving = ref(false);
const renameError = ref('');

function openRename() {
    renameName.value = novel.value?.name ?? '';
    renameError.value = '';
    renameVisible.value = true;
}

async function handleRename() {
    const trimmed = renameName.value.trim();
    if (!trimmed || trimmed === novel.value?.name) {
        renameVisible.value = false;
        return;
    }
    if (novelId.value === null) return;

    renameError.value = '';
    renameSaving.value = true;
    try {
        const updated = await patchNovel(novelId.value, { name: trimmed });
        novel.value = updated;
        novelsStore.fetchNovels(); // 刷新列表
        renameVisible.value = false;
        ElMessage.success('已重命名');
    } catch (e) {
        if (e instanceof ApiError && e.type === 'ExistError') {
            renameError.value = '该名称已被其它小说使用。';
        } else {
            renameError.value = '重命名失败，请稍后重试。';
        }
    } finally {
        renameSaving.value = false;
    }
}

// ===========================================================================
// 修改 info
// ===========================================================================
const infoText = ref('');
const infoSaving = ref(false);

watch(
    () => novel.value?.info,
    (val) => {
        infoText.value = val ?? '';
    },
);

async function handleSaveInfo() {
    if (novelId.value === null) return;
    infoSaving.value = true;
    try {
        const updated = await patchNovel(novelId.value, { info: infoText.value });
        novel.value = updated;
        ElMessage.success('已保存小说信息');
    } catch {
        ElMessage.error('保存失败，请稍后重试。');
    } finally {
        infoSaving.value = false;
    }
}

// ===========================================================================
// 删除小说
// ===========================================================================
const deleting = ref(false);

async function handleDelete() {
    if (novelId.value === null) return;

    try {
        await ElMessageBox.confirm(
            `确定要删除小说「${novel.value?.name}」吗？所有目录、文档及检索索引将一并删除，此操作不可撤销。`,
            '确认删除小说',
            { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
        );
    } catch {
        return;
    }

    deleting.value = true;
    try {
        await deleteNovel(novelId.value);
        ElMessage.success('已删除小说');
        router.replace('/');
    } catch {
        ElMessage.error('删除失败，请稍后重试。');
    } finally {
        deleting.value = false;
    }
}

// ===========================================================================
// 返回
// ===========================================================================
function goBack() {
    if (novelId.value !== null) {
        router.push(`/novel/${novelId.value}`);
    } else {
        router.push('/');
    }
}
</script>

<template>
    <div class="settings-page">
        <ElPageHeader @back="goBack">
            <template #title>
                <span v-if="novel">「{{ novel.name }}」设置</span>
                <span v-else>小说设置</span>
            </template>
        </ElPageHeader>

        <div v-if="loading" class="settings-loading">
            <p>加载中...</p>
        </div>

        <div v-else-if="loadError" class="settings-error">
            <p>{{ loadError }}</p>
            <ElButton @click="fetchNovel">重试</ElButton>
        </div>

        <template v-else-if="novel">
            <!-- 基本信息 -->
            <ElCard class="settings-card" shadow="hover">
                <template #header>
                    <div class="card-header">
                        <span>基本信息</span>
                    </div>
                </template>
                <div class="info-row">
                    <span class="info-label">小说名称</span>
                    <span class="info-value">{{ novel.name }}</span>
                    <ElButton link type="primary" :icon="Edit" size="small" @click="openRename">重命名</ElButton>
                </div>
                <div class="info-row">
                    <span class="info-label">ID</span>
                    <span class="info-value">{{ novel.id }}</span>
                </div>
            </ElCard>

            <!-- 小说信息（info） -->
            <ElCard class="settings-card" shadow="hover">
                <template #header>
                    <div class="card-header">
                        <span>小说简介 / 备注</span>
                        <ElButton type="primary" size="small" :loading="infoSaving" @click="handleSaveInfo">
                            保存
                        </ElButton>
                    </div>
                </template>
                <ElInput
                    v-model="infoText"
                    type="textarea"
                    :rows="8"
                    placeholder="在此输入小说简介、世界观设定摘要、写作备注等…"
                />
            </ElCard>

            <!-- 危险区域 -->
            <ElCard class="settings-card settings-danger" shadow="hover">
                <template #header>
                    <div class="card-header">
                        <span class="danger-title">危险操作</span>
                    </div>
                </template>
                <p class="danger-desc">删除小说将同时删除所有目录、文档及检索索引，此操作不可撤销。</p>
                <ElPopconfirm
                    title="此操作不可撤销，确定继续？"
                    confirm-button-text="确认删除"
                    cancel-button-text="取消"
                    @confirm="handleDelete"
                >
                    <template #reference>
                        <ElButton type="danger" :icon="Delete" :loading="deleting"> 删除小说 </ElButton>
                    </template>
                </ElPopconfirm>
            </ElCard>

            <!-- 重命名对话框 -->
            <ElDialog v-model="renameVisible" title="重命名小说" width="400px" :close-on-click-modal="false">
                <ElInput
                    v-model="renameName"
                    placeholder="输入新名称"
                    :disabled="renameSaving"
                    :class="{ 'is-error': renameError }"
                    @keyup.enter="handleRename"
                />
                <p v-if="renameError" class="rename-error">{{ renameError }}</p>
                <template #footer>
                    <ElButton :disabled="renameSaving" @click="renameVisible = false">取消</ElButton>
                    <ElButton
                        type="primary"
                        :loading="renameSaving"
                        :disabled="!renameName.trim()"
                        @click="handleRename"
                    >
                        确定
                    </ElButton>
                </template>
            </ElDialog>
        </template>
    </div>
</template>

<style scoped lang="scss">
.settings-page {
    max-width: 680px;
    margin: 0 auto;
    padding: 20px var(--app-padding);
    display: flex;
    flex-direction: column;
    gap: 20px;
}

.settings-loading,
.settings-error {
    text-align: center;
    padding: 40px 0;
    color: var(--app-muted);
}

.settings-card {
    :deep(.el-card__header) {
        padding: 12px 20px;
    }
    :deep(.el-card__body) {
        padding: 16px 20px;
    }
}

.card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-weight: 600;
}

.info-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 0;

    & + & {
        border-top: 1px solid var(--app-border);
        margin-top: 6px;
        padding-top: 12px;
    }
}

.info-label {
    width: 80px;
    flex-shrink: 0;
    color: var(--app-muted);
    font-size: var(--app-font-sm);
}

.info-value {
    flex: 1;
    font-weight: 500;
}

.settings-danger {
    border-color: var(--el-color-danger-light-5);
}

.danger-title {
    color: var(--el-color-danger);
}

.danger-desc {
    margin: 0 0 12px;
    color: var(--app-muted);
    font-size: var(--app-font-sm);
}

.rename-error {
    margin: 6px 0 0;
    font-size: var(--app-font-sm);
    color: var(--el-color-danger);
}

.is-error :deep(.el-input__wrapper) {
    box-shadow: 0 0 0 1px var(--el-color-danger) inset;
}
</style>
