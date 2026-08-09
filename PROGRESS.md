# Digest glance progress

**Workspace:** `C:\Projects\Life\finance-digest`
**Branch:** `master`

## Status

| | |
|---|---|
| **Done** | Audit; **A–F committed and integrated into main** |
| **Doing** | Verification complete |
| **Next** | Address the unrelated `duplicates.test.js` failure when desired |

## Section F — committed and integrated

- Existing: `markDone`, `markReviewed`, `unsubscribe`, `confirmDate` (verified)
- **New:** `action.triage` → `glance.triageAvailable` + fuller `detail.triage` (overdue first)
- **New:** `action.triage.ack` clears the tray
- Digest UI: Triage button + panel
- Contract docs list all outbox actions

## Verification

```bash
cd C:\Projects\Life\finance-digest
npm test
```

All A–F, calendar/life, budget, bills, cashflow, and Money bridge tests pass.
The full suite currently stops at the pre-existing duplicate-import assertion:
`tests/duplicates.test.js:91` expected `1957.9`, received `0`.
