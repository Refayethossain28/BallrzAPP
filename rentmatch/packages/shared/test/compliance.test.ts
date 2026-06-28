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
