/**
 * Landlord finances — pure, deterministic accounting by **UK tax year**
 * (6 April → 5 April). Turns rent received and logged expenses into the income /
 * expense / net-profit picture a landlord needs for Self Assessment (and, soon,
 * Making Tax Digital for Income Tax). No I/O; `asOf`/`startYear` are passed in so
 * the whole thing is unit-testable and identical on every surface.
 *
 * Money is integer **pence** (GBP), consistent with the rest of the kernel.
 * Note: mortgage interest is kept as its own category because its tax treatment
 * is a restricted basic-rate credit, not a simple deduction — surfaced, not
 * silently netted off.
 */

/** UK tax year starts 6 April. Month is 0-indexed (April = 3). */
export const UK_TAX_YEAR_START = { month: 3, day: 6 } as const;

/** The start year of the UK tax year an instant falls in (e.g. 5 Apr 2027 → 2026). */
export function taxYearStartYear(epoch: number): number {
  const d = new Date(epoch);
  const y = d.getUTCFullYear();
  const boundary = Date.UTC(y, UK_TAX_YEAR_START.month, UK_TAX_YEAR_START.day);
  return epoch >= boundary ? y : y - 1;
}

/** Display label for a tax year, e.g. 2026 → "2026/27". */
export function taxYearLabel(startYear: number): string {
  return `${startYear}/${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Half-open range [start, end) in epoch ms for a tax year. */
export function taxYearRange(startYear: number): { start: number; end: number } {
  return {
    start: Date.UTC(startYear, UK_TAX_YEAR_START.month, UK_TAX_YEAR_START.day),
    end: Date.UTC(startYear + 1, UK_TAX_YEAR_START.month, UK_TAX_YEAR_START.day),
  };
}

export type ExpenseCategory =
  | 'repairs-maintenance'
  | 'agent-fees'
  | 'insurance'
  | 'mortgage-interest'
  | 'service-charge-ground-rent'
  | 'utilities-council-tax'
  | 'legal-professional'
  | 'other';

export const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = [
  'repairs-maintenance',
  'agent-fees',
  'insurance',
  'mortgage-interest',
  'service-charge-ground-rent',
  'utilities-council-tax',
  'legal-professional',
  'other',
];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  'repairs-maintenance': 'Repairs & maintenance',
  'agent-fees': 'Letting / management fees',
  insurance: 'Insurance',
  'mortgage-interest': 'Mortgage interest',
  'service-charge-ground-rent': 'Service charge & ground rent',
  'utilities-council-tax': 'Utilities & council tax',
  'legal-professional': 'Legal & professional',
  other: 'Other',
};

export interface FinanceEntry {
  date: number;
  amountPence: number;
}

export interface ExpenseEntry extends FinanceEntry {
  category: ExpenseCategory;
}

export interface CategoryTotal {
  category: ExpenseCategory;
  label: string;
  amountPence: number;
}

export interface FinanceSummary {
  startYear: number;
  label: string;
  incomePence: number;
  expensePence: number;
  netPence: number;
  /** Allowable expenses only (excludes the restricted mortgage-interest credit). */
  allowableExpensePence: number;
  mortgageInterestPence: number;
  /** Expense categories with a non-zero total, largest first. */
  byCategory: CategoryTotal[];
}

const inRange = (e: FinanceEntry, start: number, end: number) => e.date >= start && e.date < end;

/** Roll income + expenses into a single UK-tax-year summary. */
export function summariseFinances(
  income: FinanceEntry[],
  expenses: ExpenseEntry[],
  startYear: number,
): FinanceSummary {
  const { start, end } = taxYearRange(startYear);

  const incomePence = income.filter((e) => inRange(e, start, end)).reduce((s, e) => s + e.amountPence, 0);
  const yearExpenses = expenses.filter((e) => inRange(e, start, end));

  const totals = new Map<ExpenseCategory, number>();
  for (const e of yearExpenses) totals.set(e.category, (totals.get(e.category) ?? 0) + e.amountPence);

  const byCategory: CategoryTotal[] = [...totals.entries()]
    .map(([category, amountPence]) => ({ category, label: EXPENSE_CATEGORY_LABELS[category], amountPence }))
    .filter((c) => c.amountPence !== 0)
    .sort((a, b) => b.amountPence - a.amountPence);

  const expensePence = yearExpenses.reduce((s, e) => s + e.amountPence, 0);
  const mortgageInterestPence = totals.get('mortgage-interest') ?? 0;
  const allowableExpensePence = expensePence - mortgageInterestPence;

  return {
    startYear,
    label: taxYearLabel(startYear),
    incomePence,
    expensePence,
    netPence: incomePence - expensePence,
    allowableExpensePence,
    mortgageInterestPence,
    byCategory,
  };
}

/** The distinct tax years present across some entries, most recent first. */
export function taxYearsPresent(entries: FinanceEntry[], asOf: number = Date.now()): number[] {
  const years = new Set<number>([taxYearStartYear(asOf)]);
  for (const e of entries) years.add(taxYearStartYear(e.date));
  return [...years].sort((a, b) => b - a);
}
