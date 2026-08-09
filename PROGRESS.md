# Digest glance progress

**Workspace:** `C:\Projects\Life\finance-digest-glance` (sibling of `finance-digest`)  
**Branch:** `feat/digest-glance-a`  
**Merge later:** into `finance-digest` / master after the other agent finishes — do not forget.

## Status

| | |
|---|---|
| **Done** | Audit; **A** (`62c84a1`); **B** (`f89ada0`) |
| **Doing** | Section **C** — derived values (awaiting your review) |
| **Next** | D → E → F |

## Section C — ready for review (not committed)

- `done`/`total` readiness integers on examHorizon + studyNext
- `examHorizon` ranked by proximity (then weight); `when` uses weekday through 7 days (`Fri`), then `1 wk` / `N wks`
- `studyNext` picks nearest exam’s unreviewed topic, prefers one with a reading chapter
- `backlog` open/overdue unchanged
- **Anchor:** multi-assessment week → `"2 exams and 1 quiz this week — start with …"`; softens under `heavyDay`; never scolding
- `heavyDay` still clears reading + softens framing; `clearDay` still blocked by coverage gaps

## Key decisions

1. Calendar wins; Canvas fills gaps.
2. Auto-closes inferred + reversible.
3. Week pressure window = next 7 days for the multi-count anchor.

## How to review C

```bash
cd C:\Projects\Life\finance-digest-glance
node tests/section-c-derived.test.js
node tests/glance-syllabus.test.js
```

Say **commit C** when good, then **go D**.
