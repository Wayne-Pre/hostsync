#!/usr/bin/env node
/**
 * Sync every workspace's calendar links once: npm run sync:calendars
 *
 * The server already does this on startup and every 30 minutes. This script is
 * for a manual catch-up (and can be called by an external scheduler).
 */
import { syncAllPortfolios } from '../src/ics/sync.ts';
import { closePool } from '../src/db.ts';

const started = Date.now();
const { portfolios, outcomes } = await syncAllPortfolios();
const failed = outcomes.filter((outcome) => outcome.status === 'failed');

console.log(
  `calendar sync: ${portfolios} portfolio(s), ${outcomes.length} feed(s), ` +
    `${failed.length} failed in ${Date.now() - started}ms`
);
for (const outcome of failed) {
  console.log(`  ${outcome.feedId}: ${outcome.error}`);
}

await closePool();
if (failed.length > 0) process.exitCode = 1;
