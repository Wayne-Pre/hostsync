import { buildApp } from './app.ts';

/**
 * The dev/prod entry point.
 *
 * Until now the app only existed as `buildApp()`, which tests drive in-memory
 * through `inject()`. Nothing ever called `listen()`, so there was no URL to
 * open. This is that URL.
 */
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

const app = buildApp({ logger: process.env.LOG_LEVEL !== 'silent' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port, host });
app.log.info(`HostSync ready on http://${host}:${port}`);
