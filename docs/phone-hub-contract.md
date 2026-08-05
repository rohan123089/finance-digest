# Phone ↔ hub sync contract

> Contract for Milestone 3. It is documentation only in Milestone 1.

## Principles

- The phone pushes; the hub never reaches in.
- Deltas use per-source watermarks.
- Ship extracted signal, not raw text.
- Use stable IDs and idempotent merges.
- Phone writes are append-only.
- Encrypt the whole envelope and version everything.

## Folder layout

Encrypted at rest and replicated by a user-owned sync tool:

```text
/sync/up/     phone→hub   outbox-<ts>.json.enc, attachments/<id>.enc
/sync/down/   hub→phone   digest-latest.json.enc, snapshot-latest.json.enc
/sync/meta/   phone-cursor.json, hub-cursor.json
```

## Shared envelope

Before encryption:

```json
{
  "v": 1,
  "device": "phone",
  "generatedAt": "2026-08-05T13:00:00Z",
  "watermarks": { "sms": "12345", "groupme": "998877" },
  "items": []
}
```

## UP — outbox items

`signal.*` items are collected and `action.*` items are to execute. Common fields are
`id`, `type`, `at`, `collectedAt`, and `source`.

```json
{ "id": "contact:a81f", "type": "signal.birthday", "source": "contacts",
  "data": { "name": "A. Rivera", "month": 8, "day": 6 } }
{ "id": "gm:998877", "type": "signal.event", "source": "groupme",
  "data": { "title": "Dinner", "start": "2026-08-08T19:00:00", "sourceRef": "groupme:group/44/msg/998877" } }
{ "id": "sms:12345", "type": "signal.link", "source": "sms",
  "data": { "url": "https://example.com/piece", "sharedBy": "Sam", "context": null } }
{ "id": "rcpt:5b2c", "type": "signal.receipt", "source": "camera",
  "data": { "merchant": "Trader Joe's", "total": 42.17, "date": "2026-08-05", "imageRef": "attachments/rcpt-5b2c.enc" } }
{ "id": "act:7f10", "type": "action.unsubscribe", "source": "digest",
  "data": { "targetRef": { "listIds": ["news.acme.com"] } } }
```

## DOWN — digest

`digest-latest.json` has these sections:

- `today[]`: birthdays, events, and tasks. Each has `actions[]` carrying a
  `targetRef` that the phone echoes back.
- `reading[]`: title, URL, source, and rank.
- `junk[]`: unsubscribe or mute entries with a `targetRef`.

## DOWN — snapshot

`snapshot-latest.json` is already aggregated and redacted. It contains no account
numbers or raw transactions and is the only payload the optional AI layer may see.

Fields: `netWorth`, `liquid`, `invested`, `savingsRatePct`, `recurringMonthly`,
`runwayMonths`, `owed`, `safeToSpend{ period, amount, spent, remaining }`, and
`flags[]{ id, trigger, why, action, value, deadline, confidence }`.

## Merge, encryption, and versioning

- Upsert by `id`, advance cursors, execute each `action.*` once, and reflect the
  result in the next digest.
- Encrypt with one shared symmetric key using libsodium `crypto_secretbox` and a
  random nonce per file. Exchange the key out of band: the hub shows a QR code and
  the phone scans it.
- Accept the current envelope version and one prior version. Refuse anything newer
  with a clear error.
