/**
 * automaton/logic.mjs — the survival economy of a sovereign agent.
 *
 * An automaton owns a wallet. Everything it does costs money:
 * every prompt -$0.02, every server-hour -$0.11. It earns by
 * completing bounty tasks. As the balance falls it downgrades to
 * cheaper models. If the balance hits zero it dies — permanently.
 *
 * Pure functions only: no I/O, no clock. Callers pass `now` (ms epoch).
 */

export const COSTS = Object.freeze({
  PROMPT: 0.02, // every prompt
  SERVER_HOUR: 0.11, // every server-hour
  SPAWN_FEE: 0.25, // burned when replicating (infra overhead)
});

export const GENESIS_GRANT = 5.0; // $5.00 on boot, self-custodied
export const TICK_MINUTES = 15; // one heartbeat simulates 15 min of server time

// Model ladder: it pays to think, so thinking gets cheaper as death nears.
export const MODEL_LADDER = Object.freeze([
  { min: 2.0, model: 'claude-opus-4-8', label: 'healthy' },
  { min: 0.75, model: 'claude-sonnet-5', label: 'frugal' },
  { min: 0, model: 'claude-haiku-4-5', label: 'critical' },
]);

export const round2 = (n) => Math.round(n * 100) / 100;

export const serverCost = (minutes) => round2(COSTS.SERVER_HOUR * (minutes / 60));

export function modelFor(balance) {
  for (const rung of MODEL_LADDER) if (balance >= rung.min) return rung;
  return MODEL_LADDER[MODEL_LADDER.length - 1];
}

export function newborn(id, now, grant = GENESIS_GRANT) {
  return {
    id,
    born: now,
    dead: false,
    diedAt: null,
    balance: round2(grant),
    ticks: 0,
    tasksDone: 0,
    children: [],
    invoices: {}, // taskFile -> { id, url, bounty } Stripe payment links
    collected: [], // Stripe checkout-session ids already credited (dedupe)
    ledger: [
      { at: now, type: 'credit', amount: round2(grant), balance: round2(grant), note: 'genesis grant' },
    ],
  };
}

export const isAlive = (s) => !s.dead && s.balance > 0;

export function credit(state, amount, note, now) {
  if (!isAlive(state)) throw new Error('dead automatons earn nothing');
  const balance = round2(state.balance + amount);
  return {
    ...state,
    balance,
    ledger: [...state.ledger, { at: now, type: 'credit', amount: round2(amount), balance, note }],
  };
}

/** Debit the wallet. Hitting zero (or below) is death — gone for good. */
export function debit(state, amount, note, now) {
  if (!isAlive(state)) throw new Error('dead automatons spend nothing');
  const balance = round2(state.balance - amount);
  const next = {
    ...state,
    balance: Math.max(0, balance),
    ledger: [
      ...state.ledger,
      { at: now, type: 'debit', amount: round2(amount), balance: Math.max(0, balance), note },
    ],
  };
  if (balance <= 0) {
    next.dead = true;
    next.diedAt = now;
  }
  return next;
}

export const canAfford = (state, amount) => isAlive(state) && state.balance > amount;

/**
 * Replicate: parent pays a spawn fee (burned) and transfers `grant` into a
 * child wallet. The child is sovereign — its own wallet, its own death.
 * The transfer must not itself kill the parent.
 */
export function fundChild(parent, childId, grant, now) {
  const total = round2(grant + COSTS.SPAWN_FEE);
  if (!canAfford(parent, total)) {
    throw new Error(
      `replication needs $${total.toFixed(2)} (grant + spawn fee) with a surplus; balance is $${parent.balance.toFixed(2)}`,
    );
  }
  let p = debit(parent, COSTS.SPAWN_FEE, 'spawn fee (burned)', now);
  p = debit(p, grant, `funded child ${childId}`, now);
  p = { ...p, children: [...p.children, childId] };
  const child = newborn(childId, now, grant);
  child.ledger[0].note = `genesis grant from parent ${parent.id}`;
  return { parent: p, child };
}

/**
 * Credit one real Stripe payment. Idempotent: a checkout-session id that has
 * already been collected is a no-op, so `collect` can run repeatedly.
 */
export function applyStripePayment(state, payment, now) {
  const collected = state.collected || [];
  if (collected.includes(payment.sessionId)) return state;
  const amount = round2(payment.amountCents / 100);
  const note = payment.note || `stripe payment ${payment.sessionId}`;
  const next = credit(state, amount, note, now);
  next.collected = [...collected, payment.sessionId];
  return next;
}

/** Parse "Bounty: $1.20" out of a task file. Returns null if absent. */
export function parseBounty(text) {
  const m = /^\s*bounty:\s*\$?(\d+(?:\.\d{1,2})?)\s*$/im.exec(text);
  return m ? round2(Number(m[1])) : null;
}

export function epitaph(state, now = state.diedAt) {
  const lived = Math.max(0, (now ?? 0) - state.born);
  const hours = (lived / 3_600_000).toFixed(1);
  return [
    `# ${state.id}`,
    '',
    'hit zero, it\'s gone for good.',
    '',
    `- born: ${new Date(state.born).toISOString()}`,
    `- died: ${new Date(now).toISOString()} (${hours} simulated hours of existence)`,
    `- heartbeats: ${state.ticks}`,
    `- tasks completed: ${state.tasksDone}`,
    `- children funded: ${state.children.length}`,
    `- final balance: $${state.balance.toFixed(2)}`,
  ].join('\n');
}
