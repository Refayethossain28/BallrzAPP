/**
 * UK statutory compliance gates. These functions decide whether a listing may
 * go live and whether a deal may proceed to signing. A blocking check that
 * fails must stop the corresponding state transition.
 */
import type { ComplianceDoc, ComplianceDocType, EpcRating, Nation, TenancyType } from './types.ts';
import { tenancyDepositCapPence } from './money.ts';

/** Nations RentMatch supports at MVP. */
export const MVP_SUPPORTED_NATIONS: readonly Nation[] = ['england'];

/** EPC bands a property may legally be let at (Minimum Energy Efficiency Standard). */
export const LETTABLE_EPC_BANDS: readonly EpcRating[] = ['A', 'B', 'C', 'D', 'E'];

/** The tenancy instrument used in a given nation. */
export function tenancyTypeForNation(nation: Nation): TenancyType {
  switch (nation) {
    case 'england':
      return 'assured-shorthold';
    case 'wales':
      return 'occupation-contract';
    case 'scotland':
      return 'private-residential';
    case 'northern-ireland':
      return 'private-tenancy';
  }
}

export function isNationSupported(nation: Nation): boolean {
  return MVP_SUPPORTED_NATIONS.includes(nation);
}

export interface ComplianceCheck {
  id: string;
  label: string;
  ok: boolean;
  /** Blocking checks must pass before the related action is permitted. */
  blocking: boolean;
  detail?: string;
}

export interface PropertyComplianceInput {
  nation: Nation;
  epcRating: EpcRating;
  hasGasSupply: boolean;
  smokeAlarmsPerStorey: boolean;
  coAlarmsWhereRequired: boolean;
  docs: ComplianceDoc[];
}

function findValidDoc(docs: ComplianceDoc[], type: ComplianceDocType, now: number): boolean {
  const doc = docs.find((d) => d.type === type);
  return !!doc && (doc.expiresAt == null || doc.expiresAt > now);
}

/** Gate for publishing a listing. */
export function evaluateListingCompliance(
  input: PropertyComplianceInput,
  now: number = Date.now(),
): { checks: ComplianceCheck[]; canGoLive: boolean } {
  const checks: ComplianceCheck[] = [];

  checks.push({
    id: 'nation',
    label: 'Property is in a supported nation',
    ok: isNationSupported(input.nation),
    blocking: true,
    detail: isNationSupported(input.nation)
      ? undefined
      : `${input.nation} tenancies are not yet supported (MVP is England only)`,
  });

  checks.push({
    id: 'epc',
    label: 'Valid EPC, band E or better',
    ok: LETTABLE_EPC_BANDS.includes(input.epcRating) && findValidDoc(input.docs, 'epc', now),
    blocking: true,
    detail: LETTABLE_EPC_BANDS.includes(input.epcRating)
      ? undefined
      : `EPC band ${input.epcRating} cannot legally be let`,
  });

  if (input.hasGasSupply) {
    checks.push({
      id: 'gas-safety',
      label: 'Gas Safety Record (CP12) in date',
      ok: findValidDoc(input.docs, 'gas-safety', now),
      blocking: true,
    });
  }

  checks.push({
    id: 'eicr',
    label: 'Electrical safety report (EICR) in date',
    ok: findValidDoc(input.docs, 'eicr', now),
    blocking: true,
  });

  checks.push({
    id: 'smoke-alarms',
    label: 'Smoke alarm on every storey',
    ok: input.smokeAlarmsPerStorey,
    blocking: true,
  });

  checks.push({
    id: 'co-alarms',
    label: 'Carbon-monoxide alarms where required',
    ok: input.coAlarmsWhereRequired,
    blocking: true,
  });

  const canGoLive = checks.filter((c) => c.blocking).every((c) => c.ok);
  return { checks, canGoLive };
}

export interface SigningComplianceInput {
  nation: Nation;
  monthlyRentPence: number;
  proposedDepositPence: number;
  howToRentServed: boolean;
  rightToRentChecked: boolean;
}

/** Gate for moving a deal into signing. */
export function evaluateSigningCompliance(
  input: SigningComplianceInput,
): { checks: ComplianceCheck[]; canSign: boolean } {
  const checks: ComplianceCheck[] = [];
  const depositCap = tenancyDepositCapPence(input.monthlyRentPence);

  checks.push({
    id: 'deposit-cap',
    label: 'Deposit within the Tenant Fees Act 2019 cap',
    ok: input.proposedDepositPence <= depositCap,
    blocking: true,
    detail:
      input.proposedDepositPence <= depositCap
        ? undefined
        : `Deposit exceeds the cap of ${depositCap}p`,
  });

  // How to Rent is an England requirement; other nations have their own guides.
  if (input.nation === 'england') {
    checks.push({
      id: 'how-to-rent',
      label: '"How to Rent" guide served on the tenant',
      ok: input.howToRentServed,
      blocking: true,
    });
  }

  checks.push({
    id: 'right-to-rent',
    label: 'Right to Rent checks completed (Immigration Act 2014)',
    ok: input.rightToRentChecked,
    blocking: true,
  });

  const canSign = checks.filter((c) => c.blocking).every((c) => c.ok);
  return { checks, canSign };
}
