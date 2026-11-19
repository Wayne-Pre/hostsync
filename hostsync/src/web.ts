import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import type { FastifyReply } from 'fastify';

/**
 * Serves the built React bundle.
 *
 * The bundle is plain static output from `npm run build:web` (esbuild). There is
 * no dev server watching files: this machine has 3.4 GB RAM, and a second Node
 * process holding a bundler is exactly what produced the earlier
 * `VirtualAlloc failed` crashes.
 */
export const PUBLIC_DIR = resolve(process.cwd(), 'public');

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

const SHELL_TITLE = 'HostSync — Add your property. We hold every night.';

function missingBuildHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${SHELL_TITLE}</title>
<link rel="stylesheet" href="/assets/app.css"></head>
<body><div id="root"><main style="font:16px system-ui;padding:48px;max-width:52ch">
<h1>HostSync</h1>
<p>The web bundle has not been built yet. Run <code>npm run build:web</code>.</p>
</main></div></body></html>`;
}

let shellCache: string | null = null;

export function shellHtml(): string {
  if (shellCache === null) {
    const file = resolve(PUBLIC_DIR, 'index.html');
    shellCache = existsSync(file) ? readFileSync(file, 'utf8') : missingBuildHtml();
  }
  return shellCache;
}

/** Tests rebuild the bundle inside one process, so the cache must be droppable. */
export function resetShellCache(): void {
  shellCache = null;
}

export function sendShell(reply: FastifyReply): void {
  reply
    .code(200)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .send(shellHtml());
}

const ASSET_CACHE = new Set(['/assets/app.js', '/assets/app.css', '/assets/logo.jpeg']);

/**
 * Serve one built asset. Returns false (and sends nothing) when the path is not
 * a real file inside `public/`, so the caller can answer 404.
 *
 * Only the two bundle files exist, and they are served `no-store`: a stale
 * bundle after a rebuild is a correctness bug, and hashed filenames are not
 * worth the extra build step on this machine.
 */
export function sendAsset(pathname: string, reply: FastifyReply): boolean {
  const path = pathname.split('?')[0] ?? '';
  if (!ASSET_CACHE.has(path)) return false;

  const file = resolve(PUBLIC_DIR, path.replace(/^\/+/, ''));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) return false;
  if (!existsSync(file) || !statSync(file).isFile()) return false;

  reply
    .code(200)
    .header('content-type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
    .header('cache-control', 'no-store')
    .send(readFileSync(file));
  return true;
}
