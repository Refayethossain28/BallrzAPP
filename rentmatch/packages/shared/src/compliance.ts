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

/** Lifecycle status of a single compliance document. */
export type DocStatus = 'missing' | 'valid' | 'expiring' | 'expired';

/** A document is flagged "expiring" within this window of its expiry. */
export const EXPIRY_SOON_MS = 30 * 86_400_000; // 30 days

export function docStatus(doc: ComplianceDoc | undefined, now: number = Date.now()): DocStatus {
  if (!doc) return 'missing';
  if (doc.expiresAt == null) return 'valid';
  if (doc.expiresAt <= now) return 'expired';
  if (doc.expiresAt - now <= EXPIRY_SOON_MS) return 'expiring';
  return 'valid';
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

/* ------------------------------------------------------------------ *
 * Portfolio compliance — the standalone landlord dashboard.
 *
 * Unlike the listing/signing gates above (which answer "may this one
 * action proceed?"), these functions answer "is my whole portfolio
 * legal, and what's about to lapse?" — the value that makes the
 * subscription worth paying for, independent of any live deal.
 * ------------------------------------------------------------------ */

/** Human label for each document type, shared by every surface. */
export const DOC_LABELS: Record<ComplianceDocType, string> = {
  epc: 'Energy Performance Certificate (EPC)',
  'gas-safety': 'Gas Safety Record (CP12)',
  eicr: 'Electrical safety report (EICR)',
  'how-to-rent': '"How to Rent" guide',
  'right-to-rent': 'Right to Rent check',
  'deposit-protection': 'Deposit protection',
};

/**
 * The compliance documents a *let* property must keep in date. EPC and EICR
 * are always required; a gas certificate only where there's a gas supply.
 * (How to Rent / Right to Rent / deposit protection are per-tenancy, handled
 * by the signing gate, not the standing portfolio view.)
 */
export function requiredDocTypes(opts: { hasGasSupply: boolean }): ComplianceDocType[] {
  return ['epc', 'eicr', ...(opts.hasGasSupply ? (['gas-safety'] as const) : [])];
}

/** A single property as the portfolio view needs to see it. */
export interface PortfolioProperty {
  id: string;
  /** Display label, e.g. the address. */
  label: string;
  hasGasSupply: boolean;
  docs: ComplianceDoc[];
}

/** Overall risk band for one property, worst-document-wins. */
export type ComplianceRisk = 'compliant' | 'attention' | 'breach';

export interface DocItem {
  type: ComplianceDocType;
  label: string;
  status: DocStatus;
  expiresAt?: number;
}

export interface PropertyComplianceSummary {
  id: string;
  label: string;
  risk: ComplianceRisk;
  docs: DocItem[];
}

export interface UpcomingExpiry {
  propertyId: string;
  propertyLabel: string;
  type: ComplianceDocType;
  label: string;
  /** Present for expiring docs; absent for already-expired-but-undated edge cases. */
  expiresAt?: number;
  status: Extract<DocStatus, 'expiring' | 'expired'>;
}

export interface PortfolioSummary {
  properties: PropertyComplianceSummary[];
  counts: { total: number; compliant: number; attention: number; breach: number };
  /** Expired first, then soonest-expiring — the action list for the landlord. */
  upcoming: UpcomingExpiry[];
}

/** A missing or expired required doc is a legal breach; an expiring one needs attention. */
function riskOfStatus(status: DocStatus): ComplianceRisk {
  if (status === 'missing' || status === 'expired') return 'breach';
  if (status === 'expiring') return 'attention';
  return 'compliant';
}

const RISK_RANK: Record<ComplianceRisk, number> = { compliant: 0, attention: 1, breach: 2 };

/** Per-property compliance status across its required documents. */
export function summarisePropertyCompliance(
  property: PortfolioProperty,
  now: number = Date.now(),
): PropertyComplianceSummary {
  const docs: DocItem[] = requiredDocTypes(property).map((type) => {
    const doc = property.docs.find((d) => d.type === type);
    const status = docStatus(doc, now);
    return { type, label: DOC_LABELS[type], status, expiresAt: doc?.expiresAt };
  });
  const risk = docs.reduce<ComplianceRisk>(
    (worst, d) => (RISK_RANK[riskOfStatus(d.status)] > RISK_RANK[worst] ? riskOfStatus(d.status) : worst),
    'compliant',
  );
  return { id: property.id, label: property.label, risk, docs };
}

/** Roll a landlord's whole portfolio into a dashboard summary + action list. */
export function summarisePortfolio(
  properties: PortfolioProperty[],
  now: number = Date.now(),
): PortfolioSummary {
  const summaries = properties.map((p) => summarisePropertyCompliance(p, now));

  const counts = { total: summaries.length, compliant: 0, attention: 0, breach: 0 };
  for (const s of summaries) counts[s.risk] += 1;

  const upcoming: UpcomingExpiry[] = [];
  for (const s of summaries) {
    for (const d of s.docs) {
      if (d.status === 'expiring' || d.status === 'expired') {
        upcoming.push({
          propertyId: s.id,
          propertyLabel: s.label,
          type: d.type,
          label: d.label,
          expiresAt: d.expiresAt,
          status: d.status,
        });
      }
    }
  }
  // Expired (no/oldest expiry) first, then soonest-expiring.
  upcoming.sort((a, b) => (a.expiresAt ?? 0) - (b.expiresAt ?? 0));

  return { properties: summaries, counts, upcoming };
}
