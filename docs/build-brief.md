# Build brief — personal finance + digest system

**You are an agent building a personal, offline-first, cross-device system. Build Milestone 1 completely and runnably, scaffold the repo for later milestones, then STOP and wait for review. Do not build milestones 2+ until told.**

## Product in one paragraph

Two HTML apps on one shared engine: a **Money tracker** (net worth, budget, money nudges) and a **Daily Digest** (reminders, reading, junk-clearing). A **laptop Node hub** is the source of truth — it holds secrets, runs the connectors, keeps the encrypted database, and serves the HTML UI at `localhost`. A **phone (an Android WebView shell called Shelf)** is a thin collector that pushes data up. The engine is **rules-first**; AI is optional and gated. This brief covers **Milestone 1 only** (the money review loop) and sets up the repo for the rest.

## Non-negotiable constraints

- **Offline-first.** Everything in Milestone 1 works with the network fully disconnected. No external calls, no CDNs — vendor any assets locally.
- **Rules-first, deterministic. No AI in Milestone 1.**
- **No secrets in `localStorage` or JS globals.**
- **User stays at the commit step.** Nothing mutates a record without an explicit click.
- **Minimal dependencies. No heavy framework.** Vanilla HTML/CSS/JS for the UI. Keep the UI code portable so it can later run unchanged inside an Android WebView.

## Tech

- Milestone 1 front-end: a single self-contained `money.html` — no build step, opens directly in a browser.
- Later hub (do not build yet): Node (bare `http` or Express) serving the same HTML at `localhost`, with encrypted SQLite (`better-sqlite3`; use SQLCipher for at-rest encryption).

## Repo structure

```text
finance-digest/
  apps/
    money/money.html
    digest/.gitkeep
  engine/
    model.js
    rules.js
  hub/.gitkeep
  sample-data/transactions.json
  docs/
    build-brief.md
    phone-hub-contract.md
```

## The data model

Every transaction resolves to `{ account, direction, category }`.

- **Account** — where value sits. Typed: `cash` | `investment` | `liability` | `external`.
- **Direction** — `in` (income) | `out` (expense) | `transfer` (between the user's own accounts, or settling an external balance). **Transfers are excluded from income and spending totals.**
- **Category** — only `in` and `out` get one, via a merchant→category rules table. Transfers never get a category.

**External accounts** are a `liability` sub-type:

- An expense on an external account records spending in its category **and increases what's owed**. It does **not** change any cash/investment balance.
- A reimbursement is a `transfer` from a cash account → the external account: cash down, owed down. Net worth is unchanged.

**Snapshot math:**

- `netWorth = Σ cash + Σ investment − Σ liabilities(incl. external owed)`
- `liquid = Σ cash`; `invested = Σ investment`
- `savingsRate = (income − expenses) / income` over the period, transfers excluded.
- `recurringMonthly` = detect same merchant + similar amount recurring ~monthly.
- `runwayMonths = liquid / avg monthly expenses`
- `owed` = external accounts' running balances (charges − reimbursements).

**Safe-to-spend (pay-period cashflow):**

Detect recurring **income** and **expense** streams from transactions (weekly /
biweekly / monthly cadences). The horizon is **last payday → next payday**
(calendar week if income cadence is unknown). Overlapping bills and charges that
fall inside that window count even when their own cycle started earlier.

`safeToSpend = periodIncome − commitmentsInHorizon − savingsForHorizon − variableSpentSincePayday`

- `periodIncome` = income already received this pay period + income still expected before next payday
- `commitmentsInHorizon` = recurring charges and standing bills due in the window
- `savingsForHorizon` = `weeklySavingsTarget × (horizonDays / 7)`
- `variableSpentSincePayday` = non-recurring outflows since the last payday

No manual weekly/monthly income reference — income comes from the transaction stream.

## Milestone 1 — the money review loop

Goal: prove the review loop feels good with fake data and **zero backend**.

1. Generate `sample-data/transactions.json` (~25 rows) covering a paycheck, ordinary expenses, checking → savings, a Vanguard buy, ambiguous Venmo, an external parents'-card expense, a reimbursement, and recurring charges. Raw fields: `{ id, date, rawMerchant, amount, account }`.
2. Normalize and auto-type each row into `{ id, account, accountType, direction, category, merchant, amount, date, needsReview }`. Auto-type payroll as income, known own-account moves as transfers, and ordinary purchases as expenses. Flag ambiguous rows rather than guessing.
3. Categorize `in`/`out` rows using an editable merchant-substring → category table in `rules.js`. Unmatched rows become `uncategorized`.
4. Compute the snapshot live and deterministically.
5. Compute safe-to-spend for the current week and render it prominently.
6. Render a dense review table with editable direction and category. Highlight review rows and recompute immediately after edits.
7. Show the external parents'-card account separately with its owed balance, excluded from cash/investment and reflected in net worth as a liability.

Keep it one screen, dense, and skimmable. Persist edits in memory only.

## Acceptance test

- A checking → savings transfer changes neither income nor spending.
- The Vanguard buy is a transfer, not spending.
- The parents'-card expense appears in spending by category, does not change cash/investment, and lowers net worth through owed liability.
- A reimbursement reduces owed and leaves net worth unchanged.
- Retyping ambiguous Venmo from expense → transfer updates net worth and savings rate immediately.
- The entire app works with the network disconnected.

## After Milestone 1 — STOP

Report what was built and exactly how to run it. **Do not** start the hub, connectors, OAuth, sync, or AI until instructed.

- **M2** — Node hub and encrypted SQLite.
- **M3** — Phone→hub outbox merge.
- **M4** — Connectors.
- **M5** — Digest app.
- **M6** — Optional gated AI.

The full future phone ↔ hub appendix is preserved in `phone-hub-contract.md`.
