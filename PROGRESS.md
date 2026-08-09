# Digest glance progress

**Workspace:** `C:\Projects\Life\finance-digest-glance` (sibling of `finance-digest`)  
**Branch:** `feat/digest-glance-a`  
**Merge later:** into `finance-digest` / master after the other agent finishes — do not forget.

## Status

| | |
|---|---|
| **Done** | STEP 1 audit; Section **A** committed (`62c84a1`) |
| **Doing** | Section **B** — completion / progress (awaiting your review) |
| **Next** | C → D → E → F |

## Section A — shipped

- Outlook secrets, coverage gaps + `blocksClear`, re-parse change records
- **Trust Google Calendar**; **Canvas fills gaps**

## Section B — ready for review (not committed)

- Topic `reviewed` / task `done` + phone `markReviewed` / `markDone` (already present)
- Lecture → topic reviewed as `inferred` (already present); **clearing inferred now skips re-infer**
- **New:** matching money txn → auto `markBillPaid` (`how: inferred`, reversible via skip + `clearBillPaid`)
- **New:** `signal.confirmation` / `signal.replySent` → close follow-up tasks as inferred
- `markReviewed` with `clear:true` undoes topic review

## Key decisions

1. Calendar wins dates; Canvas fills gaps only.
2. Auto-closes are inferred + reversible (skip list prevents immediate re-close).
3. Work stays in `finance-digest-glance` until final merge.

## How to review B

```bash
cd C:\Projects\Life\finance-digest-glance
node tests/section-b-completion.test.js
node tests/hub-bills.test.js
node tests/hub-m7.test.js
```

Say **commit B** when good, then **go C**.
