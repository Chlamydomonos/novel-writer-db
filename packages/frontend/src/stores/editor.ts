import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { DocumentRef } from '@novel-writer/shared';

export const useEditorStore = defineStore('editor', () => {
    /** 当前编辑的文档路径（绝对路径，如 `/设定/人物卡.md`）。 */
    const currentPath = ref<string | null>(null);

    /** 当前文档正文。 */
    const currentText = ref('');

    /** 是否有未保存的修改（简单 dirty 标记）。 */
    const isDirty = ref(false);

    /** 打开文档进行编辑。 */
    function openDocument(doc: DocumentRef) {
        currentPath.value = doc.path;
        currentText.value = doc.text;
        isDirty.value = false;
    }

    /** 标记内容已修改。 */
    function markDirty() {
        isDirty.value = true;
    }

    /** 关闭当前文档。 */
    function closeDocument() {
        currentPath.value = null;
        currentText.value = '';
        isDirty.value = false;
    }

    return { currentPath, currentText, isDirty, openDocument, markDirty, closeDocument };
});
