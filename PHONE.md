# Life app (`app.html`) — Money + Digest frontend

## Naming

| Piece | Role |
|-------|------|
| **Shelf** (Android) | Gateway only — `window.Shelf.*` (data, outbox, fs). Not the product UI. |
| **`apps/app.html`** | The frontend: Money + Digest. Load this **in Shelf** for real push/pull sync. |
| **Hub** (laptop) | Source of truth (DB, connectors, sync folder). |

Opening `app.html` as `file://` or in a normal browser is **preview-only** (local mock). It is not a standalone offline backend.

## File

`apps/app.html`

Raw GitHub (after push):

https://raw.githubusercontent.com/rohan123089/finance-digest/master/apps/app.html

Old path `apps/shelf/shelf.html` is gone; the hub still **302**s those URLs to `/apps/app.html`. GitHub raw will **not** redirect — use the new path above.

## Open in Shelf (real path)

1. Download `apps/app.html` (or load the raw URL in Shelf).
2. Point Shelf at that file.
3. Use **Money** and **Digest**; sync goes through Shelf APIs ↔ encrypted sync folder ↔ laptop hub.

## Laptop hub (dev / live data in browser)

With `npm start`:

http://127.0.0.1:8787/apps/app.html

Phone on Wi‑Fi (hub API relay — laptop browser / same LAN only; phone production path is Shelf + sync folder):

http://YOUR_LAPTOP_IP:8787/apps/app.html

## Pairing / bank import

Those still need the hub. Day-to-day Money + Digest UI is `app.html`.

Rebuild after changing sources:

```powershell
npm run build:shelf
```
