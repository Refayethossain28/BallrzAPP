import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateListingCompliance,
  evaluateSigningCompliance,
  tenancyTypeForNation,
  isNationSupported,
  requiredDocTypes,
  summarisePropertyCompliance,
  summarisePortfolio,
  dueComplianceReminders,
  type PropertyComplianceInput,
  type PortfolioProperty,
} from '../src/compliance.ts';
import { buildTenancyAgreement } from '../src/contractTemplate.ts';
import { tenancyDepositCapPence } from '../src/money.ts';

const compliantProperty: PropertyComplianceInput = {
  nation: 'england',
  epcRating: 'C',
  hasGasSupply: true,
  smokeAlarmsPerStorey: true,
  coAlarmsWhereRequired: true,
  docs: [{ type: 'epc' }, { type: 'gas-safety' }, { type: 'eicr' }],
};

test('a fully documented England property can go live', () => {
  const { canGoLive } = evaluateListingCompliance(compliantProperty);
  assert.equal(canGoLive, true);
});

test('EPC band F blocks letting', () => {
  const { canGoLive, checks } = evaluateListingCompliance({ ...compliantProperty, epcRating: 'F' });
  assert.equal(canGoLive, false);
  assert.equal(checks.find((c) => c.id === 'epc')?.ok, false);
});

test('missing gas certificate blocks a property with gas', () => {
  const { canGoLive } = evaluateListingCompliance({
    ...compliantProperty,
    docs: [{ type: 'epc' }, { type: 'eicr' }],
  });
  assert.equal(canGoLive, false);
});

test('expired EICR blocks letting', () => {
  const yesterday = Date.now() - 86_400_000;
  const { canGoLive } = evaluateListingCompliance({
    ...compliantProperty,
    docs: [{ type: 'epc' }, { type: 'gas-safety' }, { type: 'eicr', expiresAt: yesterday }],
  });
  assert.equal(canGoLive, false);
});

test('non-England nations are not lettable at MVP', () => {
  assert.equal(isNationSupported('scotland'), false);
  const { canGoLive } = evaluateListingCompliance({ ...compliantProperty, nation: 'scotland' });
  assert.equal(canGoLive, false);
});

test('signing blocked when deposit exceeds the cap', () => {
  const cap = tenancyDepositCapPence(165000);
  const over = evaluateSigningCompliance({
    nation: 'england',
    monthlyRentPence: 165000,
    proposedDepositPence: cap + 1,
    howToRentServed: true,
    rightToRentChecked: true,
  });
  assert.equal(over.canSign, false);
  const ok = evaluateSigningCompliance({
    nation: 'england',
    monthlyRentPence: 165000,
    proposedDepositPence: cap,
    howToRentServed: true,
    rightToRentChecked: true,
  });
  assert.equal(ok.canSign, true);
});

test('tenancy type resolves per nation; only England is MVP-supported', () => {
  assert.equal(tenancyTypeForNation('england'), 'assured-shorthold');
  assert.equal(tenancyTypeForNation('wales'), 'occupation-contract');
  assert.equal(tenancyTypeForNation('scotland'), 'private-residential');

  const ast = buildTenancyAgreement({
    nation: 'england',
    landlord: { name: 'Priya Sharma', email: 'p@example.co.uk' },
    tenant: { name: 'Tom Baxter', email: 't@example.co.uk' },
    propertyAddress: '14 Mapledene Road, Hackney, London E8 3JN',
    monthlyRentPence: 220000,
    startDate: Date.UTC(2026, 6, 1),
    termMonths: 12,
    furnished: 'Furnished',
    epcRating: 'C',
  });
  assert.equal(ast.supportedInMvp, true);
  assert.equal(ast.depositWeeks, 5);
  assert.equal(ast.clauses.length, 7);

  const welsh = buildTenancyAgreement({
    nation: 'wales',
    landlord: { name: 'A', email: 'a@x.uk' },
    tenant: { name: 'B', email: 'b@x.uk' },
    propertyAddress: 'Cardiff',
    monthlyRentPence: 110000,
    startDate: Date.UTC(2026, 6, 1),
    termMonths: 12,
    furnished: 'Unfurnished',
    epcRating: 'B',
  });
  assert.equal(welsh.supportedInMvp, false);
});

/* ---- portfolio compliance dashboard ---- */

const DAY = 86_400_000;

test('a gas property requires EPC, EICR and gas; a no-gas property drops gas', () => {
  assert.deepEqual(requiredDocTypes({ hasGasSupply: true }), ['epc', 'eicr', 'gas-safety']);
  assert.deepEqual(requiredDocTypes({ hasGasSupply: false }), ['epc', 'eicr']);
});

test('a property with all required docs in date is compliant', () => {
  const now = Date.now();
  const p: PortfolioProperty = {
    id: 'p1',
    label: '14 Mapledene Road',
    hasGasSupply: true,
    docs: [
      { type: 'epc', expiresAt: now + 400 * DAY },
      { type: 'eicr', expiresAt: now + 400 * DAY },
      { type: 'gas-safety', expiresAt: now + 200 * DAY },
    ],
  };
  assert.equal(summarisePropertyCompliance(p, now).risk, 'compliant');
});

test('a missing required doc is a breach, not just attention', () => {
  const now = Date.now();
  const p: PortfolioProperty = {
    id: 'p2',
    label: '5 Gas Street',
    hasGasSupply: true,
    docs: [{ type: 'epc', expiresAt: now + 400 * DAY }, { type: 'eicr', expiresAt: now + 400 * DAY }],
  };
  const s = summarisePropertyCompliance(p, now);
  assert.equal(s.risk, 'breach');
  assert.equal(s.docs.find((d) => d.type === 'gas-safety')?.status, 'missing');
});

