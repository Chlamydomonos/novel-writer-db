// 启动 HTTP server，同时挂载：
//   - REST API：`/api/*`（见 `http/routes/*`）
//   - MCP endpoint：`MCP_PATH` 默认 `/mcp`（见 `http/server.ts` + `mcp/server.ts`）

import { buildApp } from './http/server.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';

const app = await buildApp();

try {
    await app.listen({ port: PORT, host: HOST });
} catch (err) {
    app.log.error(err);
    process.exit(1);
}
