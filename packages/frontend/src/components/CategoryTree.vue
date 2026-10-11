<script setup lang="ts">
// CategoryTree.vue — 目录树（基于 el-tree，支持 lazy 加载）
// 数据来源：GET /api/novels/:id/tree，每展开一层才加载子节点。
// 使用节点后的操作按钮管理目录与文档（无右键菜单）。

import { ref, computed, watch, nextTick } from 'vue';
import {
    ElTree,
    ElRadioGroup,
    ElRadio,
    ElButton,
    ElIcon,
    ElInput,
    ElScrollbar,
    ElMessageBox,
    ElDialog,
    ElCascader,
    ElMessage,
} from 'element-plus';
import {
    Folder,
    Document,
    FolderAdd,
    DocumentAdd,
    Edit,
    Delete,
    Check,
    Close,
    Refresh,
    Position,
} from '@element-plus/icons-vue';
import { useNovelsStore } from '@/stores/novels';
import { useEditorStore } from '@/stores/editor';
import {
    listTree,
    readDocuments,
    writeDocument,
    deleteDocument,
    deleteCategory,
    createCategory,
    moveDocument,
} from '@/api/novel';
import { ApiError } from '@/api/client';
import { ROOT_CATEGORY_NAMES, type RootCategoryName, type TreeNode } from '@novel-writer/shared';
import type { CascaderOption, CascaderValue } from 'element-plus/es/components/cascader-panel/src/types';
import type Node from 'element-plus/es/components/tree/src/model/node';

// ===========================================================================
// Stores
// ===========================================================================
const novelsStore = useNovelsStore();
const editorStore = useEditorStore();

// ===========================================================================
// 刷新状态
// ===========================================================================
const refreshing = ref(false);

// ===========================================================================
// 内部树节点类型（在 TreeNode 基础上附加路径与加载状态）
// ===========================================================================
interface TreeNodeData {
    type: 'category' | 'document';
    name: string;
    /** 绝对路径，如 `/设定/世界/人物卡.md`。 */
    path: string;
    /** 仅 category 有 children（懒加载用）。 */
    children?: TreeNodeData[];
    /** 是否已从后端加载过子节点。 */
    loaded: boolean;
    /** 是否正在加载子节点。 */
    loading: boolean;
    /** 是否为叶子节点（el-tree 内部使用）。 */
    isLeaf?: boolean;
}

const treeProps = {
    children: 'children' as const,
    isLeaf: 'isLeaf' as const,
};

// ===========================================================================
// 当前根目录
// ===========================================================================
const currentRoot = ref<RootCategoryName>('设定');
const rootPath = computed(() => `/${currentRoot.value}`);

// ===========================================================================
// 树数据
// ===========================================================================
const treeData = ref<TreeNodeData[]>([]);

function mapNode(node: TreeNode, parentPath: string): TreeNodeData {
    const path = parentPath === '/' ? `/${node.name}` : `${parentPath}/${node.name}`;
    const isDoc = node.type === 'document';
    return {
        type: node.type,
        name: node.name,
        path,
        children: isDoc ? undefined : [],
        loaded: false,
        loading: false,
        isLeaf: isDoc,
    };
}

/** 重新加载当前根目录下的一级子节点。 */
async function loadRoot() {
    const novelId = novelsStore.currentId;
    if (novelId === null) return;
    try {
        const nodes = await listTree(novelId, rootPath.value);
        treeData.value = nodes.map((n) => mapNode(n, rootPath.value));
    } catch {
        treeData.value = [];
    }
}

// ===========================================================================
// 刷新：重新加载所有已展开目录的内容，保持展开状态
// ===========================================================================

/** 递归刷新已加载的目录节点（保持展开状态）。 */
async function refreshNode(data: TreeNodeData, novelId: number) {
    if (data.type !== 'category' || !data.loaded) return;

    try {
        const nodes = await listTree(novelId, data.path);
        const newChildren = nodes.map((n) => mapNode(n, data.path));

        // 保留旧子节点中已加载的孙节点（递归刷新）
        for (const newChild of newChildren) {
            if (newChild.type === 'category') {
                const oldChild = data.children?.find((c) => c.path === newChild.path);
                if (oldChild?.loaded) {
                    newChild.children = oldChild.children;
                    newChild.loaded = true;
                    newChild.isLeaf = oldChild.isLeaf;
                    await refreshNode(newChild, novelId);
                }
            }
        }

        data.children = newChildren;
        if (newChildren.length === 0) {
            data.isLeaf = true;
        }
    } catch {
        // 节点可能已被删除，跳过
    }
}

