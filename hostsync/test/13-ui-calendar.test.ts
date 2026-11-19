/**
 * T-38 date navigation · T-42 a bar opens the booking sheet.
 *
 * Both are browser-level: the window is state, and a click has to move it by
 * exactly seven days and refetch — not merely re-render.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../src/db.ts';
import { addDays, todayUTC } from '../src/dates.ts';
import { createBooking, createProperty, deleteUser } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';
import { newUser, startUi } from './ui-helpers.ts';
import type { UiHarness } from './ui-helpers.ts';

let ui: UiHarness;
let user: ApiUser;

before(async () => {
  ui = await startUi();
  user = await newUser(ui.app);
});

after(async () => {
  await ui.close();
  await deleteUser(user.email);
  await closePool();
});

test('T-38 Next week moves the range by exactly seven days and refetches; Today comes back', async () => {
  const page = await ui.signedIn(user);
  const calendarCalls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/calendar')) calendarCalls.push(request.url());
  });

  await page.goto('/calendar', { waitUntil: 'domcontentloaded' });
  const grid = page.locator('[data-testid="calendar-grid"]');
  await grid.waitFor();

  const first = await grid.getAttribute('data-range-from');
  assert.ok(first, 'the grid exposes its window start');
  assert.equal(first, todayUTC());
  const labelBefore = (await page.locator('[data-testid="range-label"]').innerText()).trim();

  const callsBefore = calendarCalls.length;

  await page.getByRole('button', { name: 'Next week' }).click();
  const expected = addDays(first, 7);
  await page.waitForSelector(`[data-testid="calendar-grid"][data-range-from="${expected}"]`);

  const second = await grid.getAttribute('data-range-from');
  assert.equal(second, expected, 'exactly one week forward');
  assert.equal(
    calendarCalls.length > callsBefore,
    true,
    'a new calendar request was made, not a cached re-render'
  );
  // The grid attribute updates a tick before the label; wait for the label too.
  await page.waitForFunction(
    `(before) => document.querySelector('[data-testid="range-label"]')?.textContent?.trim() !== before`,
    labelBefore
  );
  const labelAfter = (await page.locator('[data-testid="range-label"]').innerText()).trim();
  assert.notEqual(labelAfter, labelBefore, 'the range label moved with the window');

  await page.getByRole('button', { name: 'Today' }).click();
  await page.waitForSelector(`[data-testid="calendar-grid"][data-range-from="${todayUTC()}"]`);
  assert.equal(await grid.getAttribute('data-range-from'), todayUTC());
});

test('T-42 clicking a booking bar opens the sheet for that exact booking', async () => {
  const today = todayUTC();
  const property = await createProperty(ui.app, user, { name: 'Sheet House' });
  const booking = await createBooking(ui.app, user, {
    propertyId: property.id,
    guestName: 'Sofia Almeida',
    channel: 'airbnb',
    checkIn: addDays(today, 2),
    checkOut: addDays(today, 5),
    guests: 2,
  });

  const page = await ui.signedIn(user);
  await page.goto('/calendar', { waitUntil: 'domcontentloaded' });

  const bar = page.locator(`[data-booking="${booking.id}"]`);
  await bar.waitFor({ state: 'visible' });
  await bar.click();

  const sheet = page.locator('[data-testid="booking-sheet"]');
  await sheet.waitFor({ state: 'visible' });

  assert.equal((await page.locator('[data-testid="sheet-reference"]').innerText()).trim(), booking.reference);
  assert.match(await sheet.innerText(), /Sofia Almeida/);
  // Sheet labels are styled uppercase, so match case-insensitively.
  assert.match(await sheet.innerText(), /net to owner/i);

  // Esc closes it, which is the a11y contract for a modal sheet.
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'detached' });
});
