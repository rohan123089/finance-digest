# Life app (`app.html`) — Money + Digest frontend

## Naming

| Piece | Role |
|-------|------|
| **Shelf** (Android) | **Doorway only** — WebView that opens the hub URL. Not the source of truth. |
| **`apps/app.html`** | The frontend: Money + Digest + **Sync** tab. |
| **Hub** (laptop) | Source of truth (DB, connectors, APIs). |

## Phone (primary path)

1. On the laptop, bind the hub to LAN and start it:

```powershell
$env:HUB_HOST = "0.0.0.0"
npm start
```

2. On the laptop open <http://127.0.0.1:8787/apps/app.html> → **Sync** tab.
3. Scan the QR (or copy the LAN URL) and open that URL **in Shelf** on the same Wi‑Fi.
4. Money + Digest load live from the hub. Shelf is just the browser shell.

`file://` / downloaded HTML without the hub is **preview-only**.

## File / GitHub

`apps/app.html`

Raw GitHub (after push):

https://raw.githubusercontent.com/rohan123089/finance-digest/master/apps/app.html

Prefer the hub URL above over downloading raw HTML for day-to-day use.

## Laptop hub

With `npm start`:

http://127.0.0.1:8787/apps/app.html

## Advanced offline folder sync

Optional encrypted `sync/` pairing remains at
<http://127.0.0.1:8787/apps/hub/pairing.html> — not required for the doorway path.

## Pairing / bank import

Gmail, SimpleFIN, Canvas, etc. still need the hub (**Setup** from the app when served by the hub).

Rebuild after changing sources:

```powershell
npm run build:shelf
```
