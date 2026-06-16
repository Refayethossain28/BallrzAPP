/**
 * Tenancy-agreement generation. Produces a structured contract (parties, terms
 * and numbered clauses) that the web client renders and a Cloud Function turns
 * into the PDF sent for e-signature. MVP supports the England AST only; other
 * nations resolve to their instrument but are flagged `supportedInMvp: false`.
 */
import type { EpcRating, Nation, Party, TenancyType } from './types.ts';
import { tenancyTypeForNation } from './compliance.ts';
import { depositCapWeeks, tenancyDepositCapPence, weeklyRentPence } from './money.ts';

export interface ContractInput {
  nation: Nation;
  landlord: Party;
  tenant: Party;
  propertyAddress: string;
  monthlyRentPence: number;
  /** epoch ms tenancy start */
  startDate: number;
  termMonths: number;
  furnished: 'Furnished' | 'Unfurnished' | 'Part-furnished';
  epcRating: EpcRating;
}

export interface Clause {
  number: string;
  heading: string;
  text: string;
}

export interface TenancyAgreement {
  tenancyType: TenancyType;
  supportedInMvp: boolean;
  governingAct: string;
  parties: { landlord: Party; tenant: Party };
  propertyAddress: string;
  monthlyRentPence: number;
  depositPence: number;
  depositWeeks: 5 | 6;
  startDate: number;
  endDate: number;
  termMonths: number;
  clauses: Clause[];
}

const DAY_MS = 86_400_000;

export function buildTenancyAgreement(input: ContractInput): TenancyAgreement {
  const tenancyType = tenancyTypeForNation(input.nation);
  const supportedInMvp = tenancyType === 'assured-shorthold';
  const depositPence = tenancyDepositCapPence(input.monthlyRentPence);
  const depositWeeks = depositCapWeeks(input.monthlyRentPence);
  const weekly = weeklyRentPence(input.monthlyRentPence);
  const endDate = input.startDate + Math.round((input.termMonths / 12) * 365) * DAY_MS;

  const clauses: Clause[] = [
    {
      number: '1',
      heading: 'The Tenancy',
      text: `The Landlord lets and the Tenant takes the Property for a fixed term of ${input.termMonths} months. This is an Assured Shorthold Tenancy under section 19A of the Housing Act 1988; the provisions for recovery of possession in sections 21 and 8 apply.`,
    },
    {
      number: '2',
      heading: 'Rent',
      text: `The Tenant shall pay rent of ${input.monthlyRentPence}p per calendar month (≈ ${weekly}p per week), payable monthly in advance. The first payment is due on or before the commencement date.`,
    },
    {
      number: '3',
      heading: 'Deposit',
      text: `The Tenant shall pay a tenancy deposit of ${depositPence}p (${depositWeeks} weeks' rent — within the Tenant Fees Act 2019 cap), to be protected in a government-authorised scheme within 30 days, with prescribed information served on the Tenant.`,
    },
    {
      number: '4',
      heading: "Tenant's obligations",
      text: 'To pay the rent and other sums due, keep the interior in good and clean condition (fair wear and tear excepted), not to sublet without written consent, and to use the Property as a single private residence only.',
    },
    {
      number: '5',
      heading: "Landlord's obligations",
      text: 'To keep in repair the structure, exterior and service installations under section 11 of the Landlord and Tenant Act 1985, to ensure the Property is fit for human habitation (Homes (Fitness for Human Habitation) Act 2018), and to allow the Tenant quiet enjoyment.',
    },
    {
      number: '6',
      heading: 'Notices & possession',
      text: 'The Landlord may recover possession after the fixed term on not less than two months’ notice under section 21, subject to statutory pre-conditions, or during the term on the grounds in Schedule 2 (section 8) of the Housing Act 1988.',
    },
    {
      number: '7',
      heading: 'Right to Rent',
      text: 'The Tenant confirms all occupiers have the right to rent in the UK under the Immigration Act 2014 and that satisfactory checks have been carried out.',
    },
  ];

  return {
    tenancyType,
    supportedInMvp,
    governingAct: 'Housing Act 1988',
    parties: { landlord: input.landlord, tenant: input.tenant },
    propertyAddress: input.propertyAddress,
    monthlyRentPence: input.monthlyRentPence,
    depositPence,
    depositWeeks,
    startDate: input.startDate,
    endDate,
    termMonths: input.termMonths,
    clauses,
  };
}
