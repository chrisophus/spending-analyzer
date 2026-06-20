import type { Txn, AnalyzeResult, SpendClass, RecurringItem, CategoryLine } from './types.js';
import type { OverrideRule } from './overrides.js';

// --- Discretionary vs. essential mapping (from bank-provided categories) ----

const CLASS_BY_CATEGORY: Record<string, SpendClass> = {
  'Groceries': 'essential',
  'Gas': 'essential',
  'Bills & Utilities': 'essential',
  'Health & Wellness': 'essential',
  'Automotive': 'essential',
  'Mortgage & Loans': 'essential',  // inferred (banks rarely categorize these)
  'Taxes': 'essential',             // inferred
  'Insurance': 'essential',         // inferred
  'Child Support': 'essential',     // court-ordered obligation (set via overrides)
  'Childcare': 'essential',         // (set via overrides)
  'Rent': 'essential',              // (set via overrides)
  'Food & Drink': 'discretionary',
  'Travel': 'discretionary',
  'Shopping': 'discretionary',
  'Entertainment': 'discretionary',
  'Personal': 'discretionary',
  'Gifts & Donations': 'discretionary',
  'Home': 'mixed',                  // repairs (essential) vs. decor/garden (want)
  'Professional Services': 'mixed',
  'Fees & Adjustments': 'mixed',
};

export function classify(cat: string | null): SpendClass {
  if (!cat) return 'unknown';
  return CLASS_BY_CATEGORY[cat] ?? 'unknown';
}

// Infer a category from the description for lines the bank left uncategorized
// (notably E*TRADE, which tags everything "Unassigned"). High-confidence
// essentials only — we'd rather leave something 'Uncategorized' than mislabel a
// discretionary buy as a need. Ordered: first match wins.
const INFER_RULES: [RegExp, string][] = [
  [/MORTGAGE|\bMTGE\b|LOAN PAYMT|LOAN ADM|\bLOAN\b|DIAMOND PMT/i, 'Mortgage & Loans'],
  [/DEPT.*REVENUE|TAXPAYMENT|TAX PYMT|FRANCHISE TAX|\bIRS\b/i, 'Taxes'],
  [/INSURANCE|GEICO|STATE FARM|ALLSTATE|PROGRESSIVE|LIBERTY MUT|FARMERS INS|NATIONWIDE/i, 'Insurance'],
  [/XCEL|PSCO|\bENERGY\b|ELECTRIC|\bUTILITY\b|\bWATER\b|SEWER|COMCAST|XFINITY|CENTURYLINK|VERIZON|WIRELESS|T-MOBILE|AT&T|WASTE M|GARBAGE|TRASH|CONSOLIDATED MUT/i, 'Bills & Utilities'],
];

export function inferCategory(description: string): string | null {
  for (const [re, cat] of INFER_RULES) if (re.test(description)) return cat;
  return null;
}

// Resolve the category for a spend transaction: user overrides first (you know
// best), then bank-provided, then keyword inference, then a P2P / Uncategorized
// fallback.
export function categoryOf(
  t: { bankCategory: string | null; description: string; p2p?: boolean },
  overrides: OverrideRule[] = [],
): string {
  const d = t.description.toLowerCase();
  for (const r of overrides) if (d.includes(r.match.toLowerCase())) return r.category;
  return t.bankCategory ?? inferCategory(t.description) ?? (t.p2p ? 'P2P / Transfers-out' : 'Uncategorized');
}

// --- Merchant normalization (for grouping repeats) --------------------------

export function normMerchant(desc: string): string {
  let d = desc.replace(/&amp;/g, '&').toUpperCase().replace(/\*/g, ' ');
  // Drop bank reference IDs (PPD ID:, WEB ID:, etc.) and anything after them.
  d = d.replace(/\b(PPD|WEB|ARC|CKCD)\s*ID:.*/i, '');
  // Drop "#1522"-style store numbers.
  d = d.replace(/#\s*\d+/g, ' ');
  // Drop alphanumeric transaction codes (contain both a letter and a digit).
  d = d.replace(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,}\b/g, ' ');
  // Drop standalone runs of 2+ digits (store/ref numbers) WITHOUT truncating the
  // rest — so "123 TAKE 5 CAR WASH" keeps its name instead of vanishing.
  d = d.replace(/\b\d{2,}\b/g, ' ');
  return d.replace(/\s+/g, ' ').trim();
}

