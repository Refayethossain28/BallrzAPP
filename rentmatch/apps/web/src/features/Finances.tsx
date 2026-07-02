import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  summariseFinances, taxYearsPresent, taxYearLabel, taxYearStartYear,
  EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, formatGBP,
  type ExpenseCategory,
} from '@rentmatch/shared';
import { useAuth } from '../auth/AuthProvider';
import {
  fetchLandlordExpenses, fetchLandlordRentPayments, createExpense, deleteExpense,
  type NewExpenseInput,
} from '../lib/db';
import { formatDate } from '../components/ui';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default function Finances() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [year, setYear] = useState<number | null>(null);
  const [error, setError] = useState('');

  const { data: income = [] } = useQuery({
    queryKey: ['rent-payments', user?.uid],
    queryFn: () => fetchLandlordRentPayments(user!.uid),
    enabled: !!user,
  });
  const { data: expenses = [] } = useQuery({
    queryKey: ['expenses', user?.uid],
    queryFn: () => fetchLandlordExpenses(user!.uid),
    enabled: !!user,
  });

  const years = useMemo(() => taxYearsPresent([...income, ...expenses]), [income, expenses]);
  const startYear = year ?? years[0] ?? taxYearStartYear(Date.now());
  const summary = useMemo(() => summariseFinances(income, expenses, startYear), [income, expenses, startYear]);
  const yearExpenses = expenses.filter((e) => taxYearStartYear(e.date) === startYear);

  const addExpense = useMutation({
    mutationFn: (input: NewExpenseInput) => createExpense(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['expenses', user?.uid] }),
  });
  const removeExpense = useMutation({
    mutationFn: (id: string) => deleteExpense(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['expenses', user?.uid] }),
  });

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!user) return;
    const form = e.currentTarget;
    const f = new FormData(form);
    const amountPence = Math.round(Number(f.get('amount') ?? 0) * 100);
    const dateStr = String(f.get('date') ?? '');
    if (amountPence <= 0 || !dateStr) {
      setError('Enter an amount and a date.');
      return;
    }
    setError('');
    addExpense.mutate(
      {
        landlordId: user.uid,
        date: new Date(dateStr).getTime(),
        amountPence,
        category: String(f.get('category') ?? 'other') as ExpenseCategory,
        note: String(f.get('note') ?? '').trim() || undefined,
      },
      { onSuccess: () => form.reset() },
    );
  }

  return (
    <>
      <h2 className="title">Finances</h2>
      <p className="sub">Rent income and expenses by UK tax year — ready for Self Assessment.</p>

      <div className="field">
        <label htmlFor="fin-year">Tax year</label>
        <select id="fin-year" value={startYear} onChange={(e) => setYear(Number(e.target.value))}>
          {years.map((y) => <option key={y} value={y}>{taxYearLabel(y)}</option>)}
        </select>
      </div>

      <div className="stat-row">
        <Stat label="Income" value={formatGBP(summary.incomePence)} tone="good" />
        <Stat label="Expenses" value={formatGBP(summary.expensePence)} tone="warn" />
        <Stat label="Net" value={formatGBP(summary.netPence)} tone={summary.netPence >= 0 ? 'good' : 'bad'} />
      </div>

      {summary.mortgageInterestPence > 0 && (
        <p className="faint" style={{ fontSize: 11, margin: '0 0 8px' }}>
          Net shown is income − all costs. {formatGBP(summary.mortgageInterestPence)} of that is mortgage interest,
          which for individuals is a restricted basic-rate tax credit, not a deduction — check with your accountant.
        </p>
      )}

      {summary.byCategory.length > 0 && (
        <>
          <div className="section-t">Expense breakdown</div>
          <div className="card"><div className="body">
            {summary.byCategory.map((c) => (
              <div key={c.category} className="row center" style={{ justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
                <span className="muted" style={{ fontSize: 13.5 }}>{c.label}</span>
                <b>{formatGBP(c.amountPence)}</b>
              </div>
            ))}
          </div></div>
        </>
      )}

      <div className="section-t">Log an expense</div>
      <form onSubmit={submit}>
        <div className="two">
          <div className="field"><label htmlFor="fin-amount">Amount (£)</label>
            <input id="fin-amount" name="amount" type="number" min={0} step="0.01" placeholder="120.00" /></div>
          <div className="field"><label htmlFor="fin-date">Date</label>
            <input id="fin-date" name="date" type="date" defaultValue={todayISO()} max={todayISO()} /></div>
        </div>
        <div className="field"><label htmlFor="fin-category">Category</label>
          <select id="fin-category" name="category" defaultValue="repairs-maintenance">
            {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{EXPENSE_CATEGORY_LABELS[c]}</option>)}
          </select></div>
        <div className="field"><label htmlFor="fin-note">Note (optional)</label>
          <input id="fin-note" name="note" placeholder="Boiler service — British Gas" /></div>
        {error && <p className="error">{error}</p>}
        <button className="cta" type="submit" disabled={addExpense.isPending}>
          {addExpense.isPending ? 'Saving…' : 'Add expense'}
        </button>
      </form>

      {yearExpenses.length > 0 && (
        <>
          <div className="section-t">Expenses · {taxYearLabel(startYear)}</div>
          <div className="card"><div className="body">
            {yearExpenses.map((x) => (
              <div key={x.id} className="row center" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5 }}>{EXPENSE_CATEGORY_LABELS[x.category]}</div>
                  <div className="faint" style={{ fontSize: 11.5 }}>{formatDate(x.date)}{x.note ? ` · ${x.note}` : ''}</div>
                </div>
                <span className="row center" style={{ gap: 10 }}>
                  <b>{formatGBP(x.amountPence)}</b>
                  <button className="back" style={{ width: 28, height: 28, fontSize: 14 }}
                    title="Delete" aria-label="Delete expense" onClick={() => removeExpense.mutate(x.id)}>×</button>
                </span>
              </div>
            ))}
          </div></div>
        </>
      )}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="stat">
      <div className={`stat-n ${tone ?? ''}`} style={{ fontSize: 17 }}>{value}</div>
      <div className="stat-l">{label}</div>
    </div>
  );
}
