import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateListingCompliance,
  evaluateSigningCompliance,
  tenancyTypeForNation,
  isNationSupported,
  type PropertyComplianceInput,
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
