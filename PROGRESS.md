# Digest glance progress

**Workspace:** `C:\Projects\Life\finance-digest-glance` (sibling of `finance-digest`)  
**Branch:** `feat/digest-glance-a`  
**Merge later:** into `finance-digest` / master after the other agent finishes — do not forget.

## Status

| | |
|---|---|
| **Done** | STEP 1 audit; Section **A** (syllabus & assessment map) |
| **Doing** | Section **B** — completion / progress model |
| **Next** | C → D → E → F (one at a time after review) |

## Section A — shipped

- Outlook secrets in `CONNECTOR_ACCOUNTS`
- Coverage gaps + `blocksClear` so missing syllabus never reads as all-clear
- Re-parse records `syllabusMapChanges` (`changed: true`)
- **Trust Google Calendar** on conflict; **Canvas fills gaps** (unmatched Canvas → confirmed assessment; matched → calendar date wins, `canvasDate` kept)

## Key decisions

1. **Trust:** Google Calendar wins dates; Canvas fills gaps only.
2. **Work isolation:** `finance-digest-glance` until final merge.
3. **Payload:** keep `glance` + `detail` two-surface contract.

## How to review

```bash
cd C:\Projects\Life\finance-digest-glance
node tests/section-a-syllabus.test.js
node tests/glance-syllabus.test.js
node tests/calendar-first.test.js
```
