import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Txn, TxnKind } from './types.js';

// --- CSV primitives ---------------------------------------------------------

// Parse one CSV line; handles quoted fields and the standard "" escaped-quote.
export function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (c === ',' && !q) {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function decode(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

// MM/DD/YYYY or MM/DD/YY → YYYY-MM-DD
function isoDate(s: string): string {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return '';
  const [, mm, dd, yy] = m;
  const year = yy.length === 2 ? `20${yy}` : yy;
  return `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

// --- Format detection -------------------------------------------------------

type Format = 'chase-card' | 'chase-checking' | 'etrade' | 'etrade-txn' | 'unknown';

function detectFormat(lines: string[]): { fmt: Format; headerIdx: number } {
  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    const l = lines[i].toLowerCase();
    if (l.includes('transaction date') && l.includes('post date') && l.includes('category')) {
      return { fmt: 'chase-card', headerIdx: i };
    }
    if (l.startsWith('details,') && l.includes('posting date')) {
      return { fmt: 'chase-checking', headerIdx: i };
    }
    if (l.includes('activity/trade date') && l.includes('transaction date')) {
      return { fmt: 'etrade', headerIdx: i };
    }
    // E*TRADE "TransactionDate,TransactionType,Description,Categories,Amount,Balance"
    if (l.includes('transactiondate') && l.includes('transactiontype')) {
      return { fmt: 'etrade-txn', headerIdx: i };
    }
  }
  return { fmt: 'unknown', headerIdx: -1 };
}

// --- Per-format kind classification ----------------------------------------

function chaseCardKind(type: string, amount: number): TxnKind {
  switch (type) {
    case 'Payment': return 'cardpayment';
    case 'Return': return 'refund';
    case 'Adjustment': return amount >= 0 ? 'refund' : 'spend';
    default: return 'spend'; // Sale, Fee
  }
}

const CARD_PAYMENT_RE = /CHASE CREDIT CRD|CAPITAL ONE|DISCOVER\b.*PAYMENT|CRCARDPMT|CARD.*AUTOPAY|E-PAYMENT/i;
const TRANSFER_RE = /MSPBNA|MORGAN STANLEY|BROKERAGE|\bACH TRNSFR\b|BANK\s+TRANSFER|MONEY TO BANK|MONEY TO EXTERNAL|MONEY FROM/i;
const INCOME_RE = /PAYROLL|\bINTEREST\b|FUNDS RECEIVED|DIRECT DEP|REMOTE ONLINE DEPOSIT|CHECK_DEPOSIT/i;

function chaseCheckingKind(desc: string, type: string, amount: number): { kind: TxnKind; p2p: boolean } {
  const p2p = /ZELLE|VENMO|QUICKPAY/i.test(desc) || /QUICKPAY/i.test(type);
  if (CARD_PAYMENT_RE.test(desc)) return { kind: 'cardpayment', p2p: false };
  if (TRANSFER_RE.test(desc)) return { kind: 'transfer', p2p: false };
  if (amount > 0) return { kind: 'income', p2p }; // payroll, deposits, Zelle received
  // Negative: real outflow (bills, P2P sent, ACH debits)
  return { kind: 'spend', p2p };
}

// Works for both E*TRADE export styles: transfers by keyword, otherwise by sign
// (deposits/interest are positive → income; debits/withdrawals negative → spend).
function etradeKind(type: string, amount: number, desc: string): TxnKind {
  if (/transfer/i.test(type) || /transfer/i.test(desc)) return 'transfer';
  return amount > 0 ? 'income' : 'spend';
}

// --- Account naming ---------------------------------------------------------

function accountFromName(path: string): string {
  const b = basename(path);
  const chase = b.match(/Chase(\d{4})/i);
  if (chase) return `Chase …${chase[1]}`;
  return b.replace(/\.csv$/i, '');
}

// Both E*TRADE styles name the account differently; normalize to last-four so
// files for the same account aggregate and de-dupe regardless of export style.
function etradeAccount(lines: string[]): string {
  const forAcct = lines.find(l => /^For Account:/i.test(l));   // "For Account:,#####3770"
  if (forAcct) {
    const m = forAcct.match(/(\d{3,4})\s*$/);
    return `E*TRADE …${m ? m[1] : '????'}`;
  }
  const info = lines.find(l => /Account Activity for/i.test(l)); // "...Checking -3770 from..."
  const m = info?.match(/-(\d{4})\b/);
  return `E*TRADE …${m ? m[1] : '????'}`;
}

// --- Main entry -------------------------------------------------------------

// Parse a single CSV file into unified transactions. Returns [] for an
// unrecognized format so the caller can skip it with a warning.
export function parseFile(path: string): Txn[] {
  const content = readFileSync(path, 'utf-8');
  const lines = content.split(/\r?\n/);
  const { fmt, headerIdx } = detectFormat(lines);
  if (fmt === 'unknown') return [];

  const account = (fmt === 'etrade' || fmt === 'etrade-txn') ? etradeAccount(lines) : accountFromName(path);
  const header = parseLine(lines[headerIdx]).map(h => h.toLowerCase());
  const col = (name: string) => header.findIndex(h => h.includes(name));

  // Per-file dedup key. The occurrence counter (#n) means two genuinely identical
  // same-day rows within ONE file are both kept (#0, #1), but the same rows
  // re-appearing in an overlapping export collide and are dropped by the caller.
  const seen = new Map<string, number>();
  const keyFor = (t: Omit<Txn, 'dedupeKey'>): string => {
    const sig = [t.account, t.date, t.amount.toFixed(2),
      t.rawDescription.replace(/\s+/g, ' ').trim().toUpperCase(),
      t.balance ?? ''].join('|');
    const n = seen.get(sig) ?? 0;
    seen.set(sig, n + 1);
    return `${sig}#${n}`;
  };

  const raw: Omit<Txn, 'dedupeKey'>[] = [];
  const num = (s: string | undefined): number | undefined => {
    const v = parseFloat((s ?? '').replace(/[$,]/g, ''));
    return isNaN(v) ? undefined : v;
  };

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      if (fmt === 'etrade') break; // E*TRADE has a footer after a blank line
      continue;
    }
    const cols = parseLine(line);
    if (cols.length < 3) continue;

    if (fmt === 'chase-card') {
      const date = isoDate(cols[col('transaction date')]);
      const rawDesc = cols[col('description')] ?? '';
      const bankCategory = cols[col('category')] || null;
      const type = cols[col('type')] ?? '';
      const amount = parseFloat(cols[col('amount')]);
      if (!date || isNaN(amount)) continue;
      raw.push({
        date, description: decode(rawDesc), rawDescription: rawDesc, amount,
        bankCategory, type, account, kind: chaseCardKind(type, amount),
      });
    } else if (fmt === 'chase-checking') {
      const date = isoDate(cols[col('posting date')]);
      const rawDesc = cols[col('description')] ?? '';
      const type = cols[col('type')] ?? '';
      const amount = parseFloat(cols[col('amount')]);
      if (!date || isNaN(amount)) continue;
      const { kind, p2p } = chaseCheckingKind(rawDesc, type, amount);
      raw.push({
        date, description: decode(rawDesc), rawDescription: rawDesc, amount,
        bankCategory: null, type, account, kind, p2p, balance: num(cols[col('balance')]),
      });
    } else if (fmt === 'etrade') {
      const date = isoDate(cols[col('transaction date')]);
      const activity = cols[col('activity type')] ?? '';
      const rawDesc = cols[col('description')] ?? '';
      const amount = parseFloat(cols[col('amount')]);
      if (!date || isNaN(amount)) continue;
      raw.push({
        date, description: decode(rawDesc), rawDescription: rawDesc, amount,
        bankCategory: null, type: activity, account, kind: etradeKind(activity, amount, rawDesc),
        balance: num(cols[col('balance')]),
      });
    } else if (fmt === 'etrade-txn') {
      const date = isoDate(cols[col('transactiondate')]);
      const ttype = cols[col('transactiontype')] ?? '';
      const rawDesc = cols[col('description')] ?? '';
      const catRaw = cols[col('categories')] ?? '';
      const amount = num(cols[col('amount')]);
      if (!date || amount === undefined) continue;
      raw.push({
        date, description: decode(rawDesc), rawDescription: rawDesc, amount,
        bankCategory: catRaw && !/unassigned/i.test(catRaw) ? catRaw : null,
        type: ttype, account, kind: etradeKind(ttype, amount, rawDesc),
        balance: num(cols[col('balance')]),
      });
    }
  }

  return raw.map(t => ({ ...t, dedupeKey: keyFor(t) }));
}
