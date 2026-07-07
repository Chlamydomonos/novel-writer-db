<script setup lang="ts">
// NovelList.vue — 小说列表页：列出/创建/删除小说、进入工作区
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElButton, ElInput, ElTable, ElTableColumn, ElPopconfirm, ElMessage, ElEmpty, ElCard } from 'element-plus';
import { Plus, Edit, Delete, Setting } from '@element-plus/icons-vue';
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
// 初始化
// ===========================================================================
onMounted(() => {
    novelsStore.fetchNovels();
});
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
                <ElTableColumn prop="name" label="小说名称" min-width="200" />
                <ElTableColumn label="操作" width="200" align="center">
                    <template #default="{ row }">
                        <div class="row-actions">
                            <ElButton link type="primary" :icon="Edit" @click="enterWorkspace(row.id)"> 打开 </ElButton>
                            <ElButton link type="info" :icon="Setting" @click="enterSettings(row.id)"> 设置 </ElButton>
                            <ElPopconfirm
                                :title="`确定要删除「${(row as NovelSummary).name}」吗？此操作不可撤销。`"
                                confirm-button-text="删除"
                                cancel-button-text="取消"
                                @confirm="handleDelete(row as NovelSummary)"
                            >
                                <template #reference>
                                    <ElButton link type="danger" :icon="Delete">删除</ElButton>
                                </template>
                            </ElPopconfirm>
                        </div>
                    </template>
                </ElTableColumn>
            </ElTable>
        </ElCard>

        <!-- 空状态 -->
        <ElEmpty v-else-if="!novelsStore.loading" description="还没有小说，上方输入名称创建第一本吧" />
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
</style>
