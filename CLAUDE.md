# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                              # install deps
npm run dev -- --dir ~/Downloads         # run from TS source via tsx (no build step)
npm run dev -- --dir ~/Downloads --no-llm  # fully offline, deterministic
npm run build                            # tsc → dist/
npm run start -- --dir ~/Downloads       # run the built dist/index.js
```

There is no test runner, linter, or formatter configured — `dev`, `build`, and `start` are the only scripts. The fastest way to exercise a change end-to-end is `npm run dev -- --dir <folder>` against a folder of CSVs, or `--json` for machine-readable output to diff against.

Useful flags: `--months N` (limit to last N months), `--json` (emit normalized aggregates + transactions, skips report and LLM), `ANALYZER_DEBUG=1` (log model/stop-reason from the LLM call), `ANALYZER_MODEL=...` (override the Claude model).

## Architecture

A read-only pipeline that turns a folder of bank/card CSV exports into a spending report. Data flows in one direction through five modules:

`index.ts` (CLI + orchestration) → `parsers.ts` (CSV → `Txn[]`) → `analyze.ts` (deterministic aggregation → `AnalyzeResult`) → `llm.ts` (optional annotation) → `report.ts` (render). `types.ts` defines the shared `Txn` / `AnalyzeResult` shapes; `overrides.ts` loads user rules consumed by `analyze.ts`.

### The deterministic / LLM boundary (most important invariant)

All dollar math is computed in `analyze.ts` and is fully deterministic. The LLM in `llm.ts` is the *only* non-deterministic component, and it **only annotates** `result.recurring` in place (adds `whatItIs` / `isSubscription` / `discretionary` / `recommendation`) — it never changes a total. Consequences to preserve when editing: `--no-llm` and `--json` produce numbers identical to a normal run, and the report must degrade gracefully when the LLM is absent or fails (the call is wrapped so failures only drop annotations). The LLM receives only recurring merchant names + amounts, never the full transaction history.

### Transaction taxonomy (`TxnKind`)

The cash-flow correctness hinges on `TxnKind` (`types.ts`). Only `spend` minus `refund` counts as consumption. `cardpayment` and `transfer` are deliberately excluded so that paying off a card or moving money between your own accounts isn't double-counted as spending. When adding a parser or classifier, getting `kind` right matters more than any other field — a transfer mislabeled `spend` corrupts every total.

### Adding a new bank/format

Format support lives entirely in `parsers.ts`. Each format needs: (1) a detector branch in `detectFormat` keyed off header signatures, (2) a `kind` classifier (e.g. `chaseCardKind`, `chaseCheckingKind`, `etradeKind`) — Chase card uses an explicit `Type` column; checking and E*TRADE infer kind from keyword regexes (`CARD_PAYMENT_RE`, `TRANSFER_RE`, `INCOME_RE`) and amount sign, and (3) a parse branch in `parseFile` mapping columns into `Txn`. Accounts are normalized to a last-four label so multiple exports of one account aggregate.

### Dedup across overlapping exports

Each `Txn` carries a `dedupeKey` built in `parsers.ts` from account+date+amount+description+balance, with a per-file occurrence counter (`#0`, `#1`) so two genuinely identical same-day rows in one file are both kept. `index.ts` then drops any key already seen in an earlier file, so dropping a whole folder of overlapping date-range exports doesn't double-count.

### Category & class resolution

`categoryOf` (`analyze.ts`) resolves a spend transaction's category in priority order: **user overrides → bank-provided category → keyword inference (`INFER_RULES`, high-confidence essentials only) → P2P/Uncategorized fallback**. Category → `SpendClass` (essential/discretionary/mixed/unknown) comes from the static `CLASS_BY_CATEGORY` table, extendable per-run via override rules carrying a `class`.

`overrides.json` (loaded from the data dir or cwd) exists for payees only the user can interpret — P2P payments (Zelle/Venmo) and cryptic merchants — mapping a description substring to a category. Overrides win over everything, so they also correct miscategorized merchants.

### Per-account month spans

Per-month rates in `analyze.ts` divide each figure by the window the *contributing accounts actually cover* (`acctMonths` / `spanForAccounts`), not the global date range. This prevents understating a monthly bill that appears in only a short export (e.g. a 3-month E*TRADE file alongside a 6-month card export).

## Conventions

- ESM throughout (`"type": "module"`); intra-project imports use explicit `.js` extensions even from `.ts` sources (NodeNext resolution). TypeScript is `strict`.
- Report/progress lines go to `stderr` (`console.error`); only the final report and `--json` payload go to `stdout`, so `--json` output stays clean for piping.
- Real financial data must never be committed: `.env` and `*.csv`/`*.CSV` are gitignored. CSVs are user-supplied at runtime.
