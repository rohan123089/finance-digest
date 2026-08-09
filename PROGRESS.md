# Digest glance progress

**Workspace:** `C:\Projects\Life\finance-digest-glance` (sibling of `finance-digest`)  
**Branch:** `feat/digest-glance-a`  
**Merge later:** into `finance-digest` / master after the other agent finishes — do not forget.

## Status

| | |
|---|---|
| **Done** | Audit; **A** (`62c84a1`); **B** (`f89ada0`); **C** (`f0922bc`) |
| **Doing** | Section **D** — protected-tier (awaiting your review) |
| **Next** | E → F |

## Section D — ready for review (not committed)

- Mutes still apply only to `signal.link` (reading/social)
- Assembly calls `assertProtectedTier`: muted sources cannot swallow tasks/events/deadlines; muted reading cannot leak
- Violations recorded on meta `protectedTierViolation`; hard-throw if `ASSERT_PROTECTED_TIER=1`
- Test: muted class group keeps due-date change + mandatory event + examHorizon; hides meme link

## Key decisions

1. Calendar wins; Canvas fills gaps.
2. Auto-closes inferred + reversible.
3. Protected-tier assert is soft by default (meta), hard under env flag.

## How to review D

```bash
cd C:\Projects\Life\finance-digest-glance
node tests/section-d-protected.test.js
node tests/glance-syllabus.test.js
```

Say **commit D** when good, then **go E**.