async function refreshAll() {
    const novelId = novelsStore.currentId;
    if (novelId === null) return;

    refreshing.value = true;
    try {
        // 重新加载根目录一级子节点
        const nodes = await listTree(novelId, rootPath.value);
        const newRoot = nodes.map((n) => mapNode(n, rootPath.value));

        // 保留已加载的子节点并递归刷新
        for (const newChild of newRoot) {
            if (newChild.type === 'category') {
                const oldChild = treeData.value.find((c) => c.path === newChild.path);
                if (oldChild?.loaded) {
                    newChild.children = oldChild.children;
                    newChild.loaded = true;
                    newChild.isLeaf = oldChild.isLeaf;
                    await refreshNode(newChild, novelId);
                }
            }
        }

        treeData.value = newRoot;
    } catch {
        // 刷新失败，静默忽略
    } finally {
        refreshing.value = false;
    }
}

// ===========================================================================
// 懒加载子节点
// ===========================================================================
async function loadChildren(node: Node, resolve: (children: TreeNodeData[]) => void) {
    const novelId = novelsStore.currentId;
    if (novelId === null) {
        resolve([]);
        return;
    }

    // lazy 模式下，el-tree 可能先请求根节点（node.level === 0）。
    if (node.level === 0) {
        try {
            const nodes = await listTree(novelId, rootPath.value);
            const children = nodes.map((n) => mapNode(n, rootPath.value));
            treeData.value = children;
            resolve(children);
        } catch {
            resolve([]);
        }
        return;
    }

    const data = node.data as TreeNodeData | undefined;
    if (!data || data.type === 'document') {
        resolve([]);
        return;
    }
    if (data.loaded) {
        resolve(data.children ?? []);
        return;
    }

    data.loading = true;
    try {
        const nodes = await listTree(novelId, data.path);
        const children = nodes.map((n) => mapNode(n, data.path));
        data.children = children;
        data.loaded = true;
        if (children.length === 0) {
            data.isLeaf = true;
        }
        resolve(children);
    } catch {
        resolve([]);
    } finally {
        data.loading = false;
    }
}

// ===========================================================================
// 点击节点：打开文档
// ===========================================================================
async function handleNodeClick(data: TreeNodeData) {
    if (data.type !== 'document') return;
    await openDocument(data);
}

async function openDocument(data: TreeNodeData) {
    const novelId = novelsStore.currentId;
    if (novelId === null) return;
    try {
        const docs = await readDocuments(novelId, [data.path]);
        const doc = docs[0];
        if (doc) {
            editorStore.openDocument(doc);
        }
    } catch {
        // 读取失败（如文档不存在），静默忽略
    }
}

// ===========================================================================
// 内联新建表单
// ===========================================================================
interface AddingState {
    parentPath: string;
    isCategory: boolean;
    name: string;
}

const addingState = ref<AddingState | null>(null);

function startAdd(parentPath: string, isCategory: boolean) {
    addingState.value = { parentPath, isCategory, name: '' };
    nextTick(() => {
        // 聚焦输入框（通过自动聚焦或 ref 均可）
    });
}

function startAddAtRoot(isCategory: boolean) {
    startAdd(rootPath.value, isCategory);
}

async function confirmAdd() {
    const state = addingState.value;
    if (!state || !state.name.trim()) return;

    const novelId = novelsStore.currentId;
    if (novelId === null) return;

    try {
        if (state.isCategory) {
            const categoryPath = `${state.parentPath}/${state.name.trim()}`;
            await createCategory(novelId, { path: categoryPath });
        } else {
            const trimmed = state.name.trim();
            const docName = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
            const writePath = `${state.parentPath}/${docName}`;
            await writeDocument(novelId, { path: writePath, text: '' });
        }
        addingState.value = null;
        await loadRoot();
    } catch {
        // 出错时保留输入表单，用户可重试
    }
}

function cancelAdd() {
    addingState.value = null;
}

// ===========================================================================
// 移动文档（级联懒加载选择目标目录；后端会自动改写指向旧路径的链接）
// ===========================================================================
const moveVisible = ref(false);
const moveSubmitting = ref(false);
const moveTarget = ref<TreeNodeData | null>(null);
/** 级联选择路径数组，如 ['/设定', '/设定/番外']，末项即目标目录的完整路径。 */
const movePaths = ref<string[]>([]);

