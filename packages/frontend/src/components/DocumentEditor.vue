<script setup lang="ts">
// DocumentEditor.vue — 纯文本编辑区：el-input textarea、保存/另存为/删除、dirty 状态
import { ref, watch, computed } from 'vue';
import { ElButton, ElIcon, ElInput, ElMessage, ElMessageBox, ElDialog, ElTooltip } from 'element-plus';
import { DocumentAdd, Delete, Download } from '@element-plus/icons-vue';
import { useNovelsStore } from '@/stores/novels';
import { useEditorStore } from '@/stores/editor';
import { writeDocument, deleteDocument as apiDeleteDocument } from '@/api/novel';
import { ApiError } from '@/api/client';

const novelsStore = useNovelsStore();
const editorStore = useEditorStore();

// ===========================================================================
// 本地编辑缓存
// ===========================================================================
const localText = ref('');

// 当 store 打开新文档时同步到本地文本
watch(
    () => editorStore.currentPath,
    () => {
        localText.value = editorStore.currentText;
    },
);

// 标记 dirty
watch(localText, (val) => {
    if (val !== editorStore.currentText) {
        editorStore.markDirty();
    }
});

// ===========================================================================
// 文档名（用于显示）
// ===========================================================================
const docName = computed(() => {
    const p = editorStore.currentPath;
    if (!p) return '';
    return p.split('/').pop() ?? '';
});

const docFolder = computed(() => {
    const p = editorStore.currentPath;
    if (!p) return '';
    const parts = p.split('/');
    parts.pop();
    return parts.join('/') || '/';
});

// ===========================================================================
// 保存
// ===========================================================================
const saving = ref(false);

async function handleSave() {
    const novelId = novelsStore.currentId;
    const path = editorStore.currentPath;
    if (novelId === null || !path) return;

    saving.value = true;
    try {
        await writeDocument(novelId, { path, text: localText.value });
        editorStore.currentText = localText.value;
        editorStore.isDirty = false;
        ElMessage.success('已保存');
    } catch (e) {
        if (e instanceof ApiError && e.type === 'InvalidPathError') {
            ElMessage.error('路径无效，无法保存。');
        } else {
            ElMessage.error('保存失败，请稍后重试。');
        }
    } finally {
        saving.value = false;
    }
}

// ===========================================================================
// 另存为
// ===========================================================================
const saveAsVisible = ref(false);
const saveAsName = ref('');
const saveAsSaving = ref(false);
const saveAsError = ref('');

function openSaveAs() {
    saveAsName.value = docName.value;
    saveAsError.value = '';
    saveAsVisible.value = true;
}

async function handleSaveAs() {
    const novelId = novelsStore.currentId;
    if (novelId === null) return;

    const trimmed = saveAsName.value.trim();
    if (!trimmed) return;

    const newName = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
    const newPath = `${docFolder.value}/${newName}`;

    saveAsError.value = '';
    saveAsSaving.value = true;
    try {
        await writeDocument(novelId, { path: newPath, text: localText.value });
        saveAsVisible.value = false;
        ElMessage.success(`已另存为 ${newName}`);
    } catch (e) {
        if (e instanceof ApiError) {
            if (e.type === 'ExistError') {
                saveAsError.value = '该路径已存在，请更换名称。';
            } else if (e.type === 'InvalidPathError') {
                saveAsError.value = '路径无效，请检查名称。';
            } else {
                saveAsError.value = '另存为失败，请稍后重试。';
            }
        } else {
            saveAsError.value = '另存为失败，请稍后重试。';
        }
    } finally {
        saveAsSaving.value = false;
    }
}

// ===========================================================================
// 删除
// ===========================================================================
const deleting = ref(false);

async function handleDelete() {
    const novelId = novelsStore.currentId;
    const path = editorStore.currentPath;
    if (novelId === null || !path) return;

    try {
        await ElMessageBox.confirm(`确定要删除文档「${docName.value}」吗？此操作不可撤销。`, '确认删除', {
            confirmButtonText: '删除',
            cancelButtonText: '取消',
            type: 'warning',
        });
    } catch {
        return;
    }

    deleting.value = true;
    try {
        await apiDeleteDocument(novelId, path);
        editorStore.closeDocument();
        ElMessage.success('已删除');
    } catch {
        ElMessage.error('删除失败，请稍后重试。');
    } finally {
        deleting.value = false;
    }
}

