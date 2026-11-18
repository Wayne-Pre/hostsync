#!/usr/bin/env node
/**
 * The nightly reconciliation job: `npm run reconcile`.
 *
 * Reads every portfolio and compares bookings, ledger entries, statements and
 * settling accounts in integer cents. Prints one line per portfolio and exits
 * nonzero if any drift was found, so a scheduler can alert on it.
 */
import { closePool, query } from '../src/db.ts';
import { reconcilePortfolio } from '../src/reconcile.ts';

const portfolios = await query<{ id: string; name: string }>(
  'select id, name from portfolio order by name'
);

let drifting = 0;
for (const portfolio of portfolios) {
  const report = await reconcilePortfolio(portfolio.id);
  if (report.balanced) {
    console.log(
      `OK   ${portfolio.name}: ${report.checked.entries} entries, ` +
        `${report.checked.bookings} stays, ${report.checked.statements} statements — zero drift`
    );
  } else {
    drifting += 1;
    console.error(`DRIFT ${portfolio.name}:`);
    for (const row of report.drift) {
      console.error(
        `  ${row.kind} ${row.ref} (${row.detail}): ` +
          `expected ${row.expectedCents}, got ${row.actualCents}`
      );
    }
  }
}

await closePool();
if (drifting > 0) process.exit(1);
