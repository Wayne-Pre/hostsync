import { spawnSync } from 'node:child_process';
import { buildApp } from './app.ts';
import { startCalendarSync } from './calendar-sync.ts';

/**
 * The dev/prod entry point.
 *
 * Until now the app only existed as `buildApp()`, which tests drive in-memory
 * through `inject()`. Nothing ever called `listen()`, so there was no URL to
 * open. This is that URL.
 *
 * Free hosts do not offer a pre-deploy command, so the deploy itself runs the
 * migrations when RUN_MIGRATIONS=true. Migrations are idempotent, and this is
 * the same script the self-check uses locally.
 */
if (process.env.RUN_MIGRATIONS === 'true') {
  const migrated = spawnSync(process.execPath, ['scripts/migrate.ts'], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  if (migrated.status !== 0) process.exit(migrated.status ?? 1);
}

const port = Number(process.env.PORT ?? 3000);
// Cloud hosts route traffic to the container's public interface; binding only
// to loopback makes the service look healthy locally but unreachable online.
const host = process.env.HOST ?? '0.0.0.0';

const app = buildApp({ logger: process.env.LOG_LEVEL !== 'silent' });
let stopCalendarSync: () => void = () => {};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopCalendarSync();
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port, host });
app.log.info(`HostSync ready on http://${host}:${port}`);

// A free host wakes this process on traffic; the first sync pass therefore
// happens after every idle period, and the timer covers an awake session.
stopCalendarSync = startCalendarSync((message) => app.log.info(message));