// ===========================================================================
// 键盘快捷键：Ctrl+S 保存
// ===========================================================================
function handleKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
    }
}
</script>

<template>
    <div class="document-editor" @keydown="handleKeydown">
        <!-- 空状态：未打开文档 -->
        <div v-if="!editorStore.currentPath" class="editor-empty">
            <ElIcon :size="48" color="var(--app-muted)">
                <DocumentAdd />
            </ElIcon>
            <p>从左侧目录树选择文档开始编辑</p>
        </div>

        <!-- 编辑态 -->
        <template v-else>
            <!-- 工具栏 -->
            <div class="editor-toolbar">
                <div class="toolbar-left">
                    <ElTooltip :content="editorStore.currentPath ?? ''" placement="bottom-start">
                        <span class="doc-path">{{ docName }}</span>
                    </ElTooltip>
                    <span v-if="editorStore.isDirty" class="dirty-mark">● 未保存</span>
                </div>
                <div class="toolbar-right">
                    <ElButton
                        :icon="Download"
                        size="small"
                        :loading="saving"
                        :disabled="!editorStore.isDirty"
                        type="primary"
                        @click="handleSave"
                    >
                        保存
                    </ElButton>
                    <ElButton size="small" @click="openSaveAs"> 另存为 </ElButton>
                    <ElButton :icon="Delete" size="small" :loading="deleting" type="danger" plain @click="handleDelete">
                        删除
                    </ElButton>
                </div>
            </div>

            <!-- 编辑区 -->
            <div class="editor-body">
                <ElInput
                    v-model="localText"
                    type="textarea"
                    class="editor-textarea"
                    :rows="1"
                    resize="none"
                    placeholder="在此输入文档正文…"
                />
            </div>
        </template>

        <!-- 另存为对话框 -->
        <ElDialog v-model="saveAsVisible" title="另存为" width="420px" :close-on-click-modal="false">
            <ElInput
                v-model="saveAsName"
                placeholder="输入新文件名（自动追加 .md）"
                :disabled="saveAsSaving"
                :class="{ 'is-error': saveAsError }"
                @keyup.enter="handleSaveAs"
            />
            <p v-if="saveAsError" class="save-as-error">{{ saveAsError }}</p>
            <template #footer>
                <ElButton :disabled="saveAsSaving" @click="saveAsVisible = false">取消</ElButton>
                <ElButton type="primary" :loading="saveAsSaving" :disabled="!saveAsName.trim()" @click="handleSaveAs">
                    确定
                </ElButton>
            </template>
        </ElDialog>
    </div>
</template>

<style scoped lang="scss">
.document-editor {
    display: flex;
    flex-direction: column;
    height: 100%;
    outline: none;
}

.editor-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: var(--app-muted);
    font-size: var(--app-font-base);
}

.editor-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--app-border);
    flex-shrink: 0;
    min-height: 42px;
}

.toolbar-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;

    .doc-path {
        font-weight: 600;
        font-size: var(--app-font-base);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        cursor: default;
    }

    .dirty-mark {
        font-size: var(--app-font-sm);
        color: var(--el-color-warning);
        flex-shrink: 0;
    }
}

.toolbar-right {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
}

.editor-body {
    flex: 1;
    overflow: hidden;
    display: flex;
}

.editor-textarea {
    flex: 1;

    :deep(.el-textarea__inner) {
        height: 100% !important;
        min-height: 300px;
        border: none;
        border-radius: 0;
        resize: none;
        font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
        font-size: 14px;
        line-height: 1.7;
        padding: 16px 20px;
        background: var(--app-bg);

        &:focus {
            box-shadow: none;
        }
    }
}

.save-as-error {
    margin: 6px 0 0;
    font-size: var(--app-font-sm);
    color: var(--el-color-danger);
}

.is-error :deep(.el-input__wrapper) {
    box-shadow: 0 0 0 1px var(--el-color-danger) inset;
}
</style>