// Merchants that are subscriptions/memberships even at low occurrence counts.
const SUB_HINTS = [
  'CLAUDE', 'ANTHROPIC', 'ELEVENLABS', 'NUULY', 'MOVEMENT', 'WM.COM', 'BOING',
  'NYTIMES', 'FREE PRESS', 'PEACOCK', 'GOOGLE', 'KINDLE', 'PRIME', 'EVERNOTE',
  'LASTPASS', 'APPLE.COM/BILL', 'CAR WASH', 'TAKE', 'WHISTLE', 'SANDBOXX',
  'NETFLIX', 'SPOTIFY', 'HULU', 'DISNEY', 'YOUTUBE', 'PATREON', 'SUBSTACK',
  'MEMBERSHIP', 'SUBSCRIPTION', 'VAGARO', 'ZELLE PAYMENT TO',
];

// --- Core analysis ----------------------------------------------------------

export function analyze(txns: Txn[], overrides: OverrideRule[] = []): AnalyzeResult {
  // Class lookup, extended with any custom categories defined in overrides.
  const customCls = new Map(overrides.filter(r => r.class).map(r => [r.category, r.class!]));
  const classOf = (cat: string): SpendClass => CLASS_BY_CATEGORY[cat] ?? customCls.get(cat) ?? 'unknown';
  const catOf = (t: Txn) => categoryOf(t, overrides);

  const dated = txns.filter(t => t.date).sort((a, b) => a.date.localeCompare(b.date));
  const dateMin = dated[0]?.date ?? '';
  const dateMax = dated[dated.length - 1]?.date ?? '';
  const days = (Date.parse(dateMax) - Date.parse(dateMin)) / 86_400_000 || 1;
  const months = Math.max(days / 30.44, 0.1);

  const accounts = [...new Set(txns.map(t => t.account))];

  // Per-account date spans. Per-month rates divide by the window each account
  // actually covers (e.g. a 3-month E*TRADE export vs a 6-month card export)
  // rather than the global window, which would understate sparsely-covered
  // accounts (a monthly utility bill present in only 3 of 6 months).
  const acctDates = new Map<string, { min: string; max: string }>();
  for (const t of dated) {
    const a = acctDates.get(t.account);
    if (!a) acctDates.set(t.account, { min: t.date, max: t.date });
    else { if (t.date < a.min) a.min = t.date; if (t.date > a.max) a.max = t.date; }
  }
  const acctMonths = new Map<string, number>();
  for (const [a, d] of acctDates) {
    acctMonths.set(a, Math.max((Date.parse(d.max) - Date.parse(d.min)) / 86_400_000 / 30.44, 0.5));
  }
  const spanForAccounts = (accts: Iterable<string>): number => {
    let m = 0;
    for (const a of accts) m = Math.max(m, acctMonths.get(a) ?? months);
    return m || months;
  };
  const accountSpans = [...acctDates.entries()]
    .map(([account, d]) => ({ account, from: d.min, to: d.max, months: acctMonths.get(account)! }))
    .sort((a, b) => a.account.localeCompare(b.account));

  const spendTxns = txns.filter(t => t.kind === 'spend' || t.kind === 'refund');
  const totalSpend = -spendTxns.reduce((s, t) => s + t.amount, 0); // spend negative, refund positive
  const income = txns.filter(t => t.kind === 'income').reduce((s, t) => s + t.amount, 0);
  const cardPayments = txns.filter(t => t.kind === 'cardpayment').reduce((s, t) => s + Math.abs(t.amount), 0);
  const transfers = txns.filter(t => t.kind === 'transfer').reduce((s, t) => s + Math.abs(t.amount), 0);

  // By category
  const catMap = new Map<string, { total: number; accts: Set<string> }>();
  for (const t of spendTxns) {
    const c = catOf(t);
    let e = catMap.get(c);
    if (!e) { e = { total: 0, accts: new Set() }; catMap.set(c, e); }
    e.total += -t.amount;
    e.accts.add(t.account);
  }
  const byCategory: CategoryLine[] = [...catMap.entries()]
    .map(([category, e]) => ({ category, total: e.total, perMonth: e.total / spanForAccounts(e.accts), cls: classOf(category) }))
    .sort((a, b) => b.total - a.total);

  // By class
  const byClass: Record<SpendClass, number> = { essential: 0, discretionary: 0, mixed: 0, unknown: 0 };
  for (const c of byCategory) byClass[c.cls] += c.total;

  // Recurring detection
  const groups = new Map<string, Txn[]>();
  for (const t of spendTxns) {
    if (t.amount >= 0) continue; // ignore refunds in recurring
    const key = normMerchant(t.description);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  const recurring: RecurringItem[] = [];
  for (const [merchant, items] of groups) {
    const isHint = SUB_HINTS.some(h => merchant.includes(h));
    if (items.length < 3 && !(isHint && items.length >= 2)) continue;
    const amounts = items.map(t => -t.amount);
    const total = amounts.reduce((s, a) => s + a, 0);
    const accts = new Set(items.map(t => t.account));
    recurring.push({
      merchant, count: items.length, total, perMonth: total / spanForAccounts(accts), amounts,
      cls: classOf(catOf(items[0])), subHint: isHint,
    });
  }
  recurring.sort((a, b) => b.total - a.total);

  // Top merchants overall
  const topMerchants = [...groups.entries()]
    .map(([merchant, items]) => ({
      merchant, count: items.length,
      total: -items.reduce((s, t) => s + t.amount, 0),
      cls: classOf(catOf(items[0])),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 15);

  // Monthly trend
  type Bucket = { spend: number; income: number; cats: Map<string, number>; cls: Record<SpendClass, number> };
  const monthMap = new Map<string, Bucket>();
  const bucket = (m: string): Bucket => {
    let b = monthMap.get(m);
    if (!b) { b = { spend: 0, income: 0, cats: new Map(), cls: { essential: 0, discretionary: 0, mixed: 0, unknown: 0 } }; monthMap.set(m, b); }
    return b;
  };
  for (const t of txns) {
    if (!t.date) continue;
    const b = bucket(t.date.slice(0, 7));
    if (t.kind === 'income') b.income += t.amount;
    else if (t.kind === 'spend' || t.kind === 'refund') {
      b.spend += -t.amount;
      const cat = catOf(t);
      b.cats.set(cat, (b.cats.get(cat) ?? 0) - t.amount);
      b.cls[classOf(cat)] += -t.amount;
    }
  }
  const sortedMonths = [...monthMap.keys()].sort();
  const isMonthEnd = (iso: string): boolean => {
    const [y, m, d] = iso.split('-').map(Number);
    return d === new Date(y, m, 0).getDate(); // day 0 of next month = last day of this one
  };
  const byMonth = sortedMonths.map(month => {
    const b = monthMap.get(month)!;
    const isFirst = month === sortedMonths[0];
    const isLast = month === sortedMonths[sortedMonths.length - 1];
    const partial =
      (isFirst && dateMin.slice(8) !== '01') ||
      (isLast && !isMonthEnd(dateMax));
    return {
      month, spend: b.spend, income: b.income, net: b.income - b.spend,
      byClass: b.cls, cats: Object.fromEntries(b.cats), partial,
    };
  });

  return {
    dateMin, dateMax, months, accounts, accountSpans,
    totalSpend, spendPerMonth: totalSpend / months,
    income, incomePerMonth: income / months,
    cardPayments, transfers,
    byCategory, byClass, byMonth, recurring, topMerchants, spendTxns,
  };
}
