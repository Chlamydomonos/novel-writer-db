<script setup lang="ts">
// SearchPanel.vue — 语义检索面板：表单、结果列表、点击结果打开文档
import { ref } from 'vue';
import { ElButton, ElInput, ElSelect, ElOption, ElInputNumber, ElScrollbar, ElMessage, ElEmpty } from 'element-plus';
import { Search } from '@element-plus/icons-vue';
import { useNovelsStore } from '@/stores/novels';
import { useEditorStore } from '@/stores/editor';
import { searchDocuments, readDocuments } from '@/api/novel';
import { ApiError } from '@/api/client';
import type { RootCategoryName, SearchResultItem } from '@novel-writer/shared';
import { ROOT_CATEGORY_NAMES } from '@novel-writer/shared';

const novelsStore = useNovelsStore();
const editorStore = useEditorStore();

// ===========================================================================
// 检索表单
// ===========================================================================
const rootCategory = ref<RootCategoryName>('设定');
const searchText = ref('');
const limit = ref(10);

// ===========================================================================
// 检索状态
// ===========================================================================
const searching = ref(false);
const results = ref<SearchResultItem[]>([]);
const hasSearched = ref(false);
const searchError = ref('');

// ===========================================================================
// 提交检索
// ===========================================================================
async function handleSearch() {
    const novelId = novelsStore.currentId;
    if (novelId === null) return;

    const texts = searchText.value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);

    if (texts.length === 0) {
        searchError.value = '请输入至少一个检索关键词。';
        return;
    }

    searchError.value = '';
    searching.value = true;
    try {
        results.value = await searchDocuments(novelId, {
            rootCategory: rootCategory.value,
            texts,
            limit: limit.value,
        });
        hasSearched.value = true;
    } catch (e) {
        if (e instanceof ApiError && e.type === 'OutOfBoundsError') {
            searchError.value = '检索数量超出范围（1–20）。';
        } else {
            searchError.value = '检索失败，请稍后重试。';
        }
    } finally {
        searching.value = false;
    }
}

// ===========================================================================
// 点击结果 → 打开文档
// ===========================================================================
async function openResult(item: SearchResultItem) {
    const novelId = novelsStore.currentId;
    if (novelId === null) return;

    try {
        const docs = await readDocuments(novelId, [item.path]);
        const doc = docs[0];
        if (doc) {
            editorStore.openDocument(doc);
        }
    } catch {
        ElMessage.error('无法打开该文档。');
    }
}

// ===========================================================================
// 文本预览截断
// ===========================================================================
function getPreview(text: string, maxLen = 120): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + '…';
}
</script>

<template>
    <div class="search-panel">
        <div class="search-header">
            <span class="search-title">语义检索</span>
        </div>

        <!-- 检索表单 -->
        <div class="search-form">
            <div class="form-row">
                <label class="form-label">根目录</label>
                <ElSelect v-model="rootCategory" size="small" style="width: 100%">
                    <ElOption v-for="r in ROOT_CATEGORY_NAMES" :key="r" :label="r" :value="r" />
                </ElSelect>
            </div>

            <div class="form-row">
                <label class="form-label">检索关键词（每行一个）</label>
                <ElInput
                    v-model="searchText"
                    type="textarea"
                    :rows="3"
                    size="small"
                    placeholder="输入检索关键词&#10;每行一个…"
                />
            </div>

            <div class="form-row">
                <label class="form-label">返回数量</label>
                <ElInputNumber v-model="limit" :min="1" :max="20" size="small" style="width: 100%" />
            </div>

            <p v-if="searchError" class="search-error">{{ searchError }}</p>

            <ElButton
                :icon="Search"
                type="primary"
                size="small"
                :loading="searching"
                style="width: 100%"
                @click="handleSearch"
            >
                检索
            </ElButton>
        </div>

        <!-- 检索结果 -->
        <ElScrollbar class="search-results">
            <div v-if="searching" class="result-status">
                <p>正在检索...</p>
            </div>

            <div v-else-if="hasSearched && results.length === 0" class="result-status">
                <ElEmpty description="无匹配结果" :image-size="60" />
            </div>

            <div v-else-if="results.length > 0" class="result-list">
                <div v-for="(item, idx) in results" :key="idx" class="result-item" @click="openResult(item)">
                    <div class="result-path">{{ item.path }}</div>
                    <div class="result-preview" v-html="getPreview(item.text)" />
                </div>
            </div>

            <div v-else class="result-status">
                <p class="result-hint">输入关键词后点击检索</p>
            </div>
        </ElScrollbar>
    </div>
</template>

<style scoped lang="scss">
.search-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
}

.search-header {
    padding: 10px 12px 8px;
    border-bottom: 1px solid var(--app-border);
    flex-shrink: 0;

    .search-title {
        font-weight: 600;
        font-size: var(--app-font-base);
    }
}

.search-form {
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--app-border);
}

.form-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.form-label {
    font-size: var(--app-font-sm);
    color: var(--app-muted);
}

.search-error {
    margin: 0;
    font-size: var(--app-font-sm);
    color: var(--el-color-danger);
}

.search-results {
    flex: 1;
    overflow: hidden;
}

.result-status {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 120px;
    color: var(--app-muted);
    font-size: var(--app-font-sm);
}

.result-hint {
    color: var(--app-muted);
}

.result-list {
    padding: 4px 0;
}

.result-item {
    padding: 10px 12px;
    cursor: pointer;
    border-bottom: 1px solid var(--app-border);
    transition: background 0.15s;

    &:hover {
        background: var(--el-color-primary-light-9);
    }
}

.result-path {
    font-size: var(--app-font-sm);
    font-weight: 600;
    color: var(--el-color-primary);
    margin-bottom: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.result-preview {
    font-size: var(--app-font-sm);
    color: var(--app-muted);
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;

    :deep(mark) {
        background: #fff3cd;
        color: inherit;
        padding: 0 2px;
        border-radius: 2px;
    }
}
</style>
