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
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
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
    .shell {
      max-width: 720px;
      margin: 0 auto;
      padding: calc(32px + env(safe-area-inset-top, 0px)) 14px 40px;
    }
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
      <div class="bridge" id="load-progress" hidden></div>
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
        <p class="warn-line">Not connected to the laptop hub yet.</p>
        <p class="muted">
          A downloaded / GitHub copy is preview-only. On the laptop keep the hub running with
          <code>HUB_HOST=0.0.0.0</code>, open Sync there, then paste that LAN URL here and open it in Shelf:
        </p>
        <label>Hub app URL
          <input id="hub-url-input" autocomplete="off" spellcheck="false"
            placeholder="http://192.168.x.x:8787/apps/app.html">
        </label>
        <div class="toolbar">
          <button type="button" class="act" id="hub-url-test">Test connection</button>
          <button type="button" class="act primary" id="hub-url-open">Open hub in Shelf</button>
        </div>
        <p class="muted" style="margin-top:10px">
          Use the exact URL from the laptop Sync tab. Phone + laptop must be on the same Wi‑Fi
          (on Google Wi‑Fi, enable device-to-device / client-to-client). Windows Firewall must allow port 8787.
        </p>
        <p class="muted" style="margin-top:10px">
          Example: <code>http://192.168.86.23:8787/apps/app.html</code>
        </p>
      </div>
      <p class="status" id="sync-status">—</p>
    </section>
  </div>

  <script>
  // Wire tabs immediately so the UI stays usable while larger scripts parse.
  (function () {
    "use strict";
    const bridge = document.querySelector("#bridge");
    if (bridge) bridge.textContent = "Loading…";
    document.querySelectorAll(".tabs button").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        document.querySelectorAll(".panel").forEach((p) => p.classList.remove("on"));
        const panel = document.querySelector("#tab-" + btn.dataset.tab);
        if (panel) panel.classList.add("on");
        try {
          if (btn.dataset.tab === "sync" && typeof window.__lifeLoadDoorway === "function") {
            window.__lifeLoadDoorway();
          }
        } catch (_e) {}
      });
    });
  })();
  </script>
  <script>
