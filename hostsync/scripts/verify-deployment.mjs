#!/usr/bin/env node
/**
 * Smoke-check a deployed instance over HTTPS:
 *
 *   BASE_URL=https://hostsync.example.com npm run verify:deploy
 *
 * Verifies the shell, the built bundle, the server-side auth guard and that no
 * Base44 SDK/badge survived the rebuild. Prints cold/warm timings.
 */
const base = (process.env.BASE_URL ?? '').replace(/\/$/, '');
if (!base) {
  console.error('BASE_URL is required, e.g. https://hostsync.example.com');
  process.exit(2);
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function timed(path, options) {
  const start = performance.now();
  const response = await fetch(base + path, { redirect: 'manual', ...options });
  const body = await response.text();
  return { response, body, ms: performance.now() - start };
}

try {
  const landing = await timed('/');
  check(
    'landing page',
    landing.response.status === 200 && landing.body.includes('/assets/app.js'),
    `${landing.response.status} in ${landing.ms.toFixed(0)}ms`
  );
  check(
    'no Base44 badge or SDK in the shell',
    !/base44|badge\.js|Edit with/i.test(landing.body)
  );

  const warm = await timed('/');
  check('warm page', warm.response.status === 200, `${warm.ms.toFixed(0)}ms`);

  const script = await timed('/assets/app.js');
  check(
    'browser bundle',
    script.response.status === 200 && script.body.length > 10_000,
    `${script.body.length} bytes`
  );
  check(
    'bundle has no paid SDK strings',
    !/base44|badge\.js|Edit with/i.test(script.body)
  );

  const css = await timed('/assets/app.css');
  check('stylesheet', css.response.status === 200, `${css.body.length} bytes`);

  const guard = await timed('/dashboard');
  check(
    'anonymous /dashboard redirects to /login',
    guard.response.status === 302 && guard.response.headers.get('location') === '/login',
    `${guard.response.status} -> ${guard.response.headers.get('location')}`
  );

  const api = await timed('/api/financials');
  check('anonymous API is refused', api.response.status >= 400 && api.response.status < 500,
    `${api.response.status}`);

  console.log(checks.every((c) => c.ok) ? '\nDEPLOYMENT VERIFIED' : '\nDEPLOYMENT CHECK FAILED');
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
} catch (error) {
  console.error(`DEPLOYMENT CHECK FAILED: ${error.message}`);
  process.exitCode = 1;
}
