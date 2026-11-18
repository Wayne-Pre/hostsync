import { pool, queryOne } from '../src/db.ts';
import type { Property } from '../src/properties.ts';
import { createProperty } from '../src/properties.ts';
import type { CreatePropertyInput } from '../src/properties.ts';

export interface Fixture {
  portfolioId: string;
  property: Property;
  cleanup: () => Promise<void>;
}

export async function createPortfolio(name = 'TEST'): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into portfolio (name) values ($1) returning id`,
    [name]
  );
  if (!row) throw new Error('could not create portfolio');
  return row.id;
}

export function propertyInput(
  portfolioId: string,
  overrides: Partial<CreatePropertyInput> = {}
): CreatePropertyInput {
  return {
    portfolioId,
    name: 'Karen Cottage',
    status: 'live',
    type: 'cottage',
    neighbourhood: 'Karen',
    city: 'Nairobi',
    bedrooms: 2,
    baths: 2,
    guests: 4,
    nightlyRateCents: 1_500_000, // KES 15,000
    cleaningFeeCents: 300_000, // KES 3,000
    managementFeeBps: 1500,
    ownerName: 'David Mwangi',
    ownerEmail: 'd.mwangi@outlook.com',
    ...overrides,
  };
}

export async function seedProperty(
  portfolioId: string,
  overrides: Partial<CreatePropertyInput> = {}
): Promise<Property> {
  return createProperty(propertyInput(portfolioId, overrides));
}

export async function withFixture(
  overrides: Partial<CreatePropertyInput> = {}
): Promise<Fixture> {
  const portfolioId = await createPortfolio();
  const property = await seedProperty(portfolioId, overrides);
  return {
    portfolioId,
    property,
    cleanup: async () => {
      await pool.query(
        `delete from booking where property_id in (select id from property where portfolio_id = $1)`,
        [portfolioId]
      );
      await pool.query('delete from property where portfolio_id = $1', [portfolioId]);
      await pool.query('delete from portfolio where id = $1', [portfolioId]);
    },
  };
}

export async function expectRejection(
  fn: () => Promise<unknown>
): Promise<{ message: string; name: string; status?: number }> {
  try {
    await fn();
  } catch (error) {
    const err = error as { message?: string; name?: string; status?: number };
    return { message: err.message ?? '', name: err.name ?? '', status: err.status };
  }
  throw new Error('expected the call to reject, but it resolved');
}
