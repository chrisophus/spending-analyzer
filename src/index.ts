import 'dotenv/config';
import { parseArgs } from 'node:util';
import { readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import chalk from 'chalk';

import { parseFile } from './parsers.js';
import { analyze } from './analyze.js';
import { loadOverrides } from './overrides.js';
import { enrichWithLLM } from './llm.js';
import { printReport } from './report.js';
import type { Txn } from './types.js';

function parseCli() {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string', default: '.' },
      months: { type: 'string' },           // limit to the last N months
      'no-llm': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },  // emit normalized data as JSON
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  return values;
}

const HELP = `
spending-analyzer — turn bank/credit-card CSV exports into a spending report.

Usage:
  spending-analyzer --dir <folder> [--no-llm]

Options:
  --dir <folder>   Folder containing CSV exports (default: current dir)
  --months <n>     Only analyze the last N months of activity
  --no-llm         Skip the Claude pass (merchant IDs / cancel advice)
  -h, --help       Show this help

Supported exports: Chase credit-card activity, Chase checking activity,
E*TRADE transaction history. Unrecognized files are skipped with a warning.
The LLM pass needs ANTHROPIC_API_KEY (in env or a .env file); without it the
report still runs, just without merchant identification.
`;

async function main(): Promise<void> {
  const args = parseCli();
  if (args.help) { console.log(HELP); return; }

  const dir = resolve(args.dir as string);
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => /\.csv$/i.test(f)).map(f => resolve(dir, f));
  } catch {
    console.error(chalk.red(`Cannot read directory: ${dir}`));
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(chalk.red(`No CSV files found in ${dir}`));
    process.exit(1);
  }

  const txns: Txn[] = [];
  const seen = new Set<string>();
  let dupes = 0;
  for (const f of files) {
    let parsed: Txn[] = [];
    try { parsed = parseFile(f); } catch (e) {
      console.warn(chalk.yellow(`  ⚠ skip ${basename(f)} — parse error: ${(e as Error).message}`));
      continue;
    }
    if (parsed.length === 0) {
      console.warn(chalk.dim(`  ⚠ skip ${basename(f)} — unrecognized format`));
      continue;
    }
    // Drop transactions already seen in an earlier file (overlapping date ranges).
    let kept = 0;
    for (const t of parsed) {
      if (seen.has(t.dedupeKey)) { dupes++; continue; }
      seen.add(t.dedupeKey);
      txns.push(t);
      kept++;
    }
    const dropped = parsed.length - kept;
    const dupNote = dropped > 0 ? chalk.yellow(` (${dropped} duplicate${dropped === 1 ? '' : 's'} skipped)`) : '';
    console.error(chalk.dim(`  ✓ ${basename(f)} — ${kept} transactions (${parsed[0].account})`) + dupNote);
  }
  if (dupes > 0) {
    console.error(chalk.dim(`  → ${dupes} overlapping transaction(s) de-duplicated across files`));
  }

  if (txns.length === 0) {
    console.error(chalk.red('No transactions parsed from any recognized file.'));
    process.exit(1);
  }

  // --months N: keep only transactions within N months of the most recent one.
  let scoped = txns;
  const monthsArg = args.months !== undefined ? Number(args.months) : undefined;
  if (monthsArg !== undefined) {
    if (!Number.isFinite(monthsArg) || monthsArg <= 0) {
      console.error(chalk.red(`--months must be a positive number (got "${args.months}")`));
      process.exit(1);
    }
    const maxIso = txns.reduce((m, t) => (t.date > m ? t.date : m), '');
    const d = new Date(maxIso + 'T00:00:00');
    d.setMonth(d.getMonth() - monthsArg);
    const cutoff = d.toISOString().slice(0, 10);
    scoped = txns.filter(t => t.date >= cutoff);
    console.error(chalk.dim(`  ✓ limited to last ${monthsArg} month(s): ${cutoff} → ${maxIso} (${scoped.length} of ${txns.length} transactions)`));
  }

  // overrides.json (in the data folder or cwd) lets you label payees only you
  // can interpret — e.g. a Zelle recipient → "Child Support".
  const overrides = loadOverrides([dir, process.cwd()]);
  if (overrides.length > 0) {
    console.error(chalk.dim(`  ✓ applied ${overrides.length} category override(s) from overrides.json`));
  }
  const result = analyze(scoped, overrides);

  // --json: emit the normalized data (aggregates + every transaction) for
  // programmatic use or ad-hoc querying. Skips the pretty report and LLM.
  if (args.json) {
    const { spendTxns, ...rest } = result;
    process.stdout.write(JSON.stringify({ ...rest, transactions: scoped }));
    return;
  }

  const useLlm = !args['no-llm'] && !!process.env.ANTHROPIC_API_KEY;
  if (useLlm) {
    process.stdout.write(chalk.dim('  …asking Claude to identify recurring charges\r'));
    try {
      await enrichWithLLM(result, process.env.ANTHROPIC_API_KEY!);
    } catch (e) {
      console.warn(chalk.yellow(`  ⚠ LLM enrichment failed (${(e as Error).message}) — showing report without it.`));
    }
  } else if (!args['no-llm']) {
    console.warn(chalk.dim('  (no ANTHROPIC_API_KEY — skipping merchant identification; use --no-llm to silence)'));
  }

  printReport(result);
}

main().catch(err => {
  console.error(chalk.red('\nError:'), err);
  process.exit(1);
});
