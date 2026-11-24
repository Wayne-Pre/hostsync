#!/usr/bin/env node
/**
 * Build the browser bundle.
 *
 * esbuild, not Vite: this machine has ~3.4 GB RAM, and a rollup-based build is
 * the kind of thing that produced the earlier out-of-memory crashes. esbuild
 * bundles the same React app in a fraction of a second and a fraction of the
 * memory, and there is no dev server holding a second copy of the graph.
 *
 *   node scripts/build-web.mjs          -> public/
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const outDir = join(root, 'public');
const assets = join(outDir, 'assets');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });

const result = await build({
  entryPoints: [join(root, 'web', 'main.tsx')],
  outfile: join(assets, 'app.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome110', 'edge110', 'safari16'],
  jsx: 'automatic',
  sourcemap: false,
  minify: true,
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
  metafile: true,
});

cpSync(join(root, 'web', 'styles.css'), join(assets, 'app.css'));
cpSync(join(root, 'web', 'logo.jpeg'), join(assets, 'logo.jpeg'));
cpSync(join(root, 'web', 'manifest.webmanifest'), join(outDir, 'manifest.webmanifest'));
cpSync(join(root, 'web', 'index.html'), join(outDir, 'index.html'));

const bytes = Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0);
console.log(`web bundle: ${(bytes / 1024).toFixed(1)} kB -> public/assets/app.js`);
