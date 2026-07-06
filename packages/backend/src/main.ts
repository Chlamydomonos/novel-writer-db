// TODO

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
