#!/usr/bin/env node
/**
 * The self-check.
 *
 *   node scripts/selfcheck.mjs             -> typecheck + every test
 *   node scripts/selfcheck.mjs --tests-only
 *   node scripts/selfcheck.mjs test/04-bookings.test.ts   -> typecheck + one test file
 *
 * A feature is only "done" when this exits 0.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const testsOnly = argv.includes('--tests-only');
const explicit = argv.filter((arg) => !arg.startsWith('--'));

const cwd = process.cwd();
let step = 0;

function heading(label) {
  step += 1;
  console.log(`\n[${step}] ${label}`);
}

function run(command, args, label) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd });
  if (result.error) {
    console.error(`  could not start ${label}: ${result.error.message}`);
    return false;
  }
  return result.status === 0;
}

if (!testsOnly) {
  const tsc = join(cwd, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) {
    console.error('typescript is not installed — run: npm install');
    process.exit(1);
  }
  heading('typecheck (server + web)');
  if (!run(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json'], 'tsc (server)')) {
    console.error('\nSELF-CHECK FAILED at typecheck (server)');
    process.exit(1);
  }
  if (!run(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.web.json'], 'tsc (web)')) {
    console.error('\nSELF-CHECK FAILED at typecheck (web)');
    process.exit(1);
  }
  console.log('  ok');
}

heading('web bundle (esbuild)');
if (!run(process.execPath, [join(cwd, 'scripts', 'build-web.mjs')], 'build-web')) {
  console.error('\nSELF-CHECK FAILED at web bundle');
  process.exit(1);
}

const testDir = join(cwd, 'test');
const files = explicit.length
  ? explicit
  : readdirSync(testDir)
      .filter((file) => file.endsWith('.test.ts'))
      .sort()
      .map((file) => join(testDir, file));

if (files.length === 0) {
  console.error('no test files found');
  process.exit(1);
}

heading('migrations');
if (!run(process.execPath, [join(cwd, 'scripts', 'migrate.ts')], 'migrate')) {
  console.error('\nSELF-CHECK FAILED at migrations');
  process.exit(1);
}

heading(`tests (${files.length} file${files.length === 1 ? '' : 's'})`);
// This machine has ~3.4 GB RAM. Four parallel Node processes (Fastify + AJV +
// argon2 each) exhaust it and produce VirtualAlloc crashes, so files run one at
// a time. Each file is already independent and uses its own fixtures.
//
// `--test-force-exit` is deliberate: a Playwright file can finish every test and
// still hold the browser's stdio pipes open for minutes on this box, which makes
// the runner wait forever for a worker that has nothing left to do. The flag
// exits the worker once the tests are done, so the gate reports the truth.
const ok = run(
  process.execPath,
  ['--test', '--test-concurrency=1', '--test-reporter=spec', '--test-force-exit', ...files],
  'node --test'
);

if (!ok) {
  console.error('\nSELF-CHECK FAILED at tests');
  process.exit(1);
}

console.log('\nSELF-CHECK PASSED');
