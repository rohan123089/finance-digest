# Finance Digest Laptop Hub

The laptop hub is the source of truth for this offline-first money and digest
system. It owns the encrypted database, deterministic finance engine, localhost
API, and static HTML. Browser pages call only `window.Shelf.*`; the Shelf adapter
relays those calls to the local hub.

## Requirements

- Node.js 22 or newer
- A working OS credential store (Windows Credential Manager on Windows)

## Run

Phone / Shelf setup: see [`PHONE.md`](PHONE.md).

```powershell
npm install
npm start
```

Open <http://127.0.0.1:8787/> (hub home). Point Shelf at that page — it launches
**Money** and **Daily Digest** as separate HTML apps. The first launch creates the
encrypted database, seeds starter accounts (UWCU checking/savings, Amex, Discover,
Vanguard, outside payments) with **no sample transactions**, and stores a random
database key in the OS keychain. To load the old 25-row demo set instead:

```powershell
$env:HUB_SEED_SAMPLE = "1"
npm start
```

Configuration:

- `HUB_PORT` changes the localhost port (default `8787`).
- `HUB_DB_PATH` changes the encrypted database path (default `data/finance.db`).
- `HUB_HOST` defaults to `127.0.0.1`; keep it on loopback.
- `HUB_SYNC_ROOT` changes the phone sync folder (default `sync/`).
- `HUB_SEED_SAMPLE=1` seeds sample transactions on an empty database.

There is deliberately no database-passphrase environment variable or hardcoded
development key.

## Accounts, CSV import, and SimpleFIN

Money accounts live in the encrypted DB and can be added anytime from the Money
UI (**Add account**) or `POST /api/accounts`.

**Recommended hybrid:** use SimpleFIN for institutions it supports (Amex,
Discover, Vanguard, …). For banks it does not list (e.g. UWCU), download the
CSV/OFX when the statement email arrives — Digest will surface an **Import …
statement** reminder when Gmail sees that mail (after email connectors are live).

**CSV / OFX import** (offline path):

```powershell
npm run import:file -- --account amex --file .\Downloads\amex.csv
```

Or use **Import CSV/OFX** in the Money sidebar while the hub is running.

**SimpleFIN Bridge** (live bank sync):

1. Create a Setup Token at <https://beta-bridge.simplefin.org/>.
2. Open <http://127.0.0.1:8787/apps/hub/simplefin.html>, paste the token, claim it.
   The Access URL is stored only in the OS keychain (`simplefin.accessUrl`).
3. Map each remote SimpleFIN account to a local account (UWCU, Amex, …).
4. Click **Sync transactions** (or `POST /api/simplefin/sync`).

Venmo is **not** a separate account — Venmo charges that hit UWCU/Amex stay in
review so you can decide spending vs transfer.

```powershell
# Optional: claim from CLI after storing nothing in the repo
# Prefer the SimpleFIN HTML page; claim posts the one-time setup token to the hub.
```

## Database encryption and key location

`data/finance.db` is SQLite encrypted with the SQLCipher cipher through the
`better-sqlite3` API. There is no temporary plaintext database.

The random 256-bit database key is stored by `keytar`:

- Service: `Shelf Finance Hub`
- Store on Windows: Windows Credential Manager
- Account: `database-key:<hash-of-database-path>`

The key is never written to the repository, database, browser files, API
responses, or logs. The phone↔hub sync key lives separately at `data/sync.key`
(libsodium secretbox). It is gitignored and must not be rotated without
re-encrypting existing `sync/**/*.enc` files.

## Reset the database

Stop the hub, then delete:

```powershell
Remove-Item data\finance.db, data\finance.db-wal, data\finance.db-shm -ErrorAction SilentlyContinue
```

Run `npm start` again. The existing OS-keychain key is reused and starter
accounts are recreated empty (no sample transactions unless
`HUB_SEED_SAMPLE=1`). The legacy `data/finance.db.enc` file from the earlier
implementation is not opened or migrated.

If you still see "parents' card" after a rename, reset the DB as above — the
account id is now `outside-payments`.

## Offline browser mode

Open `apps/money/money.html` directly. On `file://`, the local mock Shelf bridge
uses sample data and performs no network access. When served by the hub,
`apps/shelf/hub-shelf.js` performs the localhost relay on behalf of the HTML.

## Shelf device contract

- `Shelf.secure.*` rejects on purpose (code `SECURE_DISABLED`). Tokens are never
  handed back to the WebView — configure them in Connect and use `Net.call`.
- `Shelf.data.get('transactions')` returns a `transactions` field sourced from
  the encrypted digest/snapshot, or `null`. The localhost hub relay, being the
  source of truth, also serves raw rows under that same field.
- Self-test: open `examples/shelf-self-test.html` (through the hub, or via
  **My files** on the signed Android build) to verify the surface end to end.

## Stable API (M0–M2)

- `GET /api/transactions` → `{ kind, rows, asOfDate, settings, accounts }`
- `GET /api/accounts` → `{ kind, accounts }`
- `POST /api/accounts` / `PATCH /api/accounts/:id` → create or update accounts
- `POST /api/import` → `{ accountId, format, text }` CSV/OFX ingest
- `POST /api/simplefin/claim` → one-time setup token → OS-keychain access URL
- `GET /api/simplefin/remote` / `POST /api/simplefin/map` / `POST /api/simplefin/sync`
- `GET /api/snapshot` → redacted aggregate snapshot with no raw rows or account numbers
- `GET /api/digest` → `{ kind: "digest", today, reading, junk }` (assembled from ingested sync items)
- `POST /api/outbox` → idempotently accepts items with stable `id` and `type`
- `POST /api/sync/ingest` → decrypt `sync/up/outbox-*.json.enc`, merge by id, publish down-files
- `POST /api/connectors/run` → hub-only connectors (mock by default; never returns secrets)

