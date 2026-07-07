<script setup lang="ts">
// CategoryTree.vue — 目录树（基于 el-tree，支持 lazy 加载）
// 数据来源：GET /api/novels/:id/tree，每展开一层才加载子节点。
// 使用节点后的操作按钮管理目录与文档（无右键菜单）。

import { ref, computed, watch, nextTick } from 'vue';
import { ElTree, ElRadioGroup, ElRadio, ElButton, ElIcon, ElInput, ElScrollbar, ElMessageBox } from 'element-plus';
import { Folder, Document, FolderAdd, DocumentAdd, Edit, Delete, Check, Close } from '@element-plus/icons-vue';
import { useNovelsStore } from '@/stores/novels';
import { useEditorStore } from '@/stores/editor';
import { listTree, readDocuments, writeDocument, deleteDocument, deleteCategory } from '@/api/novel';
import type { RootCategoryName, TreeNode } from '@novel-writer/shared';
import type Node from 'element-plus/es/components/tree/src/model/node';

// ===========================================================================
// Stores
// ===========================================================================
const novelsStore = useNovelsStore();
const editorStore = useEditorStore();

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
// 懒加载子节点
// ===========================================================================
async function loadChildren(node: Node, resolve: (children: TreeNodeData[]) => void) {
    const data: TreeNodeData = node.data as TreeNodeData;
    if (data.loaded || data.type === 'document') {
        resolve(data.children ?? []);
        return;
    }
    data.loading = true;
    try {
        const novelId = novelsStore.currentId;
        if (novelId === null) {
            resolve([]);
            return;
        }
        const nodes = await listTree(novelId, data.path);
        const children = nodes.map((n) => mapNode(n, data.path));
        data.children = children;
        data.loaded = true;
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

async function confirmAdd() {
    const state = addingState.value;
    if (!state || !state.name.trim()) return;

    const novelId = novelsStore.currentId;
    if (novelId === null) return;

    let writePath: string;
    if (state.isCategory) {
        // 写入一个占位文档以触发后端自动创建中间目录
        writePath = `${state.parentPath}/${state.name.trim()}/_placeholder.md`;
    } else {
        const trimmed = state.name.trim();
        const docName = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
        writePath = `${state.parentPath}/${docName}`;
    }

    try {
        await writeDocument(novelId, { path: writePath, text: '' });
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
            <ElButton :icon="FolderAdd" link size="small" @click="startAdd(rootPath, true)"> 新建目录 </ElButton>
            <ElButton :icon="DocumentAdd" link size="small" @click="startAdd(rootPath, false)"> 新建文档 </ElButton>
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
</style>
