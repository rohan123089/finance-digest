# Shelf bridge contract

The HTML apps never touch the network, credentials, tokens, or storage secrets.
They only call `window.Shelf.*` and render what comes back.

## Surface (promise-based)

| Call | Purpose |
|---|---|
| `Shelf.data.get(kind, opts)` | `'transactions'`, `'digest'`, `'snapshot'`, … |
| `Shelf.contacts.list()` | Contact signals |
| `Shelf.sms.query({ sinceId })` | SMS delta |
| `Shelf.camera.capture()` | → `{ imageRef }` |
| `Shelf.ocr.recognize(imageRef)` | → `{ text, blocks }` |
| `Shelf.fs.read(path)` / `Shelf.fs.write(path, data)` | Sandboxed files |
| `Shelf.secure.get/set/delete(key)` | **Rejects on purpose** (see below) |
| `Shelf.outbox.push(items)` | Queue for hub sync |
| `Shelf.notify({ title, body })` | Local notification |
| `Shelf.onShare(cb)` / `Shelf.onAppUrl(cb)` | Inbound share / deep link |

Errors reject with `Error` objects that include `.code` and `.shelf === true`.

## Secrets: never through the WebView

`Shelf.secure.*` rejects intentionally with code `SECURE_DISABLED`. Returning a
token to page JavaScript would expose it to the WebView. Configure tokens in
Connect and reach the upstream service through `Net.call`, so credentials stay
off the page. App HTML must not depend on reading tokens back.

## Mock vs real

- Real Shelf (Android WebView) sets `Shelf.__real = true` before page scripts run.
- The laptop-served adapter sets `Shelf.__hub = true` and relays only to the
  same-origin hub API.
- [`apps/shelf/mock-shelf.js`](../apps/shelf/mock-shelf.js) installs only when real Shelf is absent (`Shelf.__mock = true`).
- App HTML must not branch on mock vs real for data access — same calls, same shapes.

## Money app data

`Shelf.data.get('transactions')` returns only whatever the encrypted
digest/snapshot supplied — an object carrying a `transactions` field — or `null`
when nothing has been synced. Raw transactions are not otherwise part of the
device contract.

```json
{
  "kind": "transactions",
  "transactions": [{ "id", "date", "rawMerchant", "amount", "account" }],
  "asOfDate": "2026-08-05",
  "settings": { "weeklySavingsTarget" }
}
```

The laptop hub is the source of truth and additionally serves raw rows through
the localhost relay. The relay exposes them under the same `transactions` field
so the money app has a single code path; on a real device with no synced
snapshot the value is `null`, and the money app renders an empty state.

`Shelf.data.get('snapshot')` resolves to a redacted aggregate object beginning
with `{ "kind": "snapshot" }`. It has no raw transactions or account numbers.
`Shelf.data.get('digest')` resolves to:

```json
{
  "kind": "digest",
  "date": "2026-08-07",
  "glance": { "clearDay", "heavyDay", "anchor", "examHorizon", "today", "backlog", "studyNext", "junk", "reading" },
  "detail": { "today": [], "watching": [], "backlog": [], "reading": [], "junk": [], "needsALook": {} }
}
```

Morning glance binds to `glance`; the Detail page binds to `detail`.

The deterministic rules and authoritative snapshot computation run in the hub.
The offline mock invokes the shared engine only as a browser fixture.

`Shelf.outbox.push(items)` relays `{ "items": [...] }` to `POST /api/outbox` on
the laptop and resolves to `{ "queued", "total" }`. Each item requires a stable
`id` and `type`.
