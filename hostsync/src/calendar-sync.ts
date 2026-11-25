/**
 * Automatic calendar sync.
 *
 * A free web service sleeps when idle and starts a fresh process on the next
 * request, so the first pass runs at startup — every wake refreshes the stays —
 * and a timer keeps long sessions current. The work is idempotent: an unchanged
 * feed answers 304 and creates nothing.
 */
import { syncAllPortfolios } from './ics/sync.ts';

const INTERVAL_MS = Math.max(5, Number(process.env.CALENDAR_SYNC_MINUTES ?? 30)) * 60_000;

let inFlight = false;
let timer: ReturnType<typeof setInterval> | null = null;

export async function runCalendarSync(
  log: (message: string) => void = (message) => console.log(message)
): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  const started = Date.now();
  try {
    const { portfolios, outcomes } = await syncAllPortfolios();
    const failed = outcomes.filter((outcome) => outcome.status === 'failed').length;
    log(
      `calendar sync: ${portfolios} portfolio(s), ${outcomes.length} feed(s), ` +
        `${failed} failed in ${Date.now() - started}ms`
    );
  } catch (error) {
    log(`calendar sync failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    inFlight = false;
  }
}

export function startCalendarSync(
  log: (message: string) => void = (message) => console.log(message)
): () => void {
  void runCalendarSync(log);
  timer = setInterval(() => void runCalendarSync(log), INTERVAL_MS);
  timer.unref?.();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}