const moveCascaderProps = {
    lazy: true,
    checkStrictly: true,
    lazyLoad: async (node: unknown, resolve: (options?: CascaderOption[]) => void) => {
        const n = node as { level: number; value?: string };
        const novelId = novelsStore.currentId;

        if (n.level === 0) {
            // 第一层：三个根目录
            resolve(ROOT_CATEGORY_NAMES.map((name) => ({ value: `/${name}`, label: name, leaf: false })));
        } else if (n.value && novelId !== null) {
            // 更深层：懒加载真实子目录（仅保留目录类型）
            const dir = n.value;
            const nodes = await listTree(novelId, dir).catch(() => [] as TreeNode[]);
            resolve(
                nodes
                    .filter((m) => m.type === 'category')
                    .map((m) => ({ value: `${dir}/${m.name}`, label: m.name, leaf: false })),
            );
        } else {
            resolve([]);
        }
    },
};

/** 预览目标完整路径（已选定目录时）。 */
const movePreview = computed(() => {
    const dir = movePaths.value.at(-1);
    if (!moveTarget.value || !dir) return null;
    return `${dir}/${moveTarget.value.name}`;
});

function onMovePathsChange(value: CascaderValue | null | undefined) {
    movePaths.value = Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)];
}

function startMove(data: TreeNodeData) {
    moveTarget.value = data;
    movePaths.value = [];
    moveVisible.value = true;
}

async function confirmMove() {
    const target = moveTarget.value;
    const dir = movePaths.value.at(-1);
    const novelId = novelsStore.currentId;
    if (!target || !dir || novelId === null) return;

    const to = `${dir}/${target.name}`;
    if (to === target.path) {
        ElMessage.warning('目标路径与源路径相同');
        return;
    }

    moveSubmitting.value = true;
    try {
        await moveDocument(novelId, { path: target.path, to });
        ElMessage.success(`已移动到 ${to}`);
        moveVisible.value = false;

        // 若该文档正在编辑器中打开：移动可能改写了其自身相对链接，重新读取正文
        if (editorStore.currentPath === target.path) {
            try {
                const docs = await readDocuments(novelId, [to]);
                const doc = docs[0];
                if (doc) editorStore.openDocument(doc);
                else editorStore.closeDocument();
            } catch {
                editorStore.closeDocument();
            }
        }

        await refreshAll();
    } catch (e) {
        if (e instanceof ApiError && e.type === 'ExistError') {
            ElMessage.error('目标位置已存在同名文档');
        } else if (e instanceof ApiError && e.type === 'InvalidPathError') {
            ElMessage.error('路径无效');
        } else {
            ElMessage.error('移动失败，请稍后重试。');
        }
    } finally {
        moveSubmitting.value = false;
    }
}

// ===========================================================================
// 删除
// ===========================================================================
async function handleDelete(data: TreeNodeData) {
    const novelId = novelsStore.currentId;
    if (novelId === null) return;

    const label = data.type === 'category' ? '目录' : '文档';
    try {
        await ElMessageBox.confirm(`确定要删除${label}「${data.name}」吗？此操作不可撤销。`, '确认删除', {
            confirmButtonText: '删除',
            cancelButtonText: '取消',
            type: 'warning',
        });
    } catch {
        return; // 用户取消
    }

    try {
        if (data.type === 'category') {
            await deleteCategory(novelId, data.path);
        } else {
            await deleteDocument(novelId, data.path);
        }
        // 若当前编辑器正打开该文档，则关闭
        if (editorStore.currentPath === data.path) {
            editorStore.closeDocument();
        }
        await loadRoot();
    } catch {
        // 删除失败（如 404），刷新树即可
        await loadRoot();
    }
}

// ===========================================================================
// 监听：根目录切换 / 小说切换 → 重新加载树
// ===========================================================================
watch(currentRoot, () => {
    loadRoot();
});

watch(
    () => novelsStore.currentId,
    (id) => {
        if (id !== null) loadRoot();
    },
    { immediate: true },
);
</script>

