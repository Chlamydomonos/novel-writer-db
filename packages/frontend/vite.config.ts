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
        // 开发期：将 /api 请求代理到后端 (默认 http://localhost:3000)
        proxy: {
            '/api': 'http://localhost:3000',
        },
    },
    css: {
        preprocessorOptions: {
            // Vite 8 默认使用 modern compiler API；sass-embedded 自动启用
            scss: {},
        },
    },
});
