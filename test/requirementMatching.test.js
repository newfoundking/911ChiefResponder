const { test } = require('node:test');
const assert = require('node:assert');

const { getUnitQualificationSet, canonicalRequirementId } = require('../utils/qualification');

const matchesRequirement = (unit, tokens) => {
  const quals = getUnitQualificationSet(unit, {});
  const scoped = tokens.some((t) => String(t).includes(':'))
    ? tokens.filter((t) => String(t).includes(':'))
    : tokens;
  return scoped.some((token) => quals.has(token));
};

test('SAR-only requirement accepts SAR Rescue but not Fire Rescue', () => {
  const sar = { class: 'sar', type: 'Rescue', equipment: [], personnel: [] };
  const fire = { class: 'fire', type: 'Rescue', equipment: [], personnel: [] };
  const req = [canonicalRequirementId('sar', 'Rescue')];
  assert.equal(matchesRequirement(sar, req), true);
  assert.equal(matchesRequirement(fire, req), false);
});

test('Fire-only requirement accepts Fire Rescue but not SAR Rescue', () => {
  const sar = { class: 'sar', type: 'Rescue', equipment: [], personnel: [] };
  const fire = { class: 'fire', type: 'Rescue', equipment: [], personnel: [] };
  const req = [canonicalRequirementId('fire', 'Rescue')];
  assert.equal(matchesRequirement(fire, req), true);
  assert.equal(matchesRequirement(sar, req), false);
});

test('Legacy type requirement still accepts both rescue units', () => {
  const sar = { class: 'sar', type: 'Rescue', equipment: [], personnel: [] };
  const fire = { class: 'fire', type: 'Rescue', equipment: [], personnel: [] };
  const req = ['Rescue'];
  assert.equal(matchesRequirement(sar, req), true);
  assert.equal(matchesRequirement(fire, req), true);
});
