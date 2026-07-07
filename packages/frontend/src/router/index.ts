import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
    history: createWebHistory(import.meta.env.BASE_URL),
    routes: [
        {
            path: '/',
            name: 'home',
            component: () => import('@/views/NovelList.vue'),
        },
        {
            path: '/novel/:id',
            name: 'workspace',
            component: () => import('@/views/NovelWorkspace.vue'),
        },
        {
            path: '/novel/:id/settings',
            name: 'settings',
            component: () => import('@/views/NovelSettings.vue'),
        },
    ],
});

export default router;
