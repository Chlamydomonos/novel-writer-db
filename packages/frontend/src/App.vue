<script setup lang="ts">
// App.vue — 根组件，只承载 <router-view>
</script>

<template>
    <router-view />
</template>

<style lang="scss">
// 全局布局：填满视口
#app {
    display: flex;
    flex-direction: column;
    min-height: 100%;
}
</style>