test('a doc expiring within 30 days flags attention, not breach', () => {
  const now = Date.now();
  const p: PortfolioProperty = {
    id: 'p3',
    label: '9 Soon Lane',
    hasGasSupply: false,
    docs: [{ type: 'epc', expiresAt: now + 400 * DAY }, { type: 'eicr', expiresAt: now + 10 * DAY }],
  };
  assert.equal(summarisePropertyCompliance(p, now).risk, 'attention');
});

test('breach outranks attention when a property has both', () => {
  const now = Date.now();
  const p: PortfolioProperty = {
    id: 'p4',
    label: '1 Mixed Court',
    hasGasSupply: true,
    docs: [
      { type: 'epc', expiresAt: now - DAY }, // expired → breach
      { type: 'eicr', expiresAt: now + 10 * DAY }, // expiring → attention
      { type: 'gas-safety', expiresAt: now + 200 * DAY },
    ],
  };
  assert.equal(summarisePropertyCompliance(p, now).risk, 'breach');
});

test('portfolio summary counts by risk and lists expired-then-soonest expiries', () => {
  const now = Date.now();
  const properties: PortfolioProperty[] = [
    {
      id: 'ok',
      label: 'Compliant House',
      hasGasSupply: false,
      docs: [{ type: 'epc', expiresAt: now + 400 * DAY }, { type: 'eicr', expiresAt: now + 400 * DAY }],
    },
    {
      id: 'soon',
      label: 'Expiring House',
      hasGasSupply: false,
      docs: [{ type: 'epc', expiresAt: now + 5 * DAY }, { type: 'eicr', expiresAt: now + 400 * DAY }],
    },
    {
      id: 'bad',
      label: 'Breach House',
      hasGasSupply: true,
      docs: [{ type: 'epc', expiresAt: now - 2 * DAY }, { type: 'eicr', expiresAt: now + 400 * DAY }],
    },
  ];
  const summary = summarisePortfolio(properties, now);
  assert.deepEqual(summary.counts, { total: 3, compliant: 1, attention: 1, breach: 1 });
  // Expired EPC (Breach House) sorts before the soon-expiring EPC (Expiring House);
  // 'bad' also has a missing gas-safety (no expiry → 0) which sorts first.
  assert.equal(summary.upcoming[0].propertyId, 'bad');
  assert.ok(summary.upcoming.some((u) => u.propertyId === 'soon' && u.status === 'expiring'));
});

/* ---- compliance reminders ---- */

function propWithGasExpiry(expiresAt: number): PortfolioProperty {
  return {
    id: 'r1',
    label: '14 Mapledene Road',
    hasGasSupply: true,
    docs: [
      { type: 'epc', expiresAt: Date.now() + 1000 * DAY },
      { type: 'eicr', expiresAt: Date.now() + 1000 * DAY },
      { type: 'gas-safety', expiresAt },
    ],
  };
}

test('no reminder fires while a doc is more than 60 days from expiry', () => {
  const now = Date.now();
  assert.deepEqual(dueComplianceReminders(propWithGasExpiry(now + 90 * DAY), [], now), []);
});

test('a doc within 30 days fires the 30-day reminder once', () => {
  const now = Date.now();
  const due = dueComplianceReminders(propWithGasExpiry(now + 20 * DAY), [], now);
  assert.equal(due.length, 1);
  assert.equal(due[0].type, 'gas-safety');
  assert.equal(due[0].threshold, 30);
  // Already-sent key suppresses a repeat on the next daily run.
  assert.deepEqual(dueComplianceReminders(propWithGasExpiry(now + 20 * DAY), [due[0].key], now), []);
});

test('crossing into a more urgent bucket fires a fresh reminder', () => {
  const now = Date.now();
  const expiresAt = now + 5 * DAY; // now in the 7-day bucket
  const sent30 = dueComplianceReminders(propWithGasExpiry(now + 20 * DAY), [], now)[0].key;
  const due = dueComplianceReminders(propWithGasExpiry(expiresAt), [sent30], now);
  assert.equal(due.length, 1);
  assert.equal(due[0].threshold, 7);
});

test('an expired doc fires the expired reminder with non-positive days', () => {
  const now = Date.now();
  const due = dueComplianceReminders(propWithGasExpiry(now - 2 * DAY), [], now);
  assert.equal(due.length, 1);
  assert.equal(due[0].threshold, 'expired');
  assert.ok(due[0].daysToExpiry <= 0);
});

test('renewing a doc (new expiry) starts a fresh reminder cycle', () => {
  const now = Date.now();
  const oldKey = dueComplianceReminders(propWithGasExpiry(now + 20 * DAY), [], now)[0].key;
  // Renewed to a year out, then back into a window later — old key must not suppress it.
  const due = dueComplianceReminders(propWithGasExpiry(now + 6 * DAY), [oldKey], now);
  assert.equal(due.length, 1);
  assert.notEqual(due[0].key, oldKey);
});

test('missing or non-expiring docs are not nagged by reminders', () => {
  const now = Date.now();
  const p: PortfolioProperty = {
    id: 'r2',
    label: 'No-expiry House',
    hasGasSupply: false,
    docs: [{ type: 'epc' }], // EPC present but undated; EICR missing
  };
  assert.deepEqual(dueComplianceReminders(p, [], now), []);
});
