# Digest glance progress

**Workspace:** `C:\Projects\Life\finance-digest-glance` (sibling of `finance-digest`)  
**Branch:** `feat/digest-glance-a`  
**Merge later:** into `finance-digest` / master after the other agent finishes — do not forget.

## Status

| | |
|---|---|
| **Done** | Audit; **A–E** committed (E=`5c61fce`) |
| **Doing** | Section **F** — outbox actions + Triage (awaiting your review) |
| **Next** | Merge sibling repo into main hub when you’re ready |

## Section F — ready for review (not committed)

- Existing: `markDone`, `markReviewed`, `unsubscribe`, `confirmDate` (verified)
- **New:** `action.triage` → `glance.triageAvailable` + fuller `detail.triage` (overdue first)
- **New:** `action.triage.ack` clears the tray
- Digest UI: Triage button + panel
- Contract docs list all outbox actions

## How to review F

```bash
cd C:\Projects\Life\finance-digest-glance
node tests/section-f-outbox.test.js
node tests/section-e-contract.test.js
```

Say **commit F** when good, then we can plan the merge into `finance-digest`.
