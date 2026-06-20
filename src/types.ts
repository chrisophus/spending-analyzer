// A transaction's role in the cash-flow picture. Only `spend` (minus `refund`)
// counts as real consumption; `cardpayment` and `transfer` are excluded to
// avoid double-counting money that just moves between your own accounts.
export type TxnKind =
  | 'spend'        // real outflow: purchases, fees, P2P payments, bills
  | 'refund'       // returns / reversals — offset spend
  | 'cardpayment'  // paying off a credit card (the spend is counted on the card)
  | 'income'       // payroll, interest, deposits, money received
  | 'transfer'     // internal moves between own accounts / brokerage
  | 'other';

export type SpendClass = 'essential' | 'discretionary' | 'mixed' | 'unknown';

export interface Txn {
  date: string;              // YYYY-MM-DD
  description: string;       // cleaned, human-readable
  rawDescription: string;    // exactly as exported
  amount: number;            // negative = outflow, positive = inflow
  bankCategory: string | null;
  type: string;              // raw type from the export
  account: string;           // derived from filename / file header
  kind: TxnKind;
  p2p?: boolean;             // Zelle / Venmo person-to-person
  balance?: number;          // running balance, when the export provides it
  dedupeKey: string;         // identity for cross-file dedup of overlapping exports
}

export interface RecurringItem {
  merchant: string;
  count: number;
  total: number;             // positive dollars spent
  perMonth: number;
  amounts: number[];
  cls: SpendClass;
  subHint: boolean;          // matched a known-subscription keyword (pre-LLM)
  // --- optional LLM enrichment ---
  whatItIs?: string;
  isSubscription?: boolean;
  discretionary?: boolean;
  recommendation?: string;   // keep / review / cancel + one line
}

export interface CategoryLine {
  category: string;
  total: number;
  perMonth: number;
  cls: SpendClass;
}

export interface MonthLine {
  month: string;             // YYYY-MM
  spend: number;
  income: number;
  net: number;
  byClass: Record<SpendClass, number>;
  cats: Record<string, number>;   // category → spend that month
  partial: boolean;          // first/last month not covering the full calendar month
}

export interface AccountSpan {
  account: string;
  from: string;
  to: string;
  months: number;
}

export interface AnalyzeResult {
  dateMin: string;
  dateMax: string;
  months: number;
  accounts: string[];
  accountSpans: AccountSpan[];
  totalSpend: number;
  spendPerMonth: number;
  income: number;
  incomePerMonth: number;
  cardPayments: number;
  transfers: number;
  byCategory: CategoryLine[];
  byClass: Record<SpendClass, number>;
  byMonth: MonthLine[];
  recurring: RecurringItem[];
  topMerchants: { merchant: string; total: number; count: number; cls: SpendClass }[];
  spendTxns: Txn[];
}
