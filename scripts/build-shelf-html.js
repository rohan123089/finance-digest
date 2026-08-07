"use strict";

/**
 * Builds apps/app.html — one downloadable HTML frontend for Money + Digest.
 * Load it in the Shelf Android gateway (or laptop hub). Bridge scripts stay in apps/shelf/.
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const outPath = path.join(root, "apps", "app.html");
const legacyShelfHtml = path.join(root, "apps", "shelf", "shelf.html");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

const hubShelf = read("apps/shelf/hub-shelf.js");
const mockShelf = read("apps/shelf/mock-shelf.js");
const rules = read("engine/rules.js");
const model = read("engine/model.js");
const bills = read("engine/bills.js");

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Life · Money & Digest</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0f14;
      --panel: #121922;
      --line: #283544;
      --text: #edf3f8;
      --muted: #91a0ad;
      --accent: #5ee0a0;
      --warn: #ffcf66;
      --danger: #ff7b7b;
      --blue: #74b9ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.4 system-ui, "Segoe UI", sans-serif;
    }
    .shell { max-width: 720px; margin: 0 auto; padding: 12px 14px 40px; }
    .top {
      display: flex; flex-wrap: wrap; gap: 10px;
      align-items: center; justify-content: space-between;
      margin-bottom: 14px;
    }
    .brand .eyebrow {
      color: var(--muted); font-size: 11px; font-weight: 700;
      letter-spacing: .12em; text-transform: uppercase;
    }
    .brand h1 { margin: 2px 0 0; font-size: 26px; letter-spacing: -.03em; }
    .tabs { display: flex; gap: 6px; }
    .tabs button {
      border: 1px solid var(--line); background: #18212c; color: var(--text);
      border-radius: 999px; padding: 8px 14px; cursor: pointer; font-weight: 600;
    }
    .tabs button.active {
      background: var(--accent); color: #062316; border-color: transparent;
    }
    .bridge { color: var(--muted); font-size: 12px; width: 100%; }
    .panel {
      display: none; border: 1px solid var(--line); border-radius: 12px;
      background: var(--panel); padding: 14px; margin-bottom: 12px;
    }
    .panel.on { display: block; }
    .hero {
      padding: 14px; border-radius: 10px; margin-bottom: 12px;
      background: linear-gradient(135deg, #13231d, var(--panel) 60%);
      border: 1px solid var(--line);
    }
    .safe {
      font-size: 42px; font-weight: 750; letter-spacing: -.04em;
      color: var(--accent); line-height: 1;
    }
    .safe.neg { color: var(--danger); }
    .muted { color: var(--muted); font-size: 12px; }
    .metrics {
      display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;
      margin-bottom: 12px;
    }
    .metric {
      border: 1px solid var(--line); border-radius: 8px; padding: 10px;
      background: #0e151d;
    }
    .metric strong { display: block; font-size: 18px; margin-top: 2px; }
    h2 { margin: 0 0 8px; font-size: 14px; }
    .row {
      display: flex; justify-content: space-between; gap: 10px;
      padding: 10px 0; border-bottom: 1px solid #202c38; font-size: 13px;
    }
    .row:last-child { border-bottom: 0; }
    .empty, .status { color: var(--muted); padding: 12px 0; font-size: 13px; }
    button.act, button.tiny {
      border: 1px solid var(--line); border-radius: 8px; background: #18212c;
      color: var(--text); padding: 6px 10px; cursor: pointer; font-size: 12px;
      margin: 4px 4px 0 0;
    }
    button.primary {
      background: var(--accent); color: #062316; border-color: transparent; font-weight: 700;
    }
    input, select {
      width: 100%; border: 1px solid var(--line); border-radius: 8px;
      background: #0e151d; color: var(--text); padding: 8px; margin: 4px 0 8px;
    }
    label { font-size: 12px; color: var(--muted); display: block; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .digest-cols { display: grid; gap: 10px; }
    .digest-box {
      border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px;
      background: #0e151d; min-height: 80px;
    }
    .digest-box h3 {
      margin: 0 0 8px; font-size: 12px; text-transform: uppercase;
      letter-spacing: .08em; color: var(--muted);
    }
    a { color: var(--blue); }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
    #phone-qr {
      display: grid; place-items: center; margin: 12px 0;
      padding: 12px; border-radius: 12px; background: #fff; min-height: 160px;
    }
    #phone-qr svg { width: 220px; height: 220px; }
    .sync-url {
      word-break: break-all; font-size: 13px; color: var(--text);
      padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px;
      background: #0e151d; margin: 8px 0;
    }
    .warn-line { color: var(--warn); font-size: 13px; margin: 8px 0; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="top">
      <div class="brand">
        <div class="eyebrow">Money + Digest</div>
        <h1>Life</h1>
      </div>
      <div class="tabs" role="tablist">
        <button type="button" class="active" data-tab="money">Money</button>
        <button type="button" data-tab="digest">Digest</button>
        <button type="button" data-tab="sync">Sync</button>
      </div>
      <a id="setup-link" href="/apps/hub/setup.html" style="color:var(--blue);font-size:13px;text-decoration:none">Setup</a>
      <div class="bridge" id="bridge">Starting…</div>
    </div>

    <div id="boot-error" class="empty" hidden></div>

    <!-- MONEY -->
    <section class="panel on" id="tab-money">
      <div class="hero">
        <div class="eyebrow" id="safe-label">Safe to spend</div>
        <div class="safe" id="safe-value">—</div>
        <div class="muted" id="safe-detail">Load from Shelf…</div>
      </div>
      <div class="metrics">
        <div class="metric"><div class="eyebrow">Net worth</div><strong id="m-nw">—</strong></div>
        <div class="metric"><div class="eyebrow">Liquid</div><strong id="m-liq">—</strong></div>
        <div class="metric"><div class="eyebrow">Owed</div><strong id="m-owed">—</strong></div>
        <div class="metric"><div class="eyebrow">Runway</div><strong id="m-run">—</strong></div>
      </div>

      <h2>Bills</h2>
      <div id="bills-list" class="muted">—</div>
      <div class="grid2" style="margin-top:10px">
        <label>Title<input id="bill-title" placeholder="Rent"></label>
        <label>Amount<input id="bill-amount" type="number" min="0" step="1" placeholder="1450"></label>
        <label>Due day<input id="bill-due" type="number" min="1" max="31" value="1"></label>
        <label>Remind days before<input id="bill-lead" type="number" min="0" max="28" value="5"></label>
      </div>
      <button type="button" class="act" id="bill-add">Add / update bill</button>

      <h2 style="margin-top:18px">Transactions <span class="muted" id="review-count"></span></h2>
      <div id="tx-list" class="muted">—</div>
      <p class="status" id="money-status"></p>
    </section>

    <!-- DIGEST -->
    <section class="panel" id="tab-digest">
      <div class="toolbar">
        <button type="button" class="act" id="digest-refresh">Refresh</button>
        <button type="button" class="act primary" id="ai-propose">Propose nudges</button>
      </div>
      <div class="digest-cols">
        <div class="digest-box"><h3>Today</h3><div id="today"></div></div>
        <div class="digest-box"><h3>Watching</h3><div id="watching"></div></div>
        <div class="digest-box"><h3>Reading</h3><div id="reading"></div></div>
        <div class="digest-box"><h3>Junk</h3><div id="junk"></div></div>
      </div>
      <p class="status" id="digest-status">—</p>
    </section>

    <!-- SYNC (Shelf = doorway only; hub owns data) -->
    <section class="panel" id="tab-sync">
      <h2>Phone doorway</h2>
      <p class="muted" id="sync-lead">
        Shelf only opens this app. Live Money + Digest come from the laptop hub on Wi‑Fi.
      </p>
      <div id="sync-hub-block">
        <p class="muted">On your phone, open Shelf and load this URL (same Wi‑Fi as the laptop):</p>
        <div class="sync-url" id="phone-url">Loading…</div>
        <div id="phone-qr">Loading QR…</div>
        <p class="muted" id="sync-hint"></p>
        <p class="muted" id="sync-meta"></p>
        <div class="toolbar">
          <button type="button" class="act primary" id="sync-refresh">Refresh data</button>
          <button type="button" class="act" id="sync-reload-doorway">Reload doorway info</button>
          <a id="sync-setup" href="/apps/hub/setup.html" class="act" style="display:inline-block;text-decoration:none;padding:6px 10px">Hub setup</a>
        </div>
        <p class="muted" style="margin-top:14px">
          Advanced offline folder sync:
          <a href="/apps/hub/pairing.html">pairing QR</a> (optional — not required for the doorway path).
        </p>
      </div>
      <div id="sync-offline-block" hidden>
        <p class="warn-line">This copy is offline preview only.</p>
        <p class="muted">
          On the laptop run the hub with LAN bind, open the Sync tab there, then load that URL in Shelf:
        </p>
        <pre class="sync-url" style="white-space:pre-wrap;margin:0">$env:HUB_HOST="0.0.0.0"
npm start</pre>
      </div>
      <p class="status" id="sync-status">—</p>
    </section>
  </div>

  <script>
${rules}
  </script>
  <script>
${model}
  </script>
  <script>
${bills}
  </script>
  <script>
${hubShelf}
  </script>
  <script>
${mockShelf}
  </script>
  <script>
  "use strict";

  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const money2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

  function escapeHtml(value) {
    const el = document.createElement("span");
    el.textContent = value == null ? "" : String(value);
    return el.innerHTML;
  }

  function actionId(prefix) {
    const suffix = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : Date.now() + "-" + Math.random().toString(16).slice(2);
    return prefix + ":" + suffix;
  }

  const state = { transactions: [], snapshot: null, bills: [], billsUpcoming: [], labels: {} };

  document.querySelectorAll(".tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("on"));
      document.querySelector("#tab-" + btn.dataset.tab).classList.add("on");
      if (btn.dataset.tab === "sync") loadDoorway().catch(() => {});
    });
  });

  function renderMoney() {
    const snap = state.snapshot;
    if (!snap) {
      document.querySelector("#safe-detail").textContent = "No snapshot yet — sync with the hub";
      return;
    }
    const safe = snap.safeToSpend || {};
    const el = document.querySelector("#safe-value");
    el.textContent = money.format(safe.remaining || 0);
    el.classList.toggle("neg", (safe.remaining || 0) < 0);
    document.querySelector("#safe-label").textContent = safe.nextPayday
      ? "Safe to spend until " + safe.nextPayday
      : "Safe to spend";
    document.querySelector("#safe-detail").textContent =
      money.format(safe.income ?? safe.weeklyIncome ?? 0) + " in − " +
      money.format(safe.committed || 0) + " committed − " +
      money.format(safe.savingsTarget || 0) + " savings − " +
      money.format(safe.spent || 0) + " spent";
    document.querySelector("#m-nw").textContent = money.format(snap.netWorth || 0);
    document.querySelector("#m-liq").textContent = money.format(snap.liquid || 0);
    document.querySelector("#m-owed").textContent = money.format(snap.owed || 0);
    document.querySelector("#m-run").textContent = (snap.runwayMonths || 0).toFixed(1) + " mo";

    const upcoming = Object.fromEntries((state.billsUpcoming || []).map((r) => [r.billId, r]));
    document.querySelector("#bills-list").innerHTML = state.bills.length
      ? state.bills.map((b) => {
          const u = upcoming[b.id];
          const when = u?.remind ? u.label : ("day " + b.dueDay);
          return '<div class="row"><span><strong>' + escapeHtml(b.title) +
            (b.active ? "" : " · off") + '</strong><br><span class="muted">' +
            escapeHtml(when) + '</span></span><strong>' +
            (b.amount > 0 ? money2.format(b.amount) : "set $") +
            '</strong></div>';
        }).join("")
      : '<div class="empty">No bills — add rent below</div>';

    const needs = state.transactions.filter((t) => t.needsReview).length;
    document.querySelector("#review-count").textContent = needs ? "(" + needs + " need review)" : "";
    const rows = state.transactions.slice(0, 40);
    document.querySelector("#tx-list").innerHTML = rows.length
      ? rows.map((tx) => {
          return '<div class="row"><span><strong>' + escapeHtml(tx.merchant || tx.rawMerchant) +
            '</strong><br><span class="muted">' + escapeHtml(tx.date) + " · " +
            escapeHtml(state.labels[tx.account] || tx.account) +
            (tx.needsReview ? " · review" : "") +
            '</span></span><span>' + money2.format(tx.amount || 0) +
            '<br><select data-tx="' + escapeHtml(tx.id) + '" class="tx-dir">' +
            '<option value="">Review…</option>' +
            '<option value="in"' + (tx.direction === "in" ? " selected" : "") + '>Income</option>' +
            '<option value="out"' + (tx.direction === "out" ? " selected" : "") + '>Expense</option>' +
            '<option value="transfer"' + (tx.direction === "transfer" ? " selected" : "") + '>Transfer</option>' +
            '</select></span></div>';
        }).join("")
      : '<div class="empty">No transactions synced</div>';
  }

  function actionButtons(actions) {
    if (!actions || !actions.length) return "";
    const labels = {
      "bill.paid": "Paid",
      "rsvp.yes": "Going",
      "rsvp.no": "Not going",
      "task.complete": "Done",
      "calendar.add": "Calendar",
      dismiss: "Dismiss",
      ack: "Ack",
      unsubscribe: "Run"
    };
    return actions.map((a) => {
      return '<button type="button" class="tiny digest-action" data-type="' +
        escapeHtml(a.type) + '" data-ref="' +
        escapeHtml(JSON.stringify(a.targetRef || {})) + '">' +
        escapeHtml(labels[a.type] || a.type) + "</button>";
    }).join("");
  }

  function fillList(id, items, mapper, empty) {
    const root = document.querySelector("#" + id);
    if (!items.length) {
      root.innerHTML = '<div class="empty">' + empty + "</div>";
      return;
    }
    root.innerHTML = items.map(mapper).join("");
  }

  async function loadDigest() {
    const digest = await Shelf.data.get("digest");
    if (!digest) {
      document.querySelector("#digest-status").textContent = "No digest yet";
      fillList("today", [], null, "Nothing today");
      fillList("watching", [], null, "Nothing watching");
      fillList("reading", [], null, "No reading");
      fillList("junk", [], null, "No junk");
      return;
    }
    fillList("today", digest.today || [], (item) => {
      const when = item.dueAt || item.start || "";
      return '<div class="row" style="flex-direction:column;align-items:stretch">' +
        "<div><strong>" + escapeHtml(item.kind) +
        (item.domain ? " · " + escapeHtml(item.domain) : "") +
        " · " + escapeHtml(item.title || item.name) +
        '</strong><div class="muted">' + escapeHtml(when) + "</div></div>" +
        actionButtons(item.actions) + "</div>";
    }, "Nothing today");
    fillList("watching", digest.watching || [], (item) =>
      '<div class="row"><span>not going · ' + escapeHtml(item.title || item.name) +
      "</span></div>", "Nothing watching");
    fillList("reading", digest.reading || [], (item) =>
      '<div class="row"><a href="' + escapeHtml(item.url) + '" rel="noreferrer">' +
      escapeHtml(item.title || item.url) + "</a></div>", "No reading");
    fillList("junk", digest.junk || [], (item) =>
      '<div class="row"><span>' + escapeHtml(item.action) + " · " +
      escapeHtml(item.status || "pending") + "</span>" +
      (item.status === "pending"
        ? actionButtons([{ type: "unsubscribe", targetRef: item.targetRef || { itemId: item.id } }])
        : "") + "</div>", "No junk");
    document.querySelector("#digest-status").textContent =
      "Updated " + (digest.generatedAt || "now") +
      " · " + (digest.today || []).length + " today · " +
      (digest.watching || []).length + " watching";
  }

  async function refreshMoney() {
    const [txPayload, snap, billsPayload] = await Promise.all([
      Shelf.data.get("transactions"),
      Shelf.data.get("snapshot"),
      (Shelf.bills?.list ? Shelf.bills.list() : Shelf.data.get("bills")).catch(() => null)
    ]);
    const rows = txPayload?.transactions ?? txPayload?.rows ?? [];
    state.transactions = rows.map((r) => ({ ...r }));
    state.snapshot = snap;
    state.bills = billsPayload?.bills || [];
    state.billsUpcoming = billsPayload?.upcoming || [];
    const accounts = txPayload?.accounts || [];
    state.labels = Object.fromEntries(accounts.map((a) => [a.id, a.label || a.id]));
    if (!Object.keys(state.labels).length && snap?.balances) {
      Object.keys(snap.balances).forEach((id) => { state.labels[id] = id; });
    }
    renderMoney();
    document.querySelector("#money-status").textContent =
      rows.length + " transactions · as of " + (txPayload?.asOfDate || "—");
  }

  document.querySelector("#bill-add").addEventListener("click", async () => {
    const title = document.querySelector("#bill-title").value.trim();
    if (!title) return;
    const amount = Number(document.querySelector("#bill-amount").value) || 0;
    const dueDay = Number(document.querySelector("#bill-due").value) || 1;
    const leadDays = Number(document.querySelector("#bill-lead").value) || 5;
    const id = "bill:" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    try {
      if (Shelf.bills?.create) {
        await Shelf.bills.create({ id, title, amount, dueDay, leadDays, active: true });
      } else {
        await Shelf.outbox.push({
          id: actionId("bill"),
          type: "action.bills.upsert",
          source: "shelf-app",
          collectedAt: new Date().toISOString(),
          data: { id, title, amount, dueDay, leadDays, active: true }
        });
      }
      document.querySelector("#bill-title").value = "";
      document.querySelector("#bill-amount").value = "";
      await refreshMoney();
    } catch (e) {
      document.querySelector("#money-status").textContent = e.message || String(e);
    }
  });

  document.querySelector("#tx-list").addEventListener("change", async (event) => {
    const sel = event.target.closest(".tx-dir");
    if (!sel) return;
    const id = sel.dataset.tx;
    const direction = sel.value;
    const tx = state.transactions.find((t) => t.id === id);
    if (!tx || !direction) return;
    try {
      await Shelf.outbox.push({
        id: actionId("tx"),
        type: "action.transaction.update",
        source: "shelf-app",
        collectedAt: new Date().toISOString(),
        data: {
          id,
          direction,
          category: direction === "out" ? (tx.category || "uncategorized") : "",
          transferAccount: tx.transferAccount || ""
        }
      });
      await refreshMoney();
    } catch (e) {
      document.querySelector("#money-status").textContent = e.message || String(e);
    }
  });

  document.querySelector("#digest-refresh").addEventListener("click", () => {
    loadDigest().catch((e) => {
      document.querySelector("#digest-status").textContent = e.message;
    });
  });

  document.querySelector("#ai-propose").addEventListener("click", async () => {
    const status = document.querySelector("#digest-status");
    if (!Shelf.ai?.propose) {
      status.textContent = "AI not available on this bridge";
      return;
    }
    try {
      await Shelf.ai.setMode("LOCAL");
      const result = await Shelf.ai.propose();
      status.textContent = "AI " + result.mode + ": " +
        ((result.proposal?.flags || []).length) + " nudge(s)";
      await loadDigest();
    } catch (e) {
      status.textContent = e.message || String(e);
    }
  });

  document.querySelector("#tab-digest").addEventListener("click", async (event) => {
    const button = event.target.closest(".digest-action");
    if (!button) return;
    let targetRef = {};
    try { targetRef = JSON.parse(button.dataset.ref || "{}"); } catch (_e) {}
    button.disabled = true;
    try {
      const type = button.dataset.type;
      await Shelf.outbox.push({
        id: actionId("digest:" + type),
        type: type.startsWith("action.") ? type : "action." + type,
        source: "shelf-app",
        collectedAt: new Date().toISOString(),
        data: { targetRef }
      });
      await loadDigest();
    } catch (e) {
      document.querySelector("#digest-status").textContent = e.message || String(e);
      button.disabled = false;
    }
  });

  function setBridgeLabel() {
    document.querySelector("#bridge").textContent = Shelf.__hub
      ? (Shelf.__doorway
        ? "Hub live · Shelf doorway"
        : "Laptop hub · live data")
      : Shelf.__real
        ? "Shelf gateway · open hub URL for live data"
        : Shelf.__standalone || Shelf.__mock
          ? "Browser preview only · open hub URL in Shelf"
          : "Shelf";
    const setup = document.querySelector("#setup-link");
    if (setup) setup.hidden = !(Shelf.__hub || location.protocol === "http:" || location.protocol === "https:");
  }

  async function updateSyncStatus() {
    const status = document.querySelector("#sync-status");
    try {
      const [snap, digest, tx] = await Promise.all([
        Shelf.data.get("snapshot").catch(() => null),
        Shelf.data.get("digest").catch(() => null),
        Shelf.data.get("transactions").catch(() => null)
      ]);
      const n = (tx?.transactions || tx?.rows || []).length;
      if (snap || digest || n) {
        status.textContent =
          "Live from hub · " + n + " tx · snapshot " + (snap ? "yes" : "no") +
          " · digest " + (digest ? "yes" : "no");
      } else {
        status.textContent = "Connected bridge, but no hub data yet — check Setup / SimpleFIN.";
      }
    } catch (e) {
      status.textContent = e.message || String(e);
    }
  }

  async function loadDoorway() {
    const hubBlock = document.querySelector("#sync-hub-block");
    const offlineBlock = document.querySelector("#sync-offline-block");
    const onHub = Boolean(Shelf.__hub) || location.protocol === "http:" || location.protocol === "https:";
    if (!onHub || location.protocol === "file:") {
      hubBlock.hidden = true;
      offlineBlock.hidden = false;
      document.querySelector("#sync-status").textContent = "Offline file — use the hub Sync tab URL in Shelf.";
      return;
    }
    hubBlock.hidden = false;
    offlineBlock.hidden = true;
    try {
      const res = await fetch("/api/sync/phone");
      const card = await res.json();
      if (!res.ok) throw new Error(card.error || "Doorway info failed");
      const urlEl = document.querySelector("#phone-url");
      const qr = document.querySelector("#phone-qr");
      const hint = document.querySelector("#sync-hint");
      const meta = document.querySelector("#sync-meta");
      if (!card.lanBound) {
        urlEl.textContent = card.localUrl + " (laptop only)";
        qr.innerHTML = '<p class="muted" style="color:#333;padding:12px;text-align:center">LAN off — set HUB_HOST=0.0.0.0 and restart the hub</p>';
      } else if (card.preferredUrl) {
        urlEl.textContent = card.preferredUrl;
        qr.innerHTML = card.svg || "";
      } else {
        urlEl.textContent = "No LAN IPv4 address found";
        qr.textContent = "";
      }
      hint.textContent = card.hint || "";
      meta.textContent =
        "Fingerprint " + (card.fingerprint || "—") +
        (card.urls && card.urls.length > 1 ? " · also " + card.urls.slice(1).join(", ") : "");
      await updateSyncStatus();
    } catch (e) {
      document.querySelector("#phone-url").textContent = "Could not load doorway info";
      document.querySelector("#phone-qr").textContent = "";
      document.querySelector("#sync-status").textContent = e.message || String(e);
    }
  }

  document.querySelector("#sync-refresh")?.addEventListener("click", async () => {
    try {
      await refreshMoney();
      await loadDigest();
      await updateSyncStatus();
      document.querySelector("#sync-status").textContent += " · refreshed";
    } catch (e) {
      document.querySelector("#sync-status").textContent = e.message || String(e);
    }
  });

  document.querySelector("#sync-reload-doorway")?.addEventListener("click", () => {
    loadDoorway().catch(() => {});
  });

  async function boot() {
    if (!window.Shelf || typeof Shelf.data?.get !== "function") {
      throw new Error("window.Shelf is missing");
    }
    setBridgeLabel();
    await refreshMoney();
    await loadDigest();
    if (document.querySelector("#tab-sync")?.classList.contains("on")) {
      await loadDoorway();
    }
  }

  window.addEventListener("shelf-hub-ready", () => {
    setBridgeLabel();
    refreshMoney().catch(() => {});
    loadDigest().catch(() => {});
    loadDoorway().catch(() => {});
  });

  boot().catch((error) => {
    const box = document.querySelector("#boot-error");
    box.hidden = false;
    box.textContent = "Failed: " + (error.message || error);
  });
  </script>
</body>
</html>
`;

// Fix accidental double-escaped quotes from template construction in fillList watching/junk
const fixed = html
  .replace(/class=\\"row\\"/g, 'class="row"')
  .replace(/\\\\"/g, '"');

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, fixed);
if (fs.existsSync(legacyShelfHtml)) {
  fs.unlinkSync(legacyShelfHtml);
  console.log("Removed legacy", legacyShelfHtml);
}
console.log("Wrote", outPath, "(" + Math.round(fixed.length / 1024) + " KB)");
