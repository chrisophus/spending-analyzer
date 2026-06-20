# spending-analyzer

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A small, read-only CLI that turns bank / credit-card **CSV exports** into a spending report:

- **Cash flow** — total spending vs. income, and whether you're net positive or drawing down savings.
- **Discretionary vs. essential** — needs vs. wants, by dollar and percent.
- **Spending by category** — using the categories the banks already provide.
- **Monthly trend** — spend / essential / discretionary / net per month, plus a top-category-by-month matrix to spot spikes (a renovation month, a big trip).
- **Recurring charges & subscription audit** — every repeating merchant, with an optional Claude pass that identifies cryptic merchants ("what *is* BOING US HOLDCO?") and gives a keep / review / cancel recommendation.

No Actual Budget, no server, no database. Point it at a folder of CSVs and read the report.

## Why this exists

It's the standalone descendant of an earlier "import into Actual Budget" tool. It turned out the goal was never to manage a budgeting app — it was just to **understand spending and find subscriptions worth cutting**. That needs nothing but the CSVs and a few hundred lines of analysis.

## Install

```bash
npm install
```

## Usage

```bash
# Analyze every CSV in a folder (e.g. your Downloads)
npm run dev -- --dir ~/Downloads

# Skip the LLM pass — fully offline, deterministic, no API key needed
npm run dev -- --dir ~/Downloads --no-llm

# Build a standalone binary
npm run build && node dist/index.js --dir ~/Downloads
```

### Options

| Flag | Meaning |
|------|---------|
| `--dir <folder>` | Folder to scan for `.csv` files (default: current directory) |
| `--months <n>` | Only analyze the last N months of activity (e.g. `--months 3`) |
| `--no-llm` | Skip the Claude enrichment pass |
| `-h, --help` | Show help |

Per-month rates divide each figure by the window the **contributing account actually covers**, not the global window — so a monthly utility bill that only appears in a short E\*TRADE export isn't understated. The report header shows each account's coverage and flags any that are shorter than the rest.

## Supported exports

| Bank / format | Auto-detected by |
|---|---|
| Chase credit card activity | header `Transaction Date, Post Date, …, Category, Type, Amount` |
| Chase checking activity | header `Details, Posting Date, …` |
| E\*TRADE transaction history | `Account Activity for …` + `Activity/Trade Date` header |

Unrecognized files are skipped with a warning, so you can drop a whole folder in and it only reads what it understands. Adding a new bank = one parser branch in `src/parsers.ts`.

## How the numbers are kept honest

- **Card payments and internal transfers are excluded** from "spending" — paying off a card or moving money to your brokerage isn't consumption, and counting it would double-count.
- **Refunds offset spend.**
- **Recurring detection** groups by a normalized merchant name (store numbers and transaction codes stripped) and surfaces anything that repeats 3+ times, or matches a known-subscription keyword.
- The **LLM only annotates** — it never changes the dollar math. Run `--no-llm` and every total is identical.

## Overrides (labeling payees only you can interpret)

Person-to-person payments (Zelle/Venmo) and cryptic merchants can't be categorized automatically — only you know that a recurring Zelle is child support, rent, or a side-gig payout. Drop an `overrides.json` in your data folder (or the working directory):

```json
{
  "version": 1,
  "rules": [
    { "match": "zelle payment to jane doe", "category": "Child Support" },
    { "match": "venmo", "category": "Reimbursements", "class": "mixed" }
  ]
}
```

- `match` — case-insensitive substring of the transaction description.
- `category` — the bucket it goes in. Known essentials (`Child Support`, `Childcare`, `Rent`, `Mortgage & Loans`, `Taxes`, `Insurance`, `Bills & Utilities`, …) classify automatically.
- `class` — optional; only needed for a brand-new category the tool doesn't know (`essential` | `discretionary` | `mixed`).

Overrides win over everything else, so they're also handy for correcting a miscategorized merchant.

## The LLM pass (optional)

Set `ANTHROPIC_API_KEY` (env or a `.env` file — see `.env.example`). It sends only the *recurring merchant names + amounts* (not your full transaction history) to Claude and gets back, per merchant: a plain-English identification, whether it's a subscription, whether it's discretionary, and a one-line recommendation. Override the model with `ANALYZER_MODEL`.

## Privacy

Your CSVs never leave your machine except, if you enable it, the recurring-merchant summary sent to the Anthropic API. `*.csv` / `*.CSV` are gitignored so financial data is never committed.

## License

[MIT](LICENSE) © 2026 Chris Cason
