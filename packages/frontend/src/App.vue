<script setup lang="ts">
import { ref } from 'vue';
import { ElButton } from 'element-plus';
import { Plus, Check } from '@element-plus/icons-vue';

const count = ref(0);
</script>

<template>
    <main class="app-demo">
        <h1>Novel Writer DB · 前端脚手架已就绪</h1>
        <p class="hint">Vue 3 + Vite + TypeScript + Element Plus（按需 import） + SCSS（sass-embedded）</p>

        <div class="actions">
            <ElButton type="primary" :icon="Plus" @click="count++">点我：{{ count }}</ElButton>
            <ElButton type="success" :icon="Check" :disabled="count === 0">已激活</ElButton>
        </div>
    </main>
</template>

<style scoped lang="scss">
.app-demo {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--app-gap);
    padding: var(--app-padding);

    .hint {
        margin: 0;
        color: var(--app-muted);
    }

    .actions {
        display: flex;
        gap: var(--app-gap);
    }
}
</style>
