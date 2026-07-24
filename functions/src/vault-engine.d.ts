/**
 * Type surface of vault-engine.js — the pure ledger engine shared verbatim
 * with the browser app (vault/engine.js). The .js file is a byte-identical
 * copy; scripts/test-vault-logic.mjs fails if the two ever diverge.
 */
export interface VaultAccount {
  id: string;
  kind: 'current' | 'savings';
  name: string;
  overdraft?: number;
  aerPct?: number;
  goal?: number;
  lastAccrualISO?: string;
}

export interface VaultCard {
  pan: string;
  expiry: string;
  cvv: string;
  frozen: boolean;
  limitPerTx: number;
  limitDaily: number;
}

export interface VaultTxn {
  id: string;
  ts: string;
  amount: number;
  from: string | null;
  to: string | null;
  desc: string;
  category: string;
  method: string;
}

export interface VaultOrder {
  id: string;
  to: string;
  amount: number;
  freq: 'weekly' | 'monthly';
  anchorDay: number;
  nextISO: string;
  desc: string;
  active: boolean;
}

export interface VaultContact {
  name: string;
  sortCode: string;
  accountNumber: string;
}

export interface VaultState {
  v: number;
  name: string;
  createdISO: string;
  pin: { salt: string; hash: string } | null;
  sortCode: string;
  accountNumber: string;
  iban: string;
  accounts: VaultAccount[];
  card: VaultCard;
  crypto?: Record<string, number>;
  roundUpsTo: string | null;
  txns: VaultTxn[];
  orders: VaultOrder[];
  contacts: VaultContact[];
  seq: number;
}

export type PostResult =
  | { state: VaultState; txn: VaultTxn; roundUpTxn?: VaultTxn; error?: undefined; message?: undefined }
  | { error: string; message: string; state?: undefined; txn?: undefined };

export type CryptoTradeResult =
  | { state: VaultState; units?: number; pence?: number; pricePence: number; error?: undefined; message?: undefined }
  | { error: string; message: string; state?: undefined };

export interface CryptoAsset {
  name: string; ticker: string; icon: string; coin: number;
  basePence: number; driftPct: number; volPct: number;
  app: string; chainLS: string; walletsLS: string; blurb: string;
}

export interface VaultEngine {
  fmt(pence: number, opts?: { showPlus?: boolean }): string;
  parseAmount(str: unknown): number | null;
  roundUp(pence: number): number;
  mulberry32(seed: number): () => number;
  luhnValid(pan: string): boolean;
  maskPan(pan: string): string;
  ibanValid(iban: string): boolean;
  isoPlusDays(iso: string, days: number): string;
  nextMonthly(iso: string, anchorDay: number): string;
  openBank(opts: { name: string; rng: () => number; nowISO: string }): VaultState;
  accountById(state: VaultState, id: string): VaultAccount | null;
  balanceOf(state: VaultState, accountId: string): number;
  totalBalance(state: VaultState): number;
  post(state: VaultState, txn: {
    amount: number; from: string | null; to: string | null;
    desc?: string; category?: string; method?: string; ts: string;
  }): PostResult;
  cardPurchase(state: VaultState, amount: number, merchant: string, ts: string): PostResult;
  createPot(state: VaultState, opts: { name: string; goal?: number; aerPct?: number; nowISO: string }): VaultState;
  accrueInterest(state: VaultState, toISO: string): VaultState;
  compact(state: VaultState, keep: number): VaultState;
  addOrder(state: VaultState, opts: {
    to: string; amount: number; freq: 'weekly' | 'monthly'; startISO: string; desc?: string;
  }): VaultState;
  runDueOrders(state: VaultState, nowISO: string): { state: VaultState; posted: VaultTxn[] };
  toCSV(state: VaultState, accountId: string): string;
  CRYPTO: Record<string, CryptoAsset>;
  cryptoPrice(key: string, dayISO: string): number | null;
  cryptoQuote(key: string, dayISO: string): { mid: number; buy: number; sell: number } | null;
  fmtUnits(units: number, coin: number): string;
  cryptoBuy(state: VaultState, key: string, pencePay: number, ts: string): CryptoTradeResult;
  cryptoSell(state: VaultState, key: string, units: number, ts: string): CryptoTradeResult;
  cryptoHoldings(state: VaultState, dayISO: string): {
    assets: Array<{ key: string; name: string; ticker: string; icon: string; coin: number; units: number; price: number; value: number }>;
    total: number;
  };
  chainBalance(chainJSON: unknown, addresses: string[]): number;
}

declare const Vault: VaultEngine;
export default Vault;
