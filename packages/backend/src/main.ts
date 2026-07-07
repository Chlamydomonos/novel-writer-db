// 启动 HTTP server，同时挂载：
//   - REST API：`/api/*`（见 `http/routes/*`）
//   - MCP endpoint：`MCP_PATH` 默认 `/mcp`（见 `http/server.ts` + `mcp/server.ts`）

import { buildApp } from './http/server.js';
import { getDB } from './lib/db/sequelize.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';

// 预热数据库：db.sync() 建表 + PRAGMA 设置必须在监听端口前完成，
// 否则首个请求触发懒初始化时若 DB 文件/目录缺失会返回 500。
await getDB();

const app = await buildApp();

try {
    await app.listen({ port: PORT, host: HOST });
} catch (err) {
    app.log.error(err);
    process.exit(1);
}
