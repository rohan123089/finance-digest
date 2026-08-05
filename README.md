# Finance Digest

Personal offline-first money tracker + daily digest. Laptop Node hub is the source of truth.

## Download

**Easiest:** on GitHub click **Code → Download ZIP**, unzip, then run the Quick start below.

**Or clone:**

```bash
git clone https://github.com/rohan123089/finance-digest.git
cd finance-digest
```

## Quick start

```bash
npm install
npm start
```

On Windows PowerShell you can set a passphrase first (optional; a default is used if unset):

```powershell
$env:HUB_DB_PASSPHRASE = "dev-passphrase-change-me"
npm start
```

Then open:

- Money: http://127.0.0.1:8787/apps/money/money.html
- Digest: http://127.0.0.1:8787/apps/digest/digest.html

No-server offline mode: open `apps/money/money.html` directly in a browser.

## Environment

| Variable | Purpose | Default |
|---|---|---|
| `HUB_DB_PASSPHRASE` | AES-GCM DB envelope key | `dev-passphrase-change-me` |
| `HUB_DB_PATH` | Encrypted SQLite path | `data/finance.db.enc` |
| `HUB_PORT` | Hub port | `8787` |
| `HUB_SYNC_ROOT` | Phone↔hub sync folder | `sync/` |
| `HUB_AI_MODE` | `OFF` / `LOCAL` / `CLOUD` | `OFF` |
| `GROUPME_TOKEN` / `GROUPME_GROUP_ID` | Live GroupMe | mock if unset |
| `EMAIL_OAUTH_CLIENT_ID` | Live email OAuth scaffold | mock if unset |
| `BANK_READONLY_TOKEN` | Live bank scaffold | mock if unset |

Secrets stay on the hub. Never put credentials in `localStorage` or page JS.

## Milestone map

1. **Money review loop** — offline HTML + engine (done)
2. **Node hub** — encrypted SQLite (AES-256-GCM envelope over `node:sqlite`), commit API, serves UI

> Note: native SQLCipher/`better-sqlite3` builds need Visual Studio C++ tooling on Windows. This hub uses Node’s built-in SQLite plus passphrase-sealed at-rest encryption so it runs without native compiles.
3. **Sync ingest** — decrypt `/sync/up` outbox files, publish digest/snapshot down
4. **Connectors** — GroupMe, email, read-only bank (mock by default)
5. **Digest app** — daily card UI
6. **Gated AI** — OFF/LOCAL/CLOUD on redacted snapshot only; never mutates records

## Useful commands

```bash
npm test
npm run sync:once
npm run connectors:once
```

Hand-drop an encrypted outbox into `sync/up/` (or use tests) then `POST /api/sync/ingest` or `npm run sync:once`.
