import chalk from 'chalk';
import type { AnalyzeResult, SpendClass } from './types.js';

const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
const kfmt = (n: number) => n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'k' : n > 0 ? '$' + n.toFixed(0) : '·';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monLabel = (ym: string) => MONTHS[parseInt(ym.slice(5, 7), 10) - 1] ?? ym;

const CLASS_COLOR: Record<SpendClass, (s: string) => string> = {
  essential: chalk.green,
  discretionary: chalk.yellow,
  mixed: chalk.cyan,
  unknown: chalk.dim,
};

function bar(frac: number, width = 24): string {
  const n = Math.max(0, Math.min(width, Math.round(frac * width)));
  return '█'.repeat(n) + chalk.dim('░'.repeat(width - n));
}

export function printReport(r: AnalyzeResult): void {
  const hr = chalk.dim('─'.repeat(60));
  console.log('\n' + chalk.bold('💰  Spending Analysis'));
  console.log(`${r.dateMin} → ${r.dateMax}  ${chalk.dim(`(${r.months.toFixed(1)} months)`)}`);
  console.log(chalk.dim('Account coverage:'));
  const fullSpan = Math.max(...r.accountSpans.map(s => s.months), 0);
  for (const s of r.accountSpans) {
    const short = s.months < fullSpan - 0.5 ? chalk.yellow(`  ⚠ only ${s.months.toFixed(1)}mo — per-month rates use this window`) : '';
    console.log(chalk.dim(`  ${s.account.padEnd(20)} ${s.from} → ${s.to}  (${s.months.toFixed(1)}mo)`) + short);
  }

  // ── Cash flow ──────────────────────────────────────────────────────────
  console.log('\n' + chalk.bold('Cash flow') + '\n' + hr);
  const net = r.income - r.totalSpend;
  console.log(`  Spending        ${chalk.bold(money(r.totalSpend))}   ${chalk.dim(money0(r.spendPerMonth) + '/mo')}`);
  console.log(`  Income          ${money(r.income)}   ${chalk.dim(money0(r.incomePerMonth) + '/mo')}`);
  const netStr = net >= 0
    ? chalk.green(`+${money(net)}`)
    : chalk.red(money(net));
  console.log(`  Net             ${netStr}   ${chalk.dim(money0(net / r.months) + '/mo')}`);
  if (net < 0) {
    console.log(chalk.red(`  ⚠  Spending exceeds income by ${money0(-net / r.months)}/mo — funded by drawing down savings/brokerage or new debt.`));
  }
  console.log(chalk.dim(`  (excluded: ${money0(r.cardPayments)} card payments, ${money0(r.transfers)} internal transfers — not spending)`));

  // ── Discretionary vs essential ─────────────────────────────────────────
  console.log('\n' + chalk.bold('Discretionary vs. essential') + '\n' + hr);
  const order: SpendClass[] = ['essential', 'discretionary', 'mixed', 'unknown'];
  const label: Record<SpendClass, string> = {
    essential: 'Essential (needs)', discretionary: 'Discretionary (wants)',
    mixed: 'Mixed', unknown: 'Uncategorized',
  };
  for (const c of order) {
    const v = r.byClass[c];
    if (v <= 0) continue;
    const frac = v / r.totalSpend;
    console.log(`  ${CLASS_COLOR[c](label[c].padEnd(22))} ${bar(frac)} ${money0(v).padStart(10)}  ${(frac * 100).toFixed(0)}%`);
  }

  // ── Monthly trend ───────────────────────────────────────────────────────
  if (r.byMonth.length > 1) {
    console.log('\n' + chalk.bold('Monthly trend') + chalk.dim('   (★ = partial month)') + '\n' + hr);
    const maxSpend = Math.max(...r.byMonth.map(m => m.spend), 1);
    console.log(chalk.dim('  Month       Spend   Essential  Discret.       Net'));
    for (const m of r.byMonth) {
      const tag = m.partial ? chalk.yellow('★') : ' ';
      const netStr = m.net >= 0 ? chalk.green(money0(m.net).padStart(9)) : chalk.red(money0(m.net).padStart(9));
      console.log(
        `  ${m.month}${tag} ${money0(m.spend).padStart(9)}  ${chalk.green(money0(m.byClass.essential).padStart(8))}  ${chalk.yellow(money0(m.byClass.discretionary).padStart(8))}  ${netStr}  ${bar(m.spend / maxSpend, 12)}`,
      );
    }

    // Top-category trend matrix — spot spikes (e.g. a renovation month)
    console.log('');
    console.log(chalk.dim('  ' + 'Category'.padEnd(18) + r.byMonth.map(m => monLabel(m.month).padStart(7)).join('')));
    for (const c of r.byCategory.slice(0, 6)) {
      const row = r.byMonth.map(m => kfmt(m.cats[c.category] ?? 0).padStart(7)).join('');
      console.log('  ' + chalk.bold(c.category.slice(0, 18).padEnd(18)) + chalk.dim(row));
    }
  }

  // ── By category ────────────────────────────────────────────────────────
  console.log('\n' + chalk.bold('Spending by category') + '\n' + hr);
  for (const c of r.byCategory) {
    const tag = CLASS_COLOR[c.cls]('●');
    console.log(`  ${tag} ${c.category.padEnd(24)} ${money(c.total).padStart(12)}  ${chalk.dim(money0(c.perMonth).padStart(7) + '/mo')}  ${chalk.dim((c.total / r.totalSpend * 100).toFixed(0) + '%')}`);
  }

  // ── Recurring / subscriptions ──────────────────────────────────────────
  console.log('\n' + chalk.bold('Recurring charges & subscriptions') + '\n' + hr);
  const enriched = r.recurring.some(x => x.recommendation);
  // "Subscription" total counts true subscriptions only — after the LLM pass use
  // its judgement; otherwise fall back to the keyword heuristic (so groceries,
  // gas and airlines don't get counted as subscriptions).
  const isSub = (x: typeof r.recurring[number]) =>
    enriched ? x.isSubscription === true : x.subHint;
  const subsTotal = r.recurring.filter(isSub).reduce((s, x) => s + x.perMonth, 0);
  const shown = r.recurring.slice(0, 30);
  for (const x of shown) {
    const star = isSub(x) ? chalk.yellow('★') : ' ';
    const head = `  ${star} ${chalk.bold(x.merchant.padEnd(26))} ${money0(x.perMonth).padStart(6)}/mo  ${chalk.dim(`${x.count}× · ${money0(x.total)}`)}`;
    console.log(head);
    if (enriched && x.whatItIs) {
      const flag = x.discretionary === false ? chalk.green('essential')
        : x.isSubscription ? chalk.yellow('subscription') : chalk.dim('frequent merchant');
      console.log(chalk.dim(`       ${x.whatItIs}`) + `  [${flag}]`);
      if (x.recommendation) console.log(chalk.dim(`       → ${x.recommendation}`));
    }
  }
  if (r.recurring.length > shown.length) {
    console.log(chalk.dim(`  …and ${r.recurring.length - shown.length} more recurring merchants`));
  }
  console.log(chalk.bold(`\n  ★ Subscriptions/memberships total: ~${money0(subsTotal)}/mo  (~${money0(subsTotal * 12)}/yr)`));
  if (!enriched) {
    console.log(chalk.dim('  (run without --no-llm and with ANTHROPIC_API_KEY for merchant IDs & cancel advice)'));
  }

  // ── Top merchants ──────────────────────────────────────────────────────
  console.log('\n' + chalk.bold('Top 15 merchants by total spend') + '\n' + hr);
  for (const m of r.topMerchants) {
    console.log(`  ${CLASS_COLOR[m.cls]('●')} ${m.merchant.padEnd(28)} ${money(m.total).padStart(12)}  ${chalk.dim(m.count + '×')}`);
  }
  console.log('');
}
