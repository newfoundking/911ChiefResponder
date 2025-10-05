const { test } = require('node:test');
const assert = require('node:assert');

const { getSeatInfo } = require('../utils');

test('getSeatInfo returns default capacity when no override provided', () => {
  const info = getSeatInfo('fire', 'Engine', undefined);
  assert.strictEqual(info.defaultCapacity, 6);
  assert.strictEqual(info.seatCapacity, 6);
  assert.strictEqual(info.seatOverride, null);
});

test('getSeatInfo clamps overrides within allowed range', () => {
  const info = getSeatInfo('fire', 'Engine', 3);
  assert.strictEqual(info.defaultCapacity, 6);
  assert.strictEqual(info.seatCapacity, 3);
  assert.strictEqual(info.seatOverride, 3);

  const high = getSeatInfo('fire', 'Engine', 10);
  assert.strictEqual(high.seatCapacity, 6);
  assert.strictEqual(high.seatOverride, null);

  const low = getSeatInfo('fire', 'Engine', 0);
  assert.strictEqual(low.seatCapacity, 1);
  assert.strictEqual(low.seatOverride, 1);
});

test('getSeatInfo handles unknown unit types gracefully', () => {
  const info = getSeatInfo('unknown', 'Unknown', 5);
  assert.strictEqual(info.defaultCapacity, 0);
  assert.strictEqual(info.seatCapacity, 5);
  assert.strictEqual(info.seatOverride, 5);
});
