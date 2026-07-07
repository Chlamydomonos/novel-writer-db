<script setup lang="ts">
// NovelWorkspace.vue — 主工作区：三栏布局（左树 + 中编辑 + 右检索）
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElButton, ElTooltip } from 'element-plus';
import { ArrowLeft, Setting, Search as SearchIcon } from '@element-plus/icons-vue';
import { useNovelsStore } from '@/stores/novels';
import { getNovel } from '@/api/novel';
import CategoryTree from '@/components/CategoryTree.vue';
import DocumentEditor from '@/components/DocumentEditor.vue';
import SearchPanel from '@/components/SearchPanel.vue';
import type { NovelDetail } from '@novel-writer/shared';

const router = useRouter();
const route = useRoute();
const novelsStore = useNovelsStore();

// ===========================================================================
// 小说 ID
// ===========================================================================
const novelId = computed(() => {
    const id = Number(route.params.id);
    return Number.isNaN(id) ? null : id;
});

// 同步到 store
watch(
    novelId,
    (id) => {
        novelsStore.currentId = id;
    },
    { immediate: true },
);

// ===========================================================================
// 小说详情
// ===========================================================================
const novel = ref<NovelDetail | null>(null);
const loadError = ref('');

async function fetchNovel() {
    if (novelId.value === null) return;
    loadError.value = '';
    try {
        novel.value = await getNovel(novelId.value);
    } catch {
        loadError.value = '无法加载小说信息。';
    }
}

onMounted(fetchNovel);
watch(novelId, () => {
    if (novelId.value !== null) fetchNovel();
});

// ===========================================================================
// 右侧检索面板开关
// ===========================================================================
const searchVisible = ref(false);

function toggleSearch() {
    searchVisible.value = !searchVisible.value;
}

// ===========================================================================
// 导航
// ===========================================================================
function goToList() {
    novelsStore.currentId = null;
    router.push('/');
}

function goToSettings() {
    if (novelId.value !== null) {
        router.push(`/novel/${novelId.value}/settings`);
    }
}
</script>

<template>
    <div class="workspace-page">
        <!-- 顶部导航 -->
        <header class="workspace-header">
            <div class="header-left">
                <ElButton :icon="ArrowLeft" link @click="goToList">小说列表</ElButton>
                <span class="header-divider">/</span>
                <span v-if="novel" class="header-novel-name">{{ novel.name }}</span>
                <span v-else-if="loadError" class="header-error">{{ loadError }}</span>
                <span v-else class="header-loading">加载中...</span>
            </div>
            <div class="header-right">
                <ElTooltip content="语义检索" placement="bottom">
                    <ElButton
                        :icon="SearchIcon"
                        link
                        :type="searchVisible ? 'primary' : 'default'"
                        @click="toggleSearch"
                    />
                </ElTooltip>
                <ElTooltip content="小说设置" placement="bottom">
                    <ElButton :icon="Setting" link @click="goToSettings" />
                </ElTooltip>
            </div>
        </header>

        <!-- 三栏主体 -->
        <div class="workspace-body">
            <!-- 左：目录树 -->
            <aside class="workspace-left">
                <CategoryTree />
            </aside>

            <!-- 中：文档编辑 -->
            <main class="workspace-center">
                <DocumentEditor />
            </main>

            <!-- 右：检索面板（可折叠） -->
            <aside v-if="searchVisible" class="workspace-right">
                <SearchPanel />
            </aside>
        </div>
    </div>
</template>

<style scoped lang="scss">
.workspace-page {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
}

// ---- 顶部导航 ----
.workspace-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 44px;
    padding: 0 12px;
    border-bottom: 1px solid var(--app-border);
    background: #fff;
    flex-shrink: 0;
}

.header-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}

.header-divider {
    color: var(--app-muted);
    font-size: var(--app-font-sm);
}

.header-novel-name {
    font-weight: 600;
    font-size: var(--app-font-base);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.header-error {
    color: var(--el-color-danger);
    font-size: var(--app-font-sm);
}

.header-loading {
    color: var(--app-muted);
    font-size: var(--app-font-sm);
}

.header-right {
    display: flex;
    align-items: center;
    gap: 4px;
}

// ---- 三栏主体 ----
.workspace-body {
    flex: 1;
    display: flex;
    overflow: hidden;
}

.workspace-left {
    width: 260px;
    flex-shrink: 0;
    border-right: 1px solid var(--app-border);
    background: #fff;
    overflow: hidden;
}

.workspace-center {
    flex: 1;
    min-width: 0;
    background: #fff;
    overflow: hidden;
}

.workspace-right {
    width: 300px;
    flex-shrink: 0;
    border-left: 1px solid var(--app-border);
    background: #fff;
    overflow: hidden;
}
</style>
