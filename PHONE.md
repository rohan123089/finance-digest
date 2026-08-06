# Shelf app — one HTML file, no hub required

## File

`apps/shelf/shelf.html`

Download that **one** file. Open it in a browser or point Shelf at it.

It runs **offline** with sample money data + bills + digest. Edits save in the
browser (`localStorage`). The laptop hub is optional.

## Open offline (no `npm start`)

1. Get `apps/shelf/shelf.html` (GitHub ZIP or copy from this repo).
2. Open the file (double-click, or Shelf → load file).
3. Use **Money** and **Digest** tabs.

## Optional: connect to hub later

If you later open the same file from the hub URL while `npm start` is running:

http://127.0.0.1:8787/apps/shelf/shelf.html

…it will use live hub data instead. Phone on Wi‑Fi:

http://YOUR_LAPTOP_IP:8787/apps/shelf/shelf.html

## Pairing / sync / bank import

Those still need the hub. Day-to-day Money + Digest + rent reminders do not.

Rebuild after changing sources:

```powershell
npm run build:shelf
```
