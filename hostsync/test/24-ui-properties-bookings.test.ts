/**
 * T-21…T-35 in the browser: the properties cards and the booking ledger.
 *
 * These screens are the last unit of Stage 1. The endpoints behind them were
 * already proven by T-21…T-36; what is asserted here is that the screen shows
 * the server's numbers, and that the actions on screen reach the server.
 *
 * One Chrome launch for the whole file: on this box a browser costs more than
 * every assertion in it.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { closePool } from '../src/db.ts';
import { addDays, todayUTC } from '../src/dates.ts';
import { money, moneyCompact } from '../web/client.ts';
import { createBooking, createProperty, deleteUser } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';
import { newUser, startUi } from './ui-helpers.ts';
import type { UiHarness } from './ui-helpers.ts';

let ui: UiHarness;
let user: ApiUser;
let propertyId: string;
let confirmedId: string;
let pendingId: string;

const TODAY = todayUTC();
const RATE = 1_000_000;

function card(page: Page, id: string) {
  return page.locator(`[data-property="${id}"]`);
}

before(async () => {
  ui = await startUi();
  user = await newUser(ui.app);

  const property = await createProperty(ui.app, user, {
    name: 'Karen Cottage',
    status: 'live',
    neighbourhood: 'Karen',
    city: 'Nairobi',
    bedrooms: 2,
    baths: 2,
    guests: 4,
    nightlyRateCents: RATE,
    cleaningFeeCents: 0,
    managementFeePercent: 15,
    ownerName: 'David Mwangi',
    channels: ['airbnb'],
  });
  propertyId = property.id;

  const confirmed = await createBooking(ui.app, user, {
    propertyId,
    guestName: 'Amara Osei',
    channel: 'direct',
    checkIn: TODAY,
    checkOut: addDays(TODAY, 2),
    guests: 2,
  });
  confirmedId = confirmed.id;
  const confirm = await ui.app.inject({
    method: 'POST',
    url: `/api/bookings/${confirmedId}/confirm`,
    headers: { cookie: user.cookie },
    payload: {},
  });
  assert.equal(confirm.statusCode, 200, confirm.body);

  const pending = await createBooking(ui.app, user, {
    propertyId,
    guestName: 'Bram de Vries',
    channel: 'airbnb',
    status: 'pending',
    checkIn: addDays(TODAY, 10),
    checkOut: addDays(TODAY, 12),
    guests: 2,
  });
  pendingId = pending.id;
});

after(async () => {
  await ui.close();
  await deleteUser(user.email);
  await closePool();
});

test('T-21/T-22/T-23/T-24/T-27 the card, the form, the status and the account', async () => {
  const page = await ui.signedIn(user);
  await page.goto('/properties');
  await page.waitForSelector('[data-testid="property-cards"]');

  const cottage = card(page, propertyId);
  const text = await cottage.innerText();
  assert.match(text, /Karen Cottage/);
  assert.match(text, /Karen · Nairobi/);
  assert.match(text, /2 beds · 2 baths · sleeps 4/);
  assert.ok(text.includes(money(RATE)), `the nightly rate is on the card: ${text}`);
  assert.ok(text.includes('David Mwangi'), 'the owner is on the card');
  // The badge is the channel the stay came through (T-21 proves that rule).
  assert.match(text, /DIRECT/i, 'the channel of the stay is a badge');
  assert.match(await cottage.locator('.status').innerText(), /live/i);

  // F-24 — live ⇄ onboarding, and the badge follows.
  await cottage.getByRole('button', { name: 'Move to onboarding' }).click();
  await page
    .locator(`[data-property="${propertyId}"] .status`, { hasText: 'Onboarding' })
    .waitFor();
  const afterToggle = await ui.app.inject({
    method: 'GET',
    url: `/api/properties/${propertyId}`,
    headers: { cookie: user.cookie },
  });
  assert.equal((afterToggle.json() as { property: { status: string } }).property.status, 'onboarding');

  // F-23 — the edit form is pre-filled and saves through the API.
  await card(page, propertyId).getByRole('button', { name: 'Edit' }).click();
  assert.equal(await page.locator('#p-name').inputValue(), 'Karen Cottage');
  await page.locator('#p-name').fill('Karen Cottage Renamed');
  await page.getByRole('button', { name: 'Save changes' }).click();
  // The previous action's toast may still be on screen, so wait for this text.
  await page
    .locator('[data-testid="toast"][data-visible="true"]', { hasText: /Changes saved/i })
    .waitFor();
  assert.match(await page.locator('[data-testid="toast"]').innerText(), /Changes saved/i);
  await page.locator(`[data-property="${propertyId}"] h3`, { hasText: 'Karen Cottage Renamed' }).waitFor();

  // F-22 — a new property is added from the same form and appears as a card.
  await page.getByRole('button', { name: 'Add property', exact: true }).first().click();
  await page.locator('#p-name').fill('Nyali Beach House');
  await page.locator('#p-area').fill('Nyali');
  await page.locator('#p-city').fill('Mombasa');
  await page.locator('#p-rate').fill('25000');
  await page.locator('#p-owner').fill('Grace Achieng');
  await page.getByRole('button', { name: 'Add property', exact: true }).last().click();
  await page.locator('[data-property] h3', { hasText: 'Nyali Beach House' }).waitFor();

  // F-27 — the settling account is read from the property account, not guessed.
  const account = await ui.app.inject({
    method: 'PUT',
    url: `/api/properties/${propertyId}/account`,
    headers: { cookie: user.cookie },
    payload: { label: 'KCB 3310', verified: false, balanceCents: 250_000 },
  });
  assert.equal(account.statusCode, 200, account.body);
  await page.reload();
  await page.waitForSelector('[data-testid="property-cards"]');
  const accountText = await card(page, propertyId).locator('.prop-account').innerText();
  assert.match(accountText, /KCB 3310 · pending/);
  assert.ok(accountText.includes(money(250_000)), `the balance is shown: ${accountText}`);
});

test('T-25 the calendar link panel saves a feed and its source on the property', async () => {
  const page = await ui.signedIn(user);
  await page.goto('/properties');
  await page.waitForSelector('[data-testid="property-cards"]');

  await card(page, propertyId).getByRole('button', { name: 'Calendar link' }).click();
  await page.waitForSelector('#feed-url');

  const url = 'https://www.airbnb.com/calendar/ical/123456.ics?s=abc';
  await page.locator('#feed-url').fill(url);
  await page.locator('#feed-source').selectOption('airbnb');
  await page.getByRole('button', { name: 'Save link' }).click();

  await page.waitForSelector('[data-testid="toast"][data-visible="true"]');
  assert.match(await page.locator('[data-testid="toast"]').innerText(), /saved on the property/i);

  const feeds = await ui.app.inject({
    method: 'GET',
    url: `/api/properties/${propertyId}/calendar-feeds`,
    headers: { cookie: user.cookie },
  });
  assert.equal(feeds.statusCode, 200, feeds.body);
  const stored = (feeds.json() as { feeds: Array<{ url: string; source: string }> }).feeds;
  assert.equal(stored[0]?.url, url);
  assert.equal(stored[0]?.source, 'airbnb');
});

test('T-28/T-29/T-30/T-31 the ledger, the counters, the search and the filters', async () => {
  const page = await ui.signedIn(user);
  await page.goto('/bookings');
  await page.waitForSelector('[data-testid="ledger"] tbody tr');

  // F-28 — one row per stay, with the reference the server minted.
  const confirmedRow = page.locator(`[data-booking="${confirmedId}"]`);
  const rowText = await confirmedRow.innerText();
  assert.match(rowText, /Amara Osei/);
  assert.match(rowText, /Karen Cottage Renamed/);
  assert.ok(rowText.includes(money(2 * RATE)), 'the net is on the row');

  // F-29 — the three counters are the server's own summary.
  assert.equal((await page.locator('[data-kpi="in-house"] .kpi-value').innerText()).trim(), '1');
  assert.equal((await page.locator('[data-kpi="arriving"] .kpi-value').innerText()).trim(), '1');
  assert.equal(
    (await page.locator('[data-kpi="net-booked"] .kpi-value').innerText()).trim(),
    moneyCompact(2 * RATE)
  );

  // F-30 — search narrows to the guest that matches, and only them.
  await page.locator('#ledger-search').fill('Amara');
  await page.locator(`[data-booking="${pendingId}"]`).waitFor({ state: 'detached' });
  assert.equal(
    await page.locator('[data-testid="ledger"] tbody tr').count(),
    1,
    'the unmatched stay is gone'
  );

  await page.locator('#ledger-search').fill('');
  await page.locator(`[data-booking="${pendingId}"]`).waitFor({ state: 'visible' });

  // F-31 — channel filters to its own rows.
  await page.locator('#ledger-channel').selectOption('airbnb');
  await page.locator(`[data-booking="${confirmedId}"]`).waitFor({ state: 'detached' });
  assert.equal(await page.locator(`[data-booking="${pendingId}"]`).count(), 1);

  await page.locator('#ledger-channel').selectOption('');
  await page.locator('#ledger-status').selectOption('confirmed');
  await page.locator(`[data-booking="${pendingId}"]`).waitFor({ state: 'detached' });
  assert.equal(await page.locator(`[data-booking="${confirmedId}"]`).count(), 1);
});

test('T-32/T-33/T-34/T-35 the sheet confirms, cancels, and a new booking prices itself', async () => {
  const page = await ui.signedIn(user);
  await page.goto('/bookings');
  await page.waitForSelector('[data-testid="ledger"] tbody tr');

  // F-32 — the sheet holds the arithmetic the database holds.
  await page.locator(`[data-booking="${confirmedId}"]`).click();
  const sheet = page.locator('[data-testid="booking-sheet"]');
  await sheet.waitFor({ state: 'visible' });
  const sheetText = await sheet.innerText();
  assert.ok(sheetText.includes(money(2 * RATE)), 'gross and net are both on the sheet');
  assert.match(sheetText, /2 guests · 2 nights/);
  assert.match(sheetText, /from 15:00/);
  assert.match(sheetText, /by 11:00/);
  await page.getByRole('button', { name: 'Close' }).click();
  await sheet.waitFor({ state: 'hidden' });

  // F-33 — a pending stay is confirmed from its sheet.
  await page.locator(`[data-booking="${pendingId}"]`).click();
  await sheet.waitFor({ state: 'visible' });
  await sheet.getByRole('button', { name: 'Confirm stay' }).click();
  await page.locator(`[data-booking="${pendingId}"][data-status="confirmed"]`).waitFor();

  // F-34 — cancelling releases the nights, and the row says so.
  await page.locator(`[data-booking="${pendingId}"]`).click();
  await sheet.waitFor({ state: 'visible' });
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator(`[data-booking="${pendingId}"][data-status="cancelled"]`).waitFor();

  // F-35 — the live price is the server's, and saving the form books the stay.
  await page.locator('#b-property').selectOption(propertyId);
  await page.locator('#b-guest').fill('Cleo Njoroge');
  await page.locator('#b-channel').selectOption('direct');
  await page.locator('#b-in').fill(addDays(TODAY, 20));
  await page.locator('#b-out').fill(addDays(TODAY, 23));
  await page.locator('#b-guests').fill('2');

  await page.waitForSelector('[data-testid="quote"]');
  const quote = await page.locator('[data-testid="quote"]').innerText();
  assert.match(quote, /3 nights/);
  assert.ok(quote.includes(money(3 * RATE)), `the quote totals three nights: ${quote}`);
  assert.match(quote, /Net to owner/i);

  await page.getByRole('button', { name: 'Save booking' }).click();
  await page
    .locator('[data-testid="ledger"] tbody tr', { hasText: 'Cleo Njoroge' })
    .waitFor();
});
