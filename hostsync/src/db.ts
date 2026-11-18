import pg from 'pg';

// bigint (int8) comes back as a string by default; every int8 column here is a cent
// amount or a sequence value, all comfortably inside Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(20, (value: string) => Number(value));

export const connectionString =
  process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/hostsync';

export const pool = new pg.Pool({
  connectionString,
  // Test files run in parallel processes; keep each pool small so the whole
  // suite stays well inside Postgres' max_connections — and so a memory-starved
  // Windows box does not have to fork a backend it cannot afford.
  max: Number(process.env.PG_POOL_MAX ?? 3),
});

/**
 * An idle client can be closed by the server (restart, max_connections, a
 * transient network drop). `pg` reports that on the pool, and an unhandled
 * 'error' event would take the whole process down — including a test run.
 */
pool.on('error', (error) => {
  console.error('[pg] idle client error:', error.message);
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const value = await fn(client);
    await client.query('commit');
    return value;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

export function isPostgresError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

/** 23P01 = exclusion_violation: the no_double_booking constraint fired. */
export const EXCLUSION_VIOLATION = '23P01';
