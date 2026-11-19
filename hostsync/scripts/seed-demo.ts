#!/usr/bin/env node
/**
 * Rebuild the marketing demo account from scratch: npm run seed:demo
 *
 * Uses DATABASE_URL, so it works locally against the dev database and in the
 * Render Shell against production. Everything is inserted through Postgres;
 * no email is sent. Re-running deletes and recreates the demo portfolio.
 */
import { query, queryOne, withTransaction, closePool } from '../src/db.ts';
import { hashPassword } from '../src/auth/passwords.ts';
import { addDays, todayUTC } from '../src/dates.ts';

const EMAIL = 'demo@hostsync.app';
const PASSWORD = 'Demo12345!';
const COMMISSION = { airbnb: 1500, booking_com: 1500, vrbo: 800, direct: 0, whatsapp: 0 };
const CHANNELS = ['airbnb', 'booking_com', 'vrbo', 'direct', 'whatsapp'];
const CATEGORY_LABELS = {
  housekeeping: 'HOUSEKEEPING',
  maintenance: 'MAINTENANCE',
  consumables: 'CONSUMABLES',
  utilities: 'UTILITIES',
};
const TURNOVER_ITEMS = [
  'Strip beds and collect linen',
  'Clean kitchen and bathrooms',
  'Check inventory and consumables',
  'Test locks and report damage',
  'Mark the property ready',
];

type Channel = keyof typeof COMMISSION;
type Category = keyof typeof CATEGORY_LABELS;
type PropertySpec = [string, string, string, string, number, number, number, number, number, number, string];

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-KE', { maximumFractionDigits: 0 });
}

