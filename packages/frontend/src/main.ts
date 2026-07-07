import { createApp } from 'vue';
import { createPinia } from 'pinia';

import App from './App.vue';
import router from './router';

// 全局样式：仅导入 element-plus 全量 CSS；组件本体在各 .vue 文件按需 import，
// 以获得完整的 TypeScript 类型提示（不使用 app.use(ElementPlus) 全局注册）
import 'element-plus/dist/index.css';
import './styles/index.scss';

const app = createApp(App);

app.use(createPinia());
app.use(router);

app.mount('#app');
