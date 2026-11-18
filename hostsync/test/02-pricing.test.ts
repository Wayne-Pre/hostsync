/**
 * T-35 — the pricing engine.
 * Every expected value here is a live figure captured from the running product
 * (spec §2.1 / §2.2), so this file fails if the rebuild ever drifts from reality.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMISSION_BPS, PRICING_VERSION, priceStay, describeStay } from '../src/pricing.ts';
import type { Channel } from '../src/pricing.ts';

test('commission table matches the observed channels', () => {
  assert.deepEqual(COMMISSION_BPS, {
    airbnb: 1500,
    booking_com: 1500,
    vrbo: 800,
    direct: 0,
    whatsapp: 0,
  });
});

// [property, rate, cleaning, nights, channel, expected gross, expected net] — all from the live app
const LIVE_CASES: Array<[string, number, number, number, Channel, number, number]> = [
  ['Karen 3n direct', 1_500_000, 300_000, 3, 'direct', 4_800_000, 4_800_000],
  ['Karen 3n airbnb', 1_500_000, 300_000, 3, 'airbnb', 4_800_000, 4_080_000],
  ['Karen 4n airbnb', 1_500_000, 300_000, 4, 'airbnb', 6_300_000, 5_355_000],
  ['Karen 7n direct', 1_500_000, 300_000, 7, 'direct', 10_800_000, 10_800_000],
  ['Kilimani 4n airbnb', 1_250_000, 250_000, 4, 'airbnb', 5_250_000, 4_462_500],
  ['Kilimani 5n booking', 1_250_000, 250_000, 5, 'booking_com', 6_500_000, 5_525_000],
  ['Kilimani 4n direct', 1_250_000, 250_000, 4, 'direct', 5_250_000, 5_250_000],
  ['Nyali 7n airbnb', 2_600_000, 500_000, 7, 'airbnb', 18_700_000, 15_895_000],
  ['Nyali 6n booking', 2_600_000, 500_000, 6, 'booking_com', 16_100_000, 13_685_000],
  ['Nyali 3n booking', 2_600_000, 500_000, 3, 'booking_com', 8_300_000, 7_055_000],
  ['Westlands 4n airbnb', 1_850_000, 350_000, 4, 'airbnb', 7_750_000, 6_587_500],
  ['Westlands 5n airbnb', 1_850_000, 350_000, 5, 'airbnb', 9_600_000, 8_160_000],
  ['Westlands 5n direct', 1_850_000, 350_000, 5, 'direct', 9_600_000, 9_600_000],
  ['Westlands 4n vrbo', 1_850_000, 350_000, 4, 'vrbo', 7_750_000, 7_130_000],
  ['Riverside 3n direct', 750_000, 150_000, 3, 'direct', 2_400_000, 2_400_000],
  ['Riverside 2n direct', 750_000, 150_000, 2, 'direct', 1_650_000, 1_650_000],
];

for (const [label, rate, cleaning, nights, channel, gross, net] of LIVE_CASES) {
  test(`live value reproduced: ${label}`, () => {
    const price = priceStay({
      nights,
      nightlyRateCents: rate,
      cleaningFeeCents: cleaning,
      channel,
    });
    assert.equal(price.grossCents, gross, 'gross total');
    assert.equal(price.netCents, net, 'net to owner');
    assert.equal(price.commissionCents, gross - net, 'commission is the difference');
    assert.equal(price.rateVersion, PRICING_VERSION);
  });
}

test('cleaning fee is charged once, not per night', () => {
  const one = priceStay({
    nights: 1,
    nightlyRateCents: 1_500_000,
    cleaningFeeCents: 300_000,
    channel: 'direct',
  });
  const ten = priceStay({
    nights: 10,
    nightlyRateCents: 1_500_000,
    cleaningFeeCents: 300_000,
    channel: 'direct',
  });
  assert.equal(one.grossCents, 1_800_000);
  assert.equal(ten.grossCents, 15_300_000);
  assert.equal(ten.grossCents - one.grossCents, 9 * 1_500_000);
});

test('commission rounds to the nearest cent, never drifts', () => {
  const price = priceStay({
    nights: 3,
    nightlyRateCents: 333_333,
    cleaningFeeCents: 0,
    channel: 'airbnb',
  });
  const expectedCommission = Math.round((999_999 * 1500) / 10_000);
  assert.equal(price.commissionCents, expectedCommission);
  assert.equal(price.netCents, 999_999 - expectedCommission);
  assert.equal(price.grossCents, price.commissionCents + price.netCents);
});

test('rejects nonsense input instead of pricing it', () => {
  assert.throws(() => priceStay({ nights: 0, nightlyRateCents: 100, cleaningFeeCents: 0, channel: 'direct' }), /nights/);
  assert.throws(() => priceStay({ nights: 1.5, nightlyRateCents: 100, cleaningFeeCents: 0, channel: 'direct' }), /nights/);
  assert.throws(() => priceStay({ nights: 1, nightlyRateCents: 0, cleaningFeeCents: 0, channel: 'direct' }), /nightlyRateCents/);
  assert.throws(() => priceStay({ nights: 1, nightlyRateCents: 100, cleaningFeeCents: -1, channel: 'direct' }), /cleaningFeeCents/);
});

test('the summary line reads like the product', () => {
  const price = priceStay({
    nights: 2,
    nightlyRateCents: 1_500_000,
    cleaningFeeCents: 300_000,
    channel: 'direct',
  });
  assert.equal(describeStay(price), '2 nights · base KES 15,000 + cleaning KES 3,000');
});