async function main() {
  const passwordHash = await hashPassword(PASSWORD);
  const summary = await withTransaction(async (client) => {
    await client.query("set local hostsync.ledger_purge = 'on'");
    const existing = await client.query('select id from app_user where lower(email) = lower($1)', [EMAIL]);
    if (existing.rows[0]) {
      const oldId = existing.rows[0].id;
      // booking.property_id has no cascade, so clear stays before the owner.
      await client.query(
        `delete from booking where property_id in (
           select id from property where portfolio_id in (
             select id from portfolio where owner_id = $1
           )
         )`,
        [oldId]
      );
      await client.query('delete from app_user where id = $1', [oldId]);
    }

    const userRow = await client.query(
      `insert into app_user (email, password_hash, display_name, is_verified, onboarding_complete)
       values ($1, $2, 'Demo Owner', true, true) returning id`,
      [EMAIL, passwordHash]
    );
    const userId = userRow.rows[0].id;

    const portfolioRow = await client.query(
      `insert into portfolio (name, currency, default_management_fee_bps, owner_id, timezone, business_name, business_phone)
       values ('HostSync Demo', 'KES', 1800, $1, 'Africa/Nairobi', 'HostSync Demo', '+254 700 000 000')
       returning id`,
      [userId]
    );
    const portfolioId = portfolioRow.rows[0].id;

    for (const channel of CHANNELS) {
      await client.query(
        `insert into channel_connection (portfolio_id, channel, connected, business_number, account_ref)
         values ($1, $2, true, $3, $4)
         on conflict (portfolio_id, channel) do update set connected = true`,
        [portfolioId, channel, channel === 'whatsapp' ? '+254 700 000 001' : null, `${channel}-demo`]
      );
    }

    const people = [
      ['Mercy Wanjiru', 'manager', '+254 701 000 001', 120_000, 98, true],
      ['Otieno Kefa', 'cleaner', '+254 701 000 002', 45_000, 95, true],
      ['Faith Muthoni', 'cleaner', '+254 701 000 003', 45_000, 91, false],
      ['Amina Yusuf', 'front_desk', '+254 701 000 004', 60_000, 97, true],
    ];
    for (const [name, role, phone, rate, reliability, active] of people) {
      await client.query(
        `insert into team_member (portfolio_id, name, role, phone, hourly_rate_cents, reliability_pct, active)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [portfolioId, name, role, phone, rate, reliability, active]
      );
    }

    const propertySpecs: PropertySpec[] = [
      ['Karen Cottage', 'cottage', 'Karen', 'Nairobi', 2, 2, 4, 1_500_000, 300_000, 1500, 'David Mwangi'],
      ['Kilimani Loft', 'apartment', 'Kilimani', 'Nairobi', 1, 1, 2, 1_200_000, 200_000, 1800, 'Grace Njoroge'],
      ['Nyali Beach House', 'house', 'Nyali', 'Mombasa', 4, 3, 8, 3_200_000, 600_000, 1500, 'Peter Ochieng'],
      ['Westlands Penthouse', 'penthouse', 'Westlands', 'Nairobi', 3, 2, 6, 2_400_000, 400_000, 2000, 'Lydia Kamau'],
      ['Riverside Studio', 'studio', 'Riverside', 'Nairobi', 1, 1, 2, 900_000, 150_000, 1500, 'David Mwangi'],
      ['Safari View Villa', 'villa', 'Lavington', 'Nairobi', 5, 4, 10, 4_500_000, 800_000, 2500, 'Grace Njoroge'],
    ];

    const today = todayUTC();
    let bookingCount = 0;
    let revenue = 0;
    let expenses = 0;
    const propertyIds = [];

    for (const [index, spec] of propertySpecs.entries()) {
      const [name, type, area, city, beds, baths, guests, rate, cleaning, feeBps, owner] = spec;
      const p = await client.query(
        `insert into property (
           portfolio_id, name, status, type, neighbourhood, city, address,
           bedrooms, baths, guests, nightly_rate_cents, cleaning_fee_cents,
           management_fee_bps, owner_name, owner_email, currency, timezone,
           checkin_time, checkout_time
         ) values (
           $1, $2, 'live', $3, $4, $5, $6,
           $7, $8, $9, $10, $11, $12, $13, $14, 'KES', 'Africa/Nairobi',
           '15:00', '11:00'
         ) returning id`,
        [portfolioId, name, type, area, city, `${area}, ${city}`, beds, baths, guests,
          rate, cleaning, feeBps, owner, `owner${index + 1}@example.test`]
      );
      const propertyId = p.rows[0].id;
      propertyIds.push(propertyId);

      await client.query(
        `insert into property_account (property_id, label, verified, opening_balance_cents, balance_cents)
         values ($1, $2, true, $3, $3)`,
        [propertyId, ['KCB 3310', 'Equity 7781', 'Co-op 5520', 'Stanbic 1199', 'KCB 8842', 'Equity 4401'][index],
          (index + 1) * 250_000]
      );

      // Six non-overlapping stays per property: four historical, two upcoming.
      const offsets = [-150, -120, -75, -35, 1, 18];
      const guestNames: Array<[string, Channel]> = [
        ['Sofia Alvarez', 'airbnb'], ['Brian Otieno', 'booking_com'], ['Nina Patel', 'vrbo'],
        ['Tomas Weber', 'direct'], ['Aisha Mohamed', 'airbnb'], ['James Kimani', 'booking_com'],
      ];
      for (const [j, offset] of offsets.entries()) {
        const start = addDays(today, offset + index);
        const nights = 3 + (j % 3);
        const [guest, channel] = guestNames[j]!;
        const gross = nights * rate + cleaning;
        const bps = COMMISSION[channel];
        const commission = Math.round((gross * bps) / 10_000);
        const net = gross - commission;
        const status = offset < 0 ? 'completed' : 'confirmed';
        const paid = offset < 0 || j === 4;
        const ref = `HS-${9000 + index * 10 + j}`;

        const b = await client.query(
          `insert into booking (
             property_id, reference, guest_name, guest_email, guest_phone, channel,
             stay, guests, gross_cents, commission_bps, net_cents, rate_version,
             payment_status, status, source
           ) values (
             $1, $2, $3, $4, $5, $6,
             daterange($7::date, $7::date + $8::int, '[)'), $9,
             $10, $11, $12, 1, $13, $14, $15
           ) returning id`,
          [propertyId, ref, guest, `guest${index}${j}@example.test`, '+254 700 000 000',
            channel, start, nights, 2 + (j % 3), gross, bps, net,
            paid ? 'paid' : 'unpaid', status, channel === 'direct' ? 'manual' : 'import']
        );
        bookingCount += 1;
        if (paid) {
          revenue += gross;
          await client.query(
            `insert into transaction (portfolio_id, property_id, booking_id, account_id, kind, category,
               amount_cents, description, posted, occurred_on)
             values ($1, $2, $3, $2, 'credit', 'booking_revenue', $4, $5, true, $6::date)`,
            [portfolioId, propertyId, b.rows[0].id, gross, `Stay ${ref} — ${guest}`, start]
          );
          await client.query(
            'update property_account set balance_cents = balance_cents + $2 where property_id = $1',
            [propertyId, gross]
          );
        }

        if (offset > 0) {
          const t = await client.query(
            `insert into task (property_id, booking_id, kind, title, window_start, window_end, status, assignee, expected_cost_cents)
             select $1, $2, 'turnover', $3,
                    ($4::date + p.checkout_time) at time zone p.timezone,
                    ($4::date + p.checkin_time) at time zone p.timezone,
                    'scheduled', $5, 350000
               from property p where p.id = $1
             returning id`,
            [propertyId, b.rows[0].id, `Turnover — ${guest}`, start,
              ['Otieno Kefa', 'Faith Muthoni', null][j % 3]]
          );
          for (const [position, label] of TURNOVER_ITEMS.entries()) {
            await client.query(
              'insert into task_checklist_item (task_id, position, label) values ($1, $2, $3)',
              [t.rows[0].id, position + 1, label]
            );
          }
        }
      }

      // A few operating expenses so the ledger is two-sided.
      for (const [category, amount, daysAgo] of [
        ['housekeeping', 24_000, 8], ['maintenance', 48_000, 21], ['utilities', 31_500, 40],
        ['consumables', 12_800, 55],
      ] as Array<[Category, number, number]>) {
        const date = addDays(today, -daysAgo - index);
        await client.query(
          `insert into transaction (portfolio_id, property_id, account_id, kind, category,
             amount_cents, description, posted, occurred_on)
           values ($1, $2, $2, 'debit', $3, -($4::bigint), $5, true, $6::date)`,
          [portfolioId, propertyId, category, amount,
            `${CATEGORY_LABELS[category]} — ${name}`, date]
        );
        expenses += amount;
        await client.query(
          'update property_account set balance_cents = balance_cents - $2 where property_id = $1',
          [propertyId, amount]
        );
      }
    }

    // Review history: 5 stars for most, one honest 3-star with a reply.
    const ratings = [5, 5, 4, 5, 3, 5, 4, 5];
    for (const [i, rating] of ratings.entries()) {
      await client.query(
        `insert into review (property_id, rating, channel, guest_name, body, received_at, responded_at)
         values ($1, $2, $3, $4, $5, now() - ($6::text || ' days')::interval, $7)`,
        [propertyIds[i % propertyIds.length], rating, CHANNELS[i % CHANNELS.length],
          ['Amara Osei', 'Peter Njoroge', 'Lena Fischer', 'Sam Okoro', 'Grace Wambui'][i % 5],
          rating === 5 ? 'Spotless place, seamless check-in.' : 'Great stay; the water heater needed attention.',
          3 + i * 4,
          rating === 3 ? null : nowSql()]
      );
    }

    // Three guest threads with honest delivery states.
    const threads = [
      ['Amara Osei', 'airbnb', 'amara@example.test', 'Is early check-in possible?', 'email', 'sent'],
      ['Brian Otieno', 'whatsapp', null, 'We arrived safely, thank you.', 'whatsapp', 'recorded'],
      ['Nina Patel', 'booking_com', 'nina@example.test', 'Could you send the gate code again?', 'email', 'sent'],
    ];
    for (const [i, [guest, channel, email, body, replyChannel, delivery]] of threads.entries()) {
      const c = await client.query(
        `insert into conversation (portfolio_id, property_id, guest_name, guest_email, channel, subject,
           unread_count, last_message_at)
         values ($1, $2, $3, $4, $5, 'Your stay', $6, now() - ($7::text || ' hours')::interval)
         returning id`,
        [portfolioId, propertyIds[i], guest, email, channel, i === 2 ? 1 : 0, 2 + i * 6]
      );
      const conversationId = c.rows[0].id;
      await client.query(
        `insert into message (conversation_id, direction, author_name, body, channel, delivery, created_at)
         values ($1, 'inbound', $2, $3, $4, 'sent', now() - ($5::text || ' hours')::interval)`,
        [conversationId, guest, body, channel, 3 + i * 6]
      );
      await client.query(
        `insert into message (conversation_id, direction, author_name, body, channel, delivery, created_at)
         values ($1, 'outbound', 'Demo Owner', $2, $3, $4, now() - ($5::text || ' hours')::interval)`,
        [conversationId, 'Thanks — we have you sorted.', replyChannel, delivery, 1 + i * 6]
      );
    }

    // One backdated fee override with a real history, and statements that reconcile.
    await client.query(
      `insert into fee_override (property_id, effective_from, fee_bps)
       values ($1, (date_trunc('month', current_date) - interval '1 month')::date, 1500)
       on conflict do nothing`,
      [propertyIds[0]]
    );

    const [year, month] = today.split('-').map(Number);
    const periodStart = new Date(Date.UTC(year!, month! - 1, 1)).toISOString().slice(0, 10);
    const periodEnd = new Date(Date.UTC(year!, month!, 1)).toISOString().slice(0, 10);
    let statements = 0;
    for (const [i, propertyId] of propertyIds.slice(0, 3).entries()) {
      const totals = await client.query(
        `select
           coalesce(sum(case when category = 'booking_revenue' then amount_cents else 0 end), 0)::bigint as gross,
           coalesce(sum(case when category <> 'booking_revenue' then -amount_cents else 0 end), 0)::bigint as costs
           from transaction
          where property_id = $1 and occurred_on >= $2::date and occurred_on < $3::date`,
        [propertyId, periodStart, periodEnd]
      );
      const gross = Number(totals.rows[0].gross);
      const costs = Number(totals.rows[0].costs);
      const bps = 1500 + i * 100;
      const fee = Math.round((gross * bps) / 10_000);
      const net = gross - costs - fee;
      await client.query(
        `insert into statement (portfolio_id, property_id, owner_name, period_start, period_end,
           gross_cents, expenses_cents, fee_bps, fee_cents, net_cents, status)
         values ($1, $2, 'Demo Owner', $3::date, $4::date, $5, $6, $7, $8, $9, $10)
         on conflict (property_id, period_start, period_end) do nothing`,
        [portfolioId, propertyId, periodStart, periodEnd, gross, costs, bps, fee, net,
          i === 0 ? 'approved' : 'draft']
      );
      statements += 1;
    }

    return { userId, portfolioId, properties: propertyIds.length, bookings: bookingCount,
      revenue, expenses, statements };
  });

  console.log(`Demo account ready: ${EMAIL} / ${PASSWORD}`);
  console.log(`  ${summary.properties} properties, ${summary.bookings} stays, ` +
    `${summary.statements} statements, revenue ${money(summary.revenue)}, expenses ${money(summary.expenses)}`);
}

function nowSql() {
  return new Date().toISOString();
}

main().then(() => closePool()).catch(async (error) => {
  console.error(error);
  await closePool();
  process.exit(1);
});
