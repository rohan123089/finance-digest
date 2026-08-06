# Phone / Shelf — easy path

Repo: https://github.com/rohan123089/finance-digest

## What to put in Shelf

Shelf should load the **hub home** HTML (launcher for Money + Daily Digest). It does
**not** need to implement those apps itself.

### Best: open from the laptop hub (same Wi‑Fi)

1. On the laptop: `npm start` in this repo.
2. Find your laptop LAN IP (e.g. `ipconfig` → IPv4 like `192.168.1.20`).
3. In Shelf, open:

```text
http://YOUR_LAPTOP_IP:8787/apps/hub/home.html
```

Then tap **Money** or **Daily Digest**.

`127.0.0.1` only works on the laptop, not on the phone.

### Download the HTML from GitHub

1. On your phone, open the repo → **Code** → **Download ZIP**.
2. Unzip. You need at least:

```text
apps/hub/home.html
apps/money/money.html
apps/digest/digest.html
apps/shelf/hub-shelf.js
apps/shelf/mock-shelf.js
```

3. Point Shelf at `apps/hub/home.html` (file path or however Shelf loads local HTML).

**Note:** Offline HTML still needs a real Shelf bridge (`window.Shelf`) for data.
Mock Shelf is for laptop preview only. Money/Digest data comes from hub sync /
the native Shelf bridge — not from GitHub alone.

## Pairing (once)

On the laptop open http://127.0.0.1:8787/apps/hub/pairing.html and scan with Shelf
so both share `data/sync.key`.
