# Digest glance progress

**Workspace:** `C:\Projects\Life\finance-digest-glance` (sibling of `finance-digest`)  
**Branch:** `feat/digest-glance-a`  
**Merge later:** into `finance-digest` / master after the other agent finishes — do not forget.

## Status

| | |
|---|---|
| **Done** | Audit; **A–D** committed (D=`4c8f914`) |
| **Doing** | Section **E** — digest payload contract (awaiting your review) |
| **Next** | **F** (outbox actions + Triage) |

## Section E — ready for review (not committed)

- Locked two-surface contract: `glance.*` + `detail.needsALook` (maps to flat spec fields)
- `engine/digest-contract.js` validates shape; `buildDigest` records violations on meta
- Guarantees: no `needsALook` on glance; integer `done`/`total`; empty `reading` when `heavyDay`
- Docs updated in `docs/phone-hub-contract.md`

### Final payload shape

```text
{ v, generatedAt, date, asOfDate,
  glance: { clearDay, heavyDay, anchor, examHorizon[], today[], backlog{open,overdue},
            studyNext?, junk{count,targetRef}, reading[] },
  detail: { today, watching, backlog, reading, junk, examHorizon, topics,
            needsALook{ conflicts, confirmDates, coverageGaps } } }
```

## How to review E

```bash
cd C:\Projects\Life\finance-digest-glance
node tests/section-e-contract.test.js
```

Say **commit E** when good, then **go F**.