${hubShelf}
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

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(label + " timed out after " + ms / 1000 + "s")), ms);
      })
    ]);
  }

  async function waitForShelf(ms) {
    const deadline = Date.now() + (ms || 10000);
    while (Date.now() < deadline) {
      if (window.Shelf && typeof Shelf.data?.get === "function") return Shelf;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error("Shelf bridge did not load — hard-refresh or open via the hub URL");
  }

  const state = { transactions: [], snapshot: null, bills: [], billsUpcoming: [], labels: {} };
  const CACHE_KEY = "life.hubDataCache.v1";
  const loadStartedAt = { t: 0, step: 0, steps: 3 };

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && parsed.v === 1 ? parsed : null;
    } catch (_e) {
      return null;
    }
  }

  function writeCache(patch) {
    try {
      const prev = readCache() || { v: 1 };
      const next = { ...prev, ...patch, v: 1, savedAt: new Date().toISOString() };
      localStorage.setItem(CACHE_KEY, JSON.stringify(next));
      return next;
    } catch (_e) {
      return null;
    }
  }

  function mergeTransactions(existing, deltaRows) {
    const map = new Map((existing || []).map((row) => [row.id, row]));
    (deltaRows || []).forEach((row) => map.set(row.id, row));
    return [...map.values()].sort((a, b) => {
      if (a.date === b.date) return String(b.id).localeCompare(String(a.id));
      return String(b.date).localeCompare(String(a.date));
    });
  }

  function setProgress(stepLabel, stepIndex, totalSteps) {
    const el = document.querySelector("#load-progress");
    const bridge = document.querySelector("#bridge");
    if (!el) return;
    el.hidden = false;
    loadStartedAt.step = stepIndex;
    loadStartedAt.steps = totalSteps || loadStartedAt.steps || 3;
    if (!loadStartedAt.t) loadStartedAt.t = Date.now();
    const elapsed = (Date.now() - loadStartedAt.t) / 1000;
    let eta = "";
    if (stepIndex > 0 && stepIndex < loadStartedAt.steps) {
      const per = elapsed / stepIndex;
      const left = Math.max(0, Math.ceil(per * (loadStartedAt.steps - stepIndex)));
      eta = " · ~" + left + "s left";
    } else if (stepIndex >= loadStartedAt.steps) {
      eta = " · done in " + Math.max(1, Math.round(elapsed)) + "s";
    }
    const text =
      "Step " + stepIndex + "/" + loadStartedAt.steps + " · " + stepLabel + eta;
    el.textContent = text;
    if (bridge && /Loading|Connecting|Starting/i.test(bridge.textContent || "")) {
      bridge.textContent = stepLabel;
    }
  }

  function clearProgress(finalMsg) {
    const el = document.querySelector("#load-progress");
    if (!el) return;
    if (finalMsg) {
      el.hidden = false;
      el.textContent = finalMsg;
      setTimeout(() => {
        if (el.textContent === finalMsg) el.hidden = true;
      }, 4000);
    } else {
      el.hidden = true;
      el.textContent = "";
    }
    loadStartedAt.t = 0;
  }

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
    const cache = readCache() || {};
    setProgress(
      cache.digest ? "Checking digest for changes…" : "Loading digest (first pull)…",
      3,
      3
    );
    const digest = await Shelf.data.get("digest", {
      syncCursor: cache.syncCursor || "",
      billsCursor: cache.billsCursor || "",
      asOfDate: cache.asOfDate || ""
    });
    if (digest?.unchanged && cache.digest) {
      await renderDigestPayload(cache.digest);
      return cache.digest;
    }
    await renderDigestPayload(digest);
    if (digest && !digest.unchanged) {
      writeCache({
        digest,
        syncCursor: digest.cursor?.syncCursor || cache.syncCursor || "",
        billsCursor: digest.cursor?.billsCursor || cache.billsCursor || "",
        asOfDate: digest.asOfDate || digest.cursor?.asOfDate || cache.asOfDate || ""
      });
    }
    return digest;
  }

  async function renderDigestPayload(digest) {
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
    const cache = readCache() || {};
    const hasCache = Array.isArray(cache.transactions) && cache.transactions.length > 0;

    setProgress(
      hasCache ? "Pulling new/changed transactions…" : "Loading all transactions (first pull)…",
      1,
      3
    );
    const txPayload = await Shelf.data.get("transactions", {
      since: hasCache ? cache.txCursor || "" : ""
    });
    let rows;
    if (txPayload?.mode === "delta" && hasCache) {
      rows = mergeTransactions(cache.transactions, txPayload.transactions || txPayload.rows || []);
    } else {
      rows = txPayload?.transactions ?? txPayload?.rows ?? [];
    }

    setProgress(
      hasCache && cache.snapshot ? "Checking snapshot…" : "Computing snapshot…",
      2,
      3
    );
    const snap = await Shelf.data.get("snapshot", {
      txCursor: txPayload?.cursor || cache.txCursor || "",
      settingsStamp: txPayload?.settingsStamp || cache.settingsStamp || "",
      asOfDate: txPayload?.asOfDate || cache.asOfDate || ""
    });
    const snapshot = snap?.unchanged && cache.snapshot ? cache.snapshot : snap;

    const billsPayload = await (Shelf.bills?.list
      ? Shelf.bills.list()
      : Shelf.data.get("bills")
    ).catch(() => null);

    state.transactions = rows.map((r) => ({ ...r }));
    state.snapshot = snapshot && snapshot.kind ? snapshot : snapshot;
    if (state.snapshot && state.snapshot.unchanged) {
      // shouldn't happen if we merged cache above
      state.snapshot = cache.snapshot;
    }
    state.bills = billsPayload?.bills || [];
    state.billsUpcoming = billsPayload?.upcoming || [];
    const accounts = txPayload?.accounts || cache.accounts || [];
    state.labels = Object.fromEntries(accounts.map((a) => [a.id, a.label || a.id]));
    if (!Object.keys(state.labels).length && state.snapshot?.balances) {
      Object.keys(state.snapshot.balances).forEach((id) => { state.labels[id] = id; });
    }
    renderMoney();
    const mode = txPayload?.mode === "delta" && hasCache ? "delta" : "full";
    document.querySelector("#money-status").textContent =
      rows.length + " transactions · " + mode + " pull" +
      (txPayload?.changed != null && mode === "delta" ? " · " + txPayload.changed + " changed" : "") +
      " · as of " + (txPayload?.asOfDate || "—");

    writeCache({
      transactions: rows,
      accounts,
      snapshot: state.snapshot,
      txCursor: txPayload?.cursor || cache.txCursor || "",
      settingsStamp: txPayload?.settingsStamp || cache.settingsStamp || "",
      asOfDate: txPayload?.asOfDate || cache.asOfDate || "",
      txCount: txPayload?.txCount || rows.length
    });
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

  async function probeLiveHub() {
    if (Shelf && Shelf.__hub) return true;
    if (location.protocol === "file:") return false;
    try {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 900) : null;
      const res = await fetch("/api/health", ctrl ? { signal: ctrl.signal } : undefined);
      if (timer) clearTimeout(timer);
      if (!res.ok) return false;
      const body = await res.json().catch(() => null);
      return Boolean(body && body.ok);
    } catch (_error) {
      return false;
    }
  }

  async function loadDoorway() {
    const hubBlock = document.querySelector("#sync-hub-block");
    const offlineBlock = document.querySelector("#sync-offline-block");
    const live = await probeLiveHub();
    if (!live) {
      hubBlock.hidden = true;
      offlineBlock.hidden = false;
      const input = document.querySelector("#hub-url-input");
      try {
        const saved = localStorage.getItem("life.hubAppUrl");
        if (saved && input && !input.value) input.value = saved;
      } catch (_e) {}
      document.querySelector("#sync-status").textContent =
        "Preview only until you open the laptop hub URL in Shelf.";
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
        try { localStorage.setItem("life.hubAppUrl", card.preferredUrl); } catch (_e) {}
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

  function normalizeHubAppUrl(raw) {
    let url = String(raw || "").trim();
    if (!url) return "";
    if (!/^https?:\/\//i.test(url)) url = "http://" + url;
    if (!/\/apps\/app\.html/i.test(url)) {
      url = url.replace(/\/+$/, "") + "/apps/app.html";
    }
    return url;
  }

  document.querySelector("#hub-url-test")?.addEventListener("click", async () => {
    const status = document.querySelector("#sync-status");
    const url = normalizeHubAppUrl(document.querySelector("#hub-url-input")?.value);
    if (!url) {
      status.textContent = "Paste the hub URL first.";
      return;
    }
    status.textContent = "Testing " + url + " …";
    try {
      const base = new URL(url);
      const healthUrl = base.origin + "/api/health";
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 4000) : null;
      const res = await fetch(healthUrl, ctrl ? { signal: ctrl.signal } : undefined);
      if (timer) clearTimeout(timer);
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        status.textContent = "Reached something, but not the finance hub (HTTP " + res.status + ").";
        return;
      }
      status.textContent =
        "Reachable · LAN " + (body.lanBound ? "on" : "off") +
        (body.phoneUrl ? " · " + body.phoneUrl : "") +
        " — tap Open hub in Shelf.";
      try { localStorage.setItem("life.hubAppUrl", url); } catch (_e) {}
    } catch (e) {
      status.textContent =
        "Cannot reach hub from this phone (" + (e.name || "error") + "). Same Wi‑Fi? Firewall? Device-to-device on?";
    }
  });

  document.querySelector("#hub-url-open")?.addEventListener("click", () => {
    const input = document.querySelector("#hub-url-input");
    const url = normalizeHubAppUrl(input?.value);
    if (!url) {
      document.querySelector("#sync-status").textContent = "Paste the hub URL from the laptop Sync tab.";
      return;
    }
    try { localStorage.setItem("life.hubAppUrl", url); } catch (_e) {}
    document.querySelector("#sync-status").textContent = "Opening " + url + " …";
    location.href = url;
  });

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
    const bridge = document.querySelector("#bridge");
    const cache = readCache();
    if (cache?.snapshot && Array.isArray(cache.transactions)) {
      state.transactions = cache.transactions.map((r) => ({ ...r }));
      state.snapshot = cache.snapshot;
      state.labels = Object.fromEntries(
        (cache.accounts || []).map((a) => [a.id, a.label || a.id])
      );
      renderMoney();
      if (bridge) bridge.textContent = "Showing cached data · updating…";
      if (cache.digest) renderDigestPayload(cache.digest).catch(() => {});
    } else if (bridge) {
      bridge.textContent = "Connecting to hub…";
    }
    loadStartedAt.t = Date.now();
    await waitForShelf(12000);
    setBridgeLabel();
    try {
      await withTimeout(refreshMoney(), 20000, "Money load");
    } catch (e) {
      document.querySelector("#money-status").textContent = e.message || String(e);
      document.querySelector("#safe-detail").textContent = "Hub data load failed — check hub is running";
    }
    try {
      await withTimeout(loadDigest(), 20000, "Digest load");
    } catch (e) {
      document.querySelector("#digest-status").textContent = e.message || String(e);
    }
    const elapsed = Math.max(1, Math.round((Date.now() - (loadStartedAt.t || Date.now())) / 1000));
    const mode = readCache()?.txCursor ? "delta-ready" : "full";
    clearProgress("Caught up in " + elapsed + "s · next opens use changes only");
    setBridgeLabel();
    if (document.querySelector("#tab-sync")?.classList.contains("on")) {
      await loadDoorway().catch(() => {});
    }
  }

  window.__lifeLoadDoorway = () => loadDoorway().catch(() => {});

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
    const bridge = document.querySelector("#bridge");
    if (bridge) bridge.textContent = "Failed to start";
  });

  window.__lifeBoot = boot;
  </script>
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
${mockShelf}
  </script>
  <script>
  (function () {
    "use strict";
    if (window.Shelf && Shelf.__hub) return;
    if (!(window.Shelf && typeof Shelf.data?.get === "function")) return;
    const bridge = document.querySelector("#bridge");
    const stuck = bridge && /Connecting|Loading|Starting|Failed/i.test(bridge.textContent || "");
    if (stuck && typeof window.__lifeBoot === "function") {
      window.__lifeBoot().catch(() => {});
    }
  })();
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
