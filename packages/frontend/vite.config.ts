import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import vueDevTools from 'vite-plugin-vue-devtools';

// https://vite.dev/config/
export default defineConfig({
    plugins: [vue(), vueDevTools()],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
    },
    server: {
        // 开发期：把 /api/* 请求代理到宿主机 nginx（部署在 3912 端口）的 /api/*
        // 即 http://localhost:3912/api/* —— 由 nginx 二次反代到容器内 backend
        // 与生产前端的同源访问路径完全一致（浏览器 → nginx → backend）
        proxy: {
            '/api': {
                target: 'http://localhost:3912',
                changeOrigin: true,
            },
        },
    },
    css: {
        preprocessorOptions: {
            // Vite 8 默认使用 modern compiler API；sass-embedded 自动启用
            scss: {},
        },
    },
});