<template>
    <div class="category-tree">
        <!-- 根目录切换 -->
        <ElRadioGroup v-model="currentRoot" class="root-switcher" size="small">
            <ElRadio value="设定">设定</ElRadio>
            <ElRadio value="大纲">大纲</ElRadio>
            <ElRadio value="正文">正文</ElRadio>
        </ElRadioGroup>

        <!-- 当前根目录下的新建按钮 -->
        <div class="tree-actions">
            <ElButton :icon="FolderAdd" link size="small" @click="startAddAtRoot(true)"> 新建目录 </ElButton>
            <ElButton :icon="DocumentAdd" link size="small" @click="startAddAtRoot(false)"> 新建文档 </ElButton>
            <ElButton :icon="Refresh" link size="small" :loading="refreshing" @click="refreshAll"> 刷新 </ElButton>
        </div>

        <!-- 树 -->
        <ElScrollbar class="tree-scroll">
            <ElTree
                :data="treeData"
                :props="treeProps"
                lazy
                :load="loadChildren"
                highlight-current
                node-key="path"
                @node-click="handleNodeClick"
            >
                <template #default="{ data }">
                    <div class="tree-node-content">
                        <ElIcon class="node-icon">
                            <Folder v-if="data.type === 'category'" />
                            <Document v-else />
                        </ElIcon>
                        <span class="node-name">{{ data.name }}</span>
                        <span class="node-actions">
                            <template v-if="data.type === 'category'">
                                <ElButton
                                    link
                                    :icon="DocumentAdd"
                                    title="新建文档"
                                    @click.stop="startAdd(data.path, false)"
                                />
                                <ElButton
                                    link
                                    :icon="FolderAdd"
                                    title="新建子目录"
                                    @click.stop="startAdd(data.path, true)"
                                />
                            </template>
                            <template v-else>
                                <ElButton link :icon="Edit" title="打开编辑" @click.stop="openDocument(data)" />
                                <ElButton link :icon="Position" title="移动" @click.stop="startMove(data)" />
                            </template>
                            <ElButton link :icon="Delete" title="删除" @click.stop="handleDelete(data)" />
                        </span>
                    </div>
                </template>
            </ElTree>
        </ElScrollbar>

        <!-- 内联新建表单 -->
        <div v-if="addingState" class="inline-add">
            <ElInput
                v-model="addingState.name"
                size="small"
                :placeholder="addingState.isCategory ? '输入目录名称' : '输入文档名称（自动追加 .md）'"
                @keyup.enter="confirmAdd"
                @keyup.escape="cancelAdd"
            />
            <ElButton :icon="Check" size="small" circle @click="confirmAdd" />
            <ElButton :icon="Close" size="small" circle @click="cancelAdd" />
        </div>

        <!-- 移动文档对话框 -->
        <ElDialog v-model="moveVisible" title="移动文档" width="420px" :close-on-click-modal="!moveSubmitting">
            <div class="move-body">
                <div class="move-row">
                    <span class="move-label">源文档：</span>
                    <span class="move-value">{{ moveTarget?.path }}</span>
                </div>
                <ElCascader
                    :model-value="movePaths"
                    class="move-cascader"
                    placeholder="选择目标目录"
                    :props="moveCascaderProps"
                    @update:model-value="onMovePathsChange"
                />
                <div class="move-row">
                    <span class="move-label">目标路径：</span>
                    <span class="move-value" :class="{ 'is-ready': movePreview }">
                        {{ movePreview ?? '（尚未选择目标目录）' }}
                    </span>
                </div>
            </div>
            <template #footer>
                <ElButton :disabled="moveSubmitting" @click="moveVisible = false">取消</ElButton>
                <ElButton type="primary" :loading="moveSubmitting" :disabled="!movePreview" @click="confirmMove">
                    移动
                </ElButton>
            </template>
        </ElDialog>
    </div>
</template>

<style scoped lang="scss">
.category-tree {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
}

.root-switcher {
    padding: 4px 8px;
    flex-shrink: 0;
}

.tree-actions {
    padding: 0 8px 4px;
    display: flex;
    gap: 4px;
    flex-shrink: 0;
}

.tree-scroll {
    flex: 1;
    overflow: hidden;
}

.tree-node-content {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
    gap: 4px;

    .node-icon {
        flex-shrink: 0;
    }

    .node-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .node-actions {
        flex-shrink: 0;
        display: none;
        gap: 2px;
        margin-left: auto;
    }

    &:hover .node-actions {
        display: flex;
    }
}

.inline-add {
    padding: 4px 8px;
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    border-top: 1px solid var(--el-border-color-light);
}

.move-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.move-row {
    display: flex;
    gap: 8px;
    font-size: 13px;
    line-height: 24px;

    .move-label {
        flex-shrink: 0;
        color: var(--el-text-color-secondary);
    }

    .move-value {
        flex: 1;
        min-width: 0;
        overflow-wrap: anywhere;
        color: var(--el-text-color-secondary);

        &.is-ready {
            color: var(--el-text-color-primary);
        }
    }
}

.move-cascader {
    width: 100%;
}
</style>
