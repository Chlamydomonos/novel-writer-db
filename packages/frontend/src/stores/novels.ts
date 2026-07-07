import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { NovelSummary, NovelDetail } from '@novel-writer/shared';
import * as api from '@/api/novel';

export const useNovelsStore = defineStore('novels', () => {
    /** 所有小说的摘要列表。 */
    const novels = ref<NovelSummary[]>([]);

    /** 当前选中小说 ID（路由参数映射）。 */
    const currentId = ref<number | null>(null);

    /** 当前选中小说的详情（含 info）。 */
    const currentNovel = ref<NovelDetail | null>(null);

    /** 是否正在加载列表。 */
    const loading = ref(false);

    /** 拉取全部小说列表。 */
    async function fetchNovels() {
        loading.value = true;
        try {
            novels.value = await api.listNovels();
        } finally {
            loading.value = false;
        }
    }

    /** 拉取当前小说详情。 */
    async function fetchCurrentNovel() {
        if (currentId.value === null) return;
        currentNovel.value = await api.getNovel(currentId.value);
    }

    return { novels, currentId, currentNovel, loading, fetchNovels, fetchCurrentNovel };
});