Transaction and setting edits from the money app are sent as outbox actions and
computed again by the hub. The HTML itself never calls `fetch`.

## M2 phone ↔ hub sync

Layout (see [`docs/phone-hub-contract.md`](docs/phone-hub-contract.md)):

```text
sync/up/     phone→hub   outbox-<ts>.json.enc
sync/down/   hub→phone   digest-latest.json.enc, snapshot-latest.json.enc
sync/meta/   hub-cursor.json
```

With the hub running, drop an encrypted outbox into `sync/up/`, then either:

```powershell
npm run sync:once
```

or `POST http://127.0.0.1:8787/api/sync/ingest`. The hub marks each file `.done`,
upserts by stable id, executes pending `action.*` once, and rewrites the down
files. The phone pulls; the hub never reaches into the phone.

## Verify

```powershell
npm test
```

Covers Shelf, rules, SQLCipher, sync ingest, connectors, digest assembly, gated AI,
accounts registry, CSV/OFX import, and SimpleFIN mock sync.

## M4 digest assembly

`GET /api/digest` (and the encrypted `digest-latest` down-file) is assembled on the
hub from sync items + deterministic money tasks:

- **Today** — birthdays (soonest first), events, life tasks (personal / school /
  professional), receipt review tasks, owed / safe-to-spend tasks; each carries
  `actions[]` with a `targetRef`
- **Reading** — deduped URLs, ranked (sms/contacts before newsletters)
- **Junk** — pending unsubscribe/mute first

The digest HTML only calls `window.Shelf.*` (refresh + outbox actions + optional AI propose).

## M7 life capture (email / SMS / GroupMe → calendar / tasks)

Connectors + phone outbox extract deadlines, todos, and meetup-shaped items via
`engine/life.js`, tagged `personal` · `school` · `professional`.

- **Today** — Going / Not going / Add to calendar / Done / Dismiss
- **Watching** — events you declined stay visible so you still know they’re happening
- Live SMS is collected on Shelf and pushed as `signal.sms`; mock hub SMS runs with
  `npm run connectors:once`

```powershell
npm run connectors:once
# then open http://127.0.0.1:8787/apps/digest/digest.html → Refresh
```

Live Gmail uses the same rules on subject + snippet. This is not full Google Calendar
sync yet — it surfaces work into the digest and queues calendar-add for the device.
## M5 gated AI

AI is optional and hub-gated (`OFF` / `LOCAL` / `CLOUD`). It may only see a
contract-redacted snapshot (no raw rows, balances, or merchants) and
**never mutates** records (`mutations` is always `[]`).

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/ai/mode -Method POST -ContentType 'application/json' -Body '{"mode":"LOCAL"}'
Invoke-RestMethod http://127.0.0.1:8787/api/ai/propose -Method POST -ContentType 'application/json' -Body '{}'
```

Or open the digest app and click **Propose nudges** (uses `Shelf.ai.*`, not `fetch`).
Nudges appear under Today as `kind: "nudge"`.

### CLOUD AI (OpenAI-compatible)

```powershell
npm run connectors:set-secret -- ai.cloudKey
# optional:
npm run connectors:set-secret -- ai.cloudBaseUrl
npm run connectors:set-secret -- ai.cloudModel
```

Then set mode to `CLOUD` and propose. Only the redacted snapshot is sent; any
model `mutations` are discarded. Without a key, CLOUD falls back to local rules.

## Phone pairing (QR)

Open <http://127.0.0.1:8787/apps/hub/pairing.html> on the laptop. Scan with Shelf
to receive the shared libsodium sync key. Do not screenshot or forward the QR —
it contains the key. The JSON API returns the QR SVG + fingerprint only.

## Live email + bank

Still mock by default (`npm run connectors:once`). For live:

```powershell
# Gmail OAuth (refresh token from your own OAuth consent flow)
npm run connectors:set-secret -- email.clientId
npm run connectors:set-secret -- email.clientSecret
npm run connectors:set-secret -- email.refreshToken

# Read-only bank JSON endpoint: Authorization Bearer + { transactions: [...] }
npm run connectors:set-secret -- bank.token
npm run connectors:set-secret -- bank.endpoint

$env:HUB_CONNECTORS_LIVE = "1"
npm run connectors:once
```

## M3 connectors (hub-only)

Connectors never run in HTML. Secrets are stored in the OS keychain (`Shelf Finance Hub`), not env files, and live GroupMe uses hub `Net.call`.

```powershell
npm run connectors:set-secret -- groupme.token
npm run connectors:set-secret -- groupme.groupId
npm run connectors:once
```

`connectors:once` stays **mock by default**. Live GroupMe only when both secrets are set and:

```powershell
$env:HUB_CONNECTORS_LIVE = "1"
npm run connectors:once
```

Or `POST /api/connectors/run` with `{ "forceMock": false }`. Live email/bank fail closed without keychain secrets. Responses never include tokens.
