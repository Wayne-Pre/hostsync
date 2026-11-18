#!/usr/bin/env node
/**
 * Dependency-free stress test for the real HTTP server.
 *
 *   npm run stress                     # 8 virtual users, 20 seconds
 *   STRESS_VUS=16 STRESS_SECONDS=60 npm run stress
 *
 * It boots the app on a random port, seeds one portfolio through the public
 * API, hammers the read endpoints with a signed-in cookie, then races eight
 * identical bookings to prove the database still holds the line. No paid
 * tooling, no browser, no second process.
 */
process.env.PG_POOL_MAX ||= '8';

const { buildApp } = await import('../src/app.ts');
const { createCaptureTransport } = await import('../src/mail.ts');
const { signUp, createProperty, createBooking, deleteUser } = await import('../test/api-helpers.ts');
const { addDays, todayUTC } = await import('../src/dates.ts');
const { closePool } = await import('../src/db.ts');

const VUS = Math.max(1, Number(process.env.STRESS_VUS ?? 8));
const SECONDS = Math.max(1, Number(process.env.STRESS_SECONDS ?? 20));
const mailer = createCaptureTransport();
const app = buildApp({ mailer, logger: false });
let user;

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100) * sorted.length - 1)];
}

try {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  const base = `http://127.0.0.1:${address.port}`;

  user = await signUp(app, mailer, 'STRESS');
  const property = await createProperty(app, user, {
    name: 'Stress House',
    nightlyRateCents: 1_000_000,
    cleaningFeeCents: 50_000,
  });
  const today = todayUTC();
  for (let i = 0; i < 5; i += 1) {
    await createBooking(app, user, {
      propertyId: property.id,
      guestName: `Guest ${i}`,
      channel: i % 2 ? 'airbnb' : 'direct',
      checkIn: addDays(today, i * 3 + 1),
      checkOut: addDays(today, i * 3 + 3),
      guests: 2,
    });
  }
  await app.inject({
    method: 'POST',
    url: '/api/transactions/expense',
    headers: { cookie: user.cookie },
    payload: {
      propertyId: property.id,
      date: today,
      category: 'housekeeping',
      amountCents: 25_000,
      description: 'Stress clean',
    },
  });

  const endpoints = [
    ['/', 0.25],
    ['/api/dashboard', 0.25],
    ['/api/bookings', 0.2],
    ['/api/transactions', 0.15],
    ['/api/statements', 0.15],
  ];
  const cumulative = [];
  let sum = 0;
  for (const [url, weight] of endpoints) {
    sum += weight;
    cumulative.push([url, sum]);
  }
  const pick = () => {
    const r = Math.random() * sum;
    return cumulative.find(([, limit]) => r <= limit)[0];
  };

  const stats = new Map(endpoints.map(([url]) => [url, { ok: 0, bad: 0, ms: [] }]));
  const deadline = Date.now() + SECONDS * 1000;
  const headers = { cookie: user.cookie };

  console.log(`stress: ${VUS} VUs for ${SECONDS}s against ${base}`);
  const workers = Array.from({ length: VUS }, async () => {
    while (Date.now() < deadline) {
      const url = pick();
      const start = performance.now();
      let ok = false;
      try {
        const response = await fetch(base + url, { headers });
        await response.arrayBuffer();
        ok = response.status < 400;
      } catch {
        ok = false;
      }
      const entry = stats.get(url);
      entry.ms.push(performance.now() - start);
      if (ok) entry.ok += 1;
      else entry.bad += 1;
    }
  });
  await Promise.all(workers);

  let totalOk = 0;
  let totalBad = 0;
  const allLatencies = [];
  console.log('\nendpoint                 ok    fail   p50      p95      p99');
  for (const [url, entry] of stats) {
    totalOk += entry.ok;
    totalBad += entry.bad;
    allLatencies.push(...entry.ms);
    console.log(
      url.padEnd(22),
      String(entry.ok).padStart(6),
      String(entry.bad).padStart(6),
      `${percentile(entry.ms, 50).toFixed(0)}ms`.padStart(8),
      `${percentile(entry.ms, 95).toFixed(0)}ms`.padStart(8),
      `${percentile(entry.ms, 99).toFixed(0)}ms`.padStart(8)
    );
  }
  const total = totalOk + totalBad;
  console.log(
    `\ntotal ${total} requests, ${((total / SECONDS) || 0).toFixed(1)} req/s, ` +
      `${totalBad} failures, overall p95 ${percentile(allLatencies, 95).toFixed(0)}ms`
  );

  // The invariant that matters most: only one of these stays can own the night.
  const race = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      app.inject({
        method: 'POST',
        url: '/api/bookings',
        headers: { cookie: user.cookie },
        payload: {
          propertyId: property.id,
          guestName: `Race ${i}`,
          channel: 'direct',
          checkIn: addDays(today, 40),
          checkOut: addDays(today, 42),
          guests: 2,
        },
      })
    )
  );
  const created = race.filter((r) => r.statusCode === 201).length;
  const conflicts = race.filter((r) => r.statusCode === 409).length;
  console.log(`overlap race: ${created} created, ${conflicts} refused (expected 1 / 7)`);
  const invariantHeld = created === 1 && conflicts === 7;
  console.log(invariantHeld ? 'STRESS PASSED' : 'STRESS FAILED: no-double-booking invariant broke');
  if (totalBad > 0 || !invariantHeld) process.exitCode = 1;
} finally {
  if (user) await deleteUser(user.email).catch(() => {});
  await app.close();
  await closePool();
}
