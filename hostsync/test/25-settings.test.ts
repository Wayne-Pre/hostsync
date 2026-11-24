/**
 * T-73 portfolio details · T-74 review automation · T-75 channel states.
 *
 * The last three features of Stage 3. Each is a small settings contract, so
 * every assertion reads the value back from the server rather than trusting
 * the PATCH response alone.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { closePool } from '../src/db.ts';
import { createCaptureTransport } from '../src/mail.ts';
import { createBooking, createProperty, deleteUser, signUp } from './api-helpers.ts';
import { addDays, todayUTC } from '../src/dates.ts';
import type { ApiUser } from './api-helpers.ts';

const mailer = createCaptureTransport();
let app: FastifyInstance;
let user: ApiUser;

interface Settings {
  name: string;
  currency: string;
  timezone: string;
  defaultManagementFeeBps: number;
  businessName: string | null;
  businessPhone: string | null;
}

async function get<T>(url: string): Promise<T> {
  const response = await app.inject({ method: 'GET', url, headers: { cookie: user.cookie } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as T;
}

async function send<T>(
  method: 'PATCH' | 'POST' | 'PUT',
  url: string,
  payload: Record<string, unknown>,
  expected = 200
): Promise<T> {
  const response = await app.inject({
    method,
    url,
    headers: { cookie: user.cookie },
    payload,
  });
  assert.equal(response.statusCode, expected, response.body);
  return response.json() as T;
}

before(async () => {
  app = buildApp({ mailer });
  await app.ready();
  user = await signUp(app, mailer, 'SETTINGS');
});

after(async () => {
  await app.close();
  await deleteUser(user.email);
  await closePool();
});

test('T-73 the portfolio details round-trip, and 150 % is refused', async () => {
  const initial = await get<{ settings: Settings }>('/api/portfolio/settings');
  assert.equal(initial.settings.name, 'SETTINGS');
  assert.equal(initial.settings.currency, 'KES');
  assert.equal(initial.settings.defaultManagementFeeBps, 1800, 'the default fee is 18 %');
  assert.equal(initial.settings.businessName, null);

  await send<{ settings: Settings }>('PATCH', '/api/portfolio/settings', {
    name: '  Mwangi Stays  ',
    currency: 'usd',
    timezone: 'Africa/Nairobi',
    managementFeePercent: 12.5,
    businessName: 'Mwangi Hospitality',
    businessPhone: '+254 700 000 000',
  });

  const reread = await get<{ settings: Settings }>('/api/portfolio/settings');
  assert.equal(reread.settings.name, 'Mwangi Stays', 'the name is trimmed');
  assert.equal(reread.settings.currency, 'USD', 'the currency is upper-cased');
  assert.equal(reread.settings.timezone, 'Africa/Nairobi');
  assert.equal(reread.settings.defaultManagementFeeBps, 1250, '12.5 % becomes 1 250 bps');
  assert.equal(reread.settings.businessName, 'Mwangi Hospitality');
  assert.equal(reread.settings.businessPhone, '+254 700 000 000');

  // A fee outside 0–100 is a form error with a field to highlight.
  const tooBig = await app.inject({
    method: 'PATCH',
    url: '/api/portfolio/settings',
    headers: { cookie: user.cookie },
    payload: { managementFeePercent: 150 },
  });
  assert.equal(tooBig.statusCode, 422, tooBig.body);
  assert.equal((tooBig.json() as { field: string }).field, 'managementFeePercent');

  const blank = await app.inject({
    method: 'PATCH',
    url: '/api/portfolio/settings',
    headers: { cookie: user.cookie },
    payload: { name: '   ' },
  });
  assert.equal(blank.statusCode, 422, blank.body);

  // The refused writes changed nothing.
  const untouched = await get<{ settings: Settings }>('/api/portfolio/settings');
  assert.equal(untouched.settings.defaultManagementFeeBps, 1250);
  assert.equal(untouched.settings.name, 'Mwangi Stays');
});

test('T-74 the review automation switch and delay are stored, and 31 days is refused', async () => {
  const initial = await get<{ settings: { autoRequest: boolean; daysAfterCheckout: number } }>(
    '/api/reviews'
  );
  assert.equal(initial.settings.autoRequest, false);
  assert.equal(initial.settings.daysAfterCheckout, 1);

  await send('PUT', '/api/reviews/settings', { autoRequest: true, daysAfterCheckout: 3 });

  const on = await get<{ settings: { autoRequest: boolean; daysAfterCheckout: number } }>(
    '/api/reviews'
  );
  assert.equal(on.settings.autoRequest, true);
  assert.equal(on.settings.daysAfterCheckout, 3);

  await send('PUT', '/api/reviews/settings', { autoRequest: false, daysAfterCheckout: 0 });
  const off = await get<{ settings: { autoRequest: boolean; daysAfterCheckout: number } }>(
    '/api/reviews'
  );
  assert.equal(off.settings.autoRequest, false);
  assert.equal(off.settings.daysAfterCheckout, 0, 'asking on the checkout day is allowed');

  const outside = await app.inject({
    method: 'PUT',
    url: '/api/reviews/settings',
    headers: { cookie: user.cookie },
    payload: { autoRequest: true, daysAfterCheckout: 31 },
  });
  assert.equal(outside.statusCode, 422, outside.body);
  assert.equal((outside.json() as { field: string }).field, 'daysAfterCheckout');
});

test('T-75 channel indicators turn on only when real setup exists', async () => {
  type Channels = { channels: Array<{ channel: string; label: string; connected: boolean }> };
  const read = () => get<Channels>('/api/channels');
  const isOn = (data: Channels, channel: string) =>
    data.channels.find((entry) => entry.channel === channel)?.connected;

  const initial = await read();
  assert.deepEqual(
    initial.channels.map((entry) => entry.channel),
    ['airbnb', 'booking_com', 'vrbo', 'direct', 'whatsapp'],
    'all five channels are listed in the product order'
  );
  assert.equal(initial.channels.every((entry) => entry.connected === false), true);
  assert.equal(initial.channels[1]?.label, 'Booking.com');

  const property = await createProperty(app, user, { name: 'Channel House' });

  // A click cannot fake a connection any more.
  await send('POST', '/api/channels/airbnb', { connected: true, businessNumber: null });
  assert.equal(isOn(await read(), 'airbnb'), false, 'the old flag cannot connect Airbnb');

  // A calendar link with that source can.
  await send('PUT', `/api/properties/${property.id}/calendar-feed`, {
    url: 'https://example.com/airbnb.ics',
    source: 'airbnb',
  });
  const afterFeed = await read();
  assert.equal(isOn(afterFeed, 'airbnb'), true, 'a real calendar link connects Airbnb');
  assert.equal(isOn(afterFeed, 'vrbo'), false, 'the other channels stay off');

  // A manual stay is what "Direct" actually means.
  await createBooking(app, user, {
    propertyId: property.id,
    guestName: 'Sofia Alvarez',
    channel: 'direct',
    checkIn: addDays(todayUTC(), 4),
    checkOut: addDays(todayUTC(), 7),
    guests: 2,
  });
  assert.equal(isOn(await read(), 'direct'), true, 'a manual stay connects Direct');

  // WhatsApp is a business line or it is nothing.
  const refused = await app.inject({
    method: 'POST',
    url: '/api/channels/whatsapp',
    headers: { cookie: user.cookie },
    payload: { connected: true, businessNumber: null },
  });
  assert.equal(refused.statusCode, 422, refused.body);
  assert.equal((refused.json() as { field: string }).field, 'businessNumber');

  const connected = await send<{ channel: { connected: boolean; businessNumber: string } }>(
    'POST',
    '/api/channels/whatsapp',
    { connected: true, businessNumber: '+254 711 222 333' }
  );
  assert.equal(connected.channel.connected, true);
  assert.equal(connected.channel.businessNumber, '+254 711 222 333');
  assert.equal(isOn(await read(), 'whatsapp'), true, 'a saved business number connects WhatsApp');

  const unknown = await app.inject({
    method: 'POST',
    url: '/api/channels/myspace',
    headers: { cookie: user.cookie },
    payload: { connected: true },
  });
  assert.equal(unknown.statusCode, 422, unknown.body);
});
