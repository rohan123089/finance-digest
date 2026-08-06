# Phone / Shelf — one HTML file

Repo: https://github.com/rohan123089/finance-digest

## The only file you need

```text
apps/shelf/shelf.html
```

That **one** file is Money + Digest (tabs). Everything else is optional.

### Option A — open from the laptop hub (easiest)

1. Laptop: `npm start`
2. Same Wi‑Fi, in Shelf open:

```text
http://YOUR_LAPTOP_IP:8787/apps/shelf/shelf.html
```

### Option B — download one file

1. Open the repo on GitHub (phone browser, logged in if private).
2. Go to `apps/shelf/shelf.html` → raw / download that file only.
3. Or **Code → Download ZIP**, then keep only `apps/shelf/shelf.html`.
4. Point Shelf at that file.

You do **not** need `home.html`, `money.html`, `digest.html`, or separate JS files.

### Pairing (once, on the laptop)

http://127.0.0.1:8787/apps/hub/pairing.html — scan with Shelf so sync works.

Rebuild the one-file app after editing sources:

```powershell
npm run build:shelf
```
