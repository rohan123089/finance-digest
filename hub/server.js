"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const dbApi = require("./db.js");
const secretStore = require("./secret-store.js");
const sync = require("./sync.js");
const cryptoUtil = require("./crypto.js");
const connectors = require("./connectors/index.js");
const simplefin = require("./connectors/simplefin.js");
const gmail = require("./connectors/gmail.js");
const canvas = require("./connectors/canvas.js");
const groupme = require("./connectors/groupme.js");
const ai = require("./ai.js");
const pairing = require("./pairing.js");
const phoneDoorway = require("./phone-doorway.js");
const importer = require("./import/index.js");
const billsEngine = require("../engine/bills.js");
const rewardsEngine = require("../engine/rewards.js");
const rewardsWeb = require("./connectors/rewards-web.js");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.HUB_PORT || 8787);
const HOST = process.env.HUB_HOST || "127.0.0.1";
const SYNC_ROOT = process.env.HUB_SYNC_ROOT || path.join(ROOT, "sync");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(payload);
}

function readBody(req, options = {}) {
  const maxBytes = options.maxBytes || 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`JSON body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function safeJoin(root, requestPath) {
  const cleaned = path.normalize(requestPath).replace(/^([/\\])+/, "");
  const full = path.resolve(root, cleaned);
  const relative = path.relative(root, full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return full;
}

function serveStatic(req, res, urlPath) {
  // Never rewrite "/" in-place: relative script URLs would resolve from "/" and 404.
  // Also accept a few short aliases people type from the docs.
  const aliases = {
    "/": "/apps/app.html",
    "/shelf": "/apps/app.html",
    "/shelf.html": "/apps/app.html",
    "/shelf/shelf.html": "/apps/app.html",
    "/apps/shelf": "/apps/app.html",
    "/apps/shelf/": "/apps/app.html",
    "/apps/shelf/shelf.html": "/apps/app.html",
    "/home": "/apps/app.html",
    "/apps/hub/home.html": "/apps/app.html",
    "/app": "/apps/app.html",
    "/app.html": "/apps/app.html"
  };
  if (aliases[urlPath]) {
    res.writeHead(302, {
      Location: aliases[urlPath],
      "Cache-Control": "no-store"
    });
    res.end();
    return;
  }
  const relative = urlPath;
  const filePath = safeJoin(ROOT, relative);
  const allowedRoots = [
    path.join(ROOT, "apps"),
    path.join(ROOT, "engine"),
    path.join(ROOT, "examples")
  ];
  const isBrowserAsset = filePath && allowedRoots.some((allowedRoot) => {
    const within = path.relative(allowedRoot, filePath);
    return within === "" || (!within.startsWith("..") && !path.isAbsolute(within));
  });
  if (
    !isBrowserAsset ||
    !fs.existsSync(filePath) ||
    fs.statSync(filePath).isDirectory()
  ) {
    sendJson(res, 404, { error: "Not found", path: urlPath, try: "/apps/app.html" });
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}

function createServer(db, options = {}) {
  const projectRoot = options.projectRoot || ROOT;
  const syncRoot = options.syncRoot || SYNC_ROOT;
  sync.ensureSyncLayout(syncRoot);
  // Ensure the shared sync key exists without printing it.
  cryptoUtil.loadOrCreateKey(projectRoot);

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${HOST}:${PORT}`);
      const { pathname } = url;

      if (pathname.startsWith("/api/")) {
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "86400"
          });
          res.end();
          return;
        }

        if (req.method === "GET" && pathname === "/api/health") {
          const doorway = await phoneDoorway.buildPhoneDoorway(projectRoot, {
            host: HOST,
            port: PORT
          });
          return sendJson(res, 200, {
            ok: true,
            database: "sqlcipher",
            milestone: "M7",
            syncKeyFingerprint: cryptoUtil.keyFingerprint(projectRoot),
            connectors: await secretStore.listConfiguredConnectors(),
            aiMode: ai.getAiMode(db),
            pairingPath: "/apps/hub/pairing.html",
            homePath: "/apps/app.html",
            appPath: "/apps/app.html",
            lifeCapture: true,
            hubHost: HOST,
            hubPort: PORT,
            lanBound: doorway.lanBound,
            phoneUrl: doorway.preferredUrl,
            phoneUrls: doorway.urls
          });
        }

        if (req.method === "GET" && pathname === "/api/transactions") {
          const settings = dbApi.getSettings(db);
          const cursors = dbApi.getDataCursors(db);
          const since = url.searchParams.get("since") || "";
          const rows = since
            ? dbApi.listTransactionsSince(db, since)
            : dbApi.listTransactions(db);
          return sendJson(res, 200, {
            kind: "transactions",
            mode: since ? "delta" : "full",
            rows,
            changed: rows.length,
            asOfDate: settings.asOfDate,
            settings: {
              weeklySavingsTarget: settings.weeklySavingsTarget
            },
            accounts: dbApi.listAccounts(db),
            cursor: cursors.txCursor,
            txCount: cursors.txCount,
            settingsStamp: cursors.settingsStamp
          });
        }

        if (req.method === "GET" && pathname === "/api/accounts") {
          return sendJson(res, 200, {
            kind: "accounts",
            accounts: dbApi.listAccounts(db)
          });
        }

        if (req.method === "POST" && pathname === "/api/accounts") {
          const body = await readBody(req);
          const account = dbApi.createAccount(db, body);
          return sendJson(res, 200, { ok: true, account });
        }

        if (req.method === "PATCH" && pathname.startsWith("/api/accounts/")) {
          const id = decodeURIComponent(pathname.slice("/api/accounts/".length));
          const body = await readBody(req);
          const account = dbApi.updateAccount(db, id, body);
          return sendJson(res, 200, { ok: true, account });
        }

        if (req.method === "GET" && pathname === "/api/bills") {
          const settings = dbApi.getSettings(db);
          const bills = dbApi.listBills(db);
          const upcoming = billsEngine.upcomingReminders(bills, settings.asOfDate, {
            includeAll: true
          });
          return sendJson(res, 200, {
            kind: "bills",
            bills,
            upcoming: upcoming.map((row) => ({
              billId: row.bill.id,
              title: row.bill.title,
              amount: row.bill.amount,
              dueAt: row.dueAt,
              periodKey: row.periodKey,
              daysUntil: row.daysUntil,
              overdue: row.overdue,
              remind: row.remind,
              label: billsEngine.reminderTitle(row)
            }))
          });
        }

        if (req.method === "POST" && pathname === "/api/bills") {
          const body = await readBody(req);
          const id =
            body.id ||
            `bill:${String(body.title || "bill")
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "")
              .slice(0, 40)}`;
          const bill = dbApi.upsertBill(db, { ...body, id });
          await sync.publishDown(db, projectRoot, syncRoot);
          return sendJson(res, 200, { ok: true, bill });
        }

        if (req.method === "PATCH" && pathname.startsWith("/api/bills/")) {
          const id = decodeURIComponent(pathname.slice("/api/bills/".length));
          const body = await readBody(req);
          const existing = dbApi.getBill(db, id);
          if (!existing) return sendJson(res, 404, { error: "Bill not found" });
          if (body.paid === true || body.markPaid === true) {
            const settings = dbApi.getSettings(db);
            const next = billsEngine.nextDueForBill(existing, settings.asOfDate);
            const bill = dbApi.markBillPaid(
              db,
              id,
              body.periodKey || next.periodKey
            );
            await sync.publishDown(db, projectRoot, syncRoot);
            return sendJson(res, 200, { ok: true, bill });
          }
          const bill = dbApi.upsertBill(db, { ...existing, ...body, id });
          await sync.publishDown(db, projectRoot, syncRoot);
          return sendJson(res, 200, { ok: true, bill });
        }

        if (req.method === "DELETE" && pathname.startsWith("/api/bills/")) {
          const id = decodeURIComponent(pathname.slice("/api/bills/".length));
          dbApi.deleteBill(db, id);
          await sync.publishDown(db, projectRoot, syncRoot);
          return sendJson(res, 200, { ok: true });
        }

        if (req.method === "POST" && pathname === "/api/import") {
          const body = await readBody(req, { maxBytes: 8 * 1024 * 1024 });
          if (!body.accountId || (body.text == null && body.base64 == null)) {
            return sendJson(res, 400, {
              error: "accountId and text (or base64 for PDF) are required"
            });
          }
          const result = await importer.importText(db, {
            accountId: body.accountId,
            text: body.text,
            base64: body.base64,
            format: body.format || "auto",
            label: body.label || body.fileName || ""
          });
          await sync.publishDown(db, projectRoot, syncRoot);
          return sendJson(res, 200, result);
        }

        if (req.method === "GET" && pathname === "/api/imports") {
          return sendJson(res, 200, {
            kind: "imports",
            batches: dbApi.listImportBatches(db, 30)
          });
        }

        if (req.method === "DELETE" && pathname.startsWith("/api/imports/")) {
          const id = decodeURIComponent(pathname.slice("/api/imports/".length));
          if (!id) return sendJson(res, 400, { error: "import id required" });
          try {
            const result = dbApi.deleteImportBatch(db, id);
            await sync.publishDown(db, projectRoot, syncRoot);
            return sendJson(res, 200, result);
          } catch (error) {
            return sendJson(res, 404, { error: error.message || String(error) });
          }
        }

        if (req.method === "POST" && pathname === "/api/simplefin/claim") {
          const body = await readBody(req);
          if (!body.setupToken) {
            return sendJson(res, 400, { error: "setupToken is required" });
          }
          const result = await simplefin.claimSetupToken(body.setupToken, {
            fetchImpl: options.fetchImpl
          });
          return sendJson(res, 200, result);
        }

        if (req.method === "GET" && pathname === "/api/simplefin/remote") {
          const configured = Boolean(
            await secretStore.getConnectorSecret("simplefin.accessUrl")
          );
          if (!configured) {
            return sendJson(res, 200, {
              configured: false,
              accounts: [],
              local: dbApi.listAccounts(db)
            });
          }
          try {
            const payload = await simplefin.fetchAccounts({
              fetchImpl: options.fetchImpl
            });
            const remote = simplefin.listRemoteAccounts(payload);
            const local = dbApi.listAccounts(db);
            return sendJson(res, 200, {
              configured: true,
              accounts: remote.map((account) => ({
                ...account,
                linkedAccountId:
                  local.find((row) => row.simplefinAccountId === account.id)?.id ||
                  null
              })),
              local
            });
          } catch (error) {
            return sendJson(res, 502, {
              configured: true,
              error: error.message || String(error),
              accounts: [],
              local: dbApi.listAccounts(db)
            });
          }
        }

        if (req.method === "POST" && pathname === "/api/simplefin/map") {
          const body = await readBody(req);
          if (!body.accountId || !body.simplefinAccountId) {
            return sendJson(res, 400, {
              error: "accountId and simplefinAccountId are required"
            });
          }
          const account = dbApi.updateAccount(db, body.accountId, {
            simplefinAccountId: body.simplefinAccountId
          });
          return sendJson(res, 200, { ok: true, account });
        }

        if (req.method === "POST" && pathname === "/api/simplefin/sync") {
          const body = await readBody(req);
          const forceMock = body.forceMock === true;
          const result = await simplefin.syncToDb(db, {
            forceMock,
            fetchImpl: options.fetchImpl,
            updateOpeningBalance: body.updateOpeningBalance !== false
          });
          await sync.publishDown(db, projectRoot, syncRoot);
          return sendJson(res, 200, {
            ok: true,
            mode: result.mode,
            inserted: result.inserted,
            unmapped: result.unmapped,
            remote: result.remote
          });
        }

        if (req.method === "GET" && pathname === "/api/gmail/status") {
          return sendJson(res, 200, await gmail.getStatus());
        }

        if (req.method === "POST" && pathname === "/api/gmail/client") {
          const body = await readBody(req);
          try {
            const result = await gmail.saveClientCredentials(
              body.clientId,
              body.clientSecret
            );
            return sendJson(res, 200, result);
          } catch (error) {
            return sendJson(res, 400, { error: error.message || String(error) });
          }
        }

        if (req.method === "GET" && pathname === "/api/gmail/auth-url") {
          try {
            const url = new URL(req.url, `http://${HOST}:${PORT}`);
            const slot = url.searchParams.get("slot") || "1";
            const result = await gmail.buildAuthUrl({
              host: HOST,
              port: PORT,
              slot
            });
            return sendJson(res, 200, result);
          } catch (error) {
            return sendJson(res, 400, { error: error.message || String(error) });
          }
        }

        if (req.method === "GET" && pathname === "/api/gmail/callback") {
          const url = new URL(req.url, `http://${HOST}:${PORT}`);
          const err = url.searchParams.get("error");
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const fail = (message) => {
            res.writeHead(302, {
              Location: `/apps/hub/gmail.html?error=${encodeURIComponent(message)}`
            });
            res.end();
          };
          if (err) return fail(err);
          if (!code) return fail("Missing authorization code");
          const consumed = gmail.consumeOAuthState(state);
          if (!consumed) {
            return fail("OAuth state expired or invalid — try Connect again");
          }
          try {
            const result = await gmail.exchangeCode(code, {
              host: HOST,
              port: PORT,
              slot: consumed.slot,
              fetchImpl: options.fetchImpl
            });
            const emailQs = result.email
              ? `&email=${encodeURIComponent(result.email)}`
              : "";
            res.writeHead(302, {
              Location: `/apps/hub/gmail.html?connected=1&slot=${result.slot}${emailQs}`
            });
            res.end();
          } catch (error) {
            return fail(error.message || String(error));
          }
          return;
        }

        if (req.method === "POST" && pathname === "/api/gmail/test") {
          try {
            const body = await readBody(req).catch(() => ({}));
            const result = await connectors.runEmail(db, {
              forceMock: false,
              slot: body?.slot
            });
            await sync.publishDown(db, projectRoot, syncRoot);
            return sendJson(res, 200, {
              ok: true,
              mode: result.mode,
              emitted: result.emitted.length,
              accounts: result.accounts || []
            });
          } catch (error) {
            return sendJson(res, 502, { error: error.message || String(error) });
          }
        }

        if (req.method === "POST" && pathname === "/api/gmail/disconnect") {
          const body = await readBody(req).catch(() => ({}));
          if (body?.slot != null) {
            await gmail.disconnectAccount(body.slot);
          } else {
            await gmail.disconnect();
          }
          return sendJson(res, 200, { ok: true });
        }

        if (req.method === "GET" && pathname === "/api/canvas/status") {
          return sendJson(res, 200, await canvas.getStatus());
        }

        if (req.method === "POST" && pathname === "/api/canvas/client") {
          const body = await readBody(req);
          try {
            const result = await canvas.saveCredentials(body.baseUrl, body.token);
            return sendJson(res, 200, result);
          } catch (error) {
            return sendJson(res, 400, { error: error.message || String(error) });
          }
        }

        if (req.method === "POST" && pathname === "/api/canvas/test") {
          const body = await readBody(req);
          try {
            const result = await connectors.runCanvas(db, {
              forceMock: body.forceMock === true,
              fetchImpl: options.fetchImpl
            });
            await sync.publishDown(db, projectRoot, syncRoot);
            return sendJson(res, 200, {
              ok: true,
              mode: result.mode,
              emitted: result.emitted.length,
              counts: result.counts,
              error: result.error || null
            });
          } catch (error) {
            return sendJson(res, 502, { error: error.message || String(error) });
          }
        }

        if (req.method === "POST" && pathname === "/api/canvas/disconnect") {
          await canvas.disconnect();
          return sendJson(res, 200, { ok: true });
        }

        if (req.method === "GET" && pathname === "/api/groupme/status") {
          return sendJson(res, 200, await groupme.getStatus());
        }

        if (req.method === "POST" && pathname === "/api/groupme/client") {
          const body = await readBody(req);
          try {
            const token = String(body?.token || "").trim();
            let groupIds =
              body?.groupIds != null
                ? body.groupIds
                : body?.groupId != null
                  ? body.groupId
                  : null;
            if (
              (groupIds == null ||
                (Array.isArray(groupIds) && groupIds.length === 0)) &&
              Array.isArray(body?.groups) &&
              body.groups.length
            ) {
              groupIds = body.groups.map((row) => row?.id).filter(Boolean);
            }
            const hasGroups =
              groupIds != null &&
              !(Array.isArray(groupIds) && groupIds.length === 0) &&
              !(typeof groupIds === "string" && !String(groupIds).trim());

            if (token && hasGroups) {
              const result = await groupme.saveCredentials(
                token,
                groupIds,
                body.groups || body.meta
              );
              return sendJson(res, 200, { ...result, ...(await groupme.getStatus()) });
            }
            if (token && !hasGroups) {
              const result = await groupme.saveToken(token);
              return sendJson(res, 200, { ...result, ...(await groupme.getStatus()) });
            }
            if (!token && hasGroups) {
              const result = await groupme.saveGroupIds(
                groupIds,
                body.groups || body.meta
              );
              return sendJson(res, 200, { ...result, ...(await groupme.getStatus()) });
            }
            throw new Error(
              "Paste your GroupMe access token and select at least one group"
            );
          } catch (error) {
            return sendJson(res, 400, { error: error.message || String(error) });
          }
        }

        if (req.method === "GET" && pathname === "/api/groupme/groups") {
          try {
            const groups = await groupme.listGroups({
              fetchImpl: options.fetchImpl
            });
            return sendJson(res, 200, { groups });
          } catch (error) {
            return sendJson(res, 502, { error: error.message || String(error) });
          }
        }

        if (req.method === "POST" && pathname === "/api/groupme/test") {
          const body = await readBody(req);
          try {
            const result = await connectors.runGroupMe(db, {
              forceMock: body.forceMock === true,
              fetchImpl: options.fetchImpl
            });
            await sync.publishDown(db, projectRoot, syncRoot);
            return sendJson(res, 200, {
              ok: true,
              mode: result.mode,
              emitted: result.emitted.length,
              groupIds: result.groupIds || [],
              byGroup: result.byGroup || {},
              error: result.error || null
            });
          } catch (error) {
            return sendJson(res, 502, { error: error.message || String(error) });
          }
        }

        if (req.method === "POST" && pathname === "/api/groupme/disconnect") {
          await groupme.disconnect();
          return sendJson(res, 200, { ok: true });
        }

        if (req.method === "GET" && pathname === "/api/snapshot") {
          const cursors = dbApi.getDataCursors(db);
          const txCursor = url.searchParams.get("txCursor") || "";
          const settingsStamp = url.searchParams.get("settingsStamp") || "";
          const asOfDate = url.searchParams.get("asOfDate") || "";
          if (
            txCursor &&
            txCursor === cursors.txCursor &&
            settingsStamp === cursors.settingsStamp &&
            (!asOfDate || asOfDate === cursors.asOfDate)
          ) {
            return sendJson(res, 200, {
              kind: "snapshot",
              unchanged: true,
              cursor: cursors
            });
          }
          const snapshot = dbApi.computeLiveSnapshot(db);
          return sendJson(res, 200, {
            kind: "snapshot",
            unchanged: false,
            ...dbApi.redactSnapshot(snapshot),
            cursor: cursors
          });
        }

        if (req.method === "POST" && pathname === "/api/outbox") {
          const body = await readBody(req);
          const items = Array.isArray(body)
            ? body
            : Array.isArray(body.items)
              ? body.items
              : body.item
                ? [body.item]
                : [];
          if (!items.length || items.some((item) => !item?.id || !item?.type)) {
            return sendJson(res, 400, {
              error: "items[] with stable id and type is required"
            });
          }
          const existingIds = new Set(dbApi.listSyncItems(db).map((item) => item.id));
          let expanded = 0;
          items.forEach((item) => {
            dbApi.upsertSyncItem(db, item);
            const lifeSignals = sync.expandIncomingLifeItem(db, item);
            expanded += lifeSignals.length;
            if (existingIds.has(item.id)) return;
            if (item.type === "action.transaction.update" && item.data) {
              dbApi.commitTransactions(db, [item.data]);
              dbApi.markActionExecuted(db, item.id, "executed", "Transaction updated");
            } else if (item.type === "action.settings.update" && item.data) {
              dbApi.saveSettings(db, item.data);
              dbApi.markActionExecuted(db, item.id, "executed", "Settings updated");
            }
          });
          sync.executePendingActions(db);
          await sync.publishDown(db, projectRoot, syncRoot);
          return sendJson(res, 200, {
            queued: items.length,
            expanded,
            total: dbApi.listSyncItems(db).length
          });
        }

        if (req.method === "POST" && pathname === "/api/sync/ingest") {
          const processed = await sync.ingestAllPending(db, projectRoot, syncRoot);
          const digest = sync.buildDigest(db);
          return sendJson(res, 200, {
            processed,
            kind: "digest",
            today: digest.today,
            watching: digest.watching || [],
            reading: digest.reading,
            junk: digest.junk,
            generatedAt: digest.generatedAt,
            asOfDate: digest.asOfDate
          });
        }

        if (req.method === "GET" && pathname === "/api/calendar/ics") {
          const itemId = url.searchParams.get("itemId");
          if (!itemId) {
            return sendJson(res, 400, { error: "itemId is required" });
          }
          const ics = sync.icsForItemId(db, itemId);
          if (!ics) {
            return sendJson(res, 404, {
              error: "No calendar event for that item (need a start or due date)"
            });
          }
          const safeName = String(itemId).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
          res.writeHead(200, {
            "Content-Type": "text/calendar; charset=utf-8",
            "Content-Disposition": `attachment; filename="${safeName}.ics"`,
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*"
          });
          res.end(ics);
          return;
        }

        if (req.method === "GET" && pathname === "/api/sync/pairing") {
          const card = await pairing.buildPairing(projectRoot, {
            hubUrl: `http://${HOST}:${PORT}`
          });
          // Return QR SVG + fingerprint only — do not also echo the raw key JSON.
          return sendJson(res, 200, {
            fingerprint: card.fingerprint,
            hub: card.hub,
            generatedAt: card.generatedAt,
            svg: card.svg
          });
        }

        if (req.method === "GET" && pathname === "/api/sync/phone") {
          const card = await phoneDoorway.buildPhoneDoorway(projectRoot, {
            host: HOST,
            port: PORT
          });
          return sendJson(res, 200, card);
        }

        if (req.method === "GET" && pathname === "/api/digest") {
          const cursors = dbApi.getDataCursors(db);
          const syncCursor = url.searchParams.get("syncCursor") || "";
          const billsCursor = url.searchParams.get("billsCursor") || "";
          const asOfDate = url.searchParams.get("asOfDate") || "";
          if (
            syncCursor &&
            syncCursor === cursors.syncCursor &&
            billsCursor === cursors.billsCursor &&
            (!asOfDate || asOfDate === cursors.asOfDate)
          ) {
            return sendJson(res, 200, {
              kind: "digest",
              unchanged: true,
              cursor: cursors
            });
          }
          const digest = sync.buildDigest(db);
          return sendJson(res, 200, {
            kind: "digest",
            unchanged: false,
            today: digest.today,
            watching: digest.watching || [],
            reading: digest.reading,
            junk: digest.junk,
            generatedAt: digest.generatedAt,
            asOfDate: digest.asOfDate,
            cursor: cursors
          });
        }

        if (req.method === "POST" && pathname === "/api/connectors/run") {
          const body = await readBody(req);
          // Opt-in mock only — default is live-or-skip so casual runs never
          // write fake GroupMe/email/bank rows into the real database.
          const forceMock = body.forceMock === true;
          const result = await connectors.runAll(db, { forceMock });
          await sync.publishDown(db, projectRoot, syncRoot);
          return sendJson(res, 200, {
            forceMock,
            groupme: {
              mode: result.groupme.mode,
              emitted: result.groupme.emitted.length
            },
            sms: {
              mode: result.sms.mode,
              emitted: result.sms.emitted.length
            },
            email: {
              mode: result.email.mode,
              emitted: result.email.emitted.length
            },
            bank: {
              mode: result.bank.mode,
              emitted: result.bank.emitted.length
            },
            canvas: {
              mode: result.canvas.mode,
              emitted: result.canvas.emitted.length,
              error: result.canvas.error || null
            },
            simplefin: {
              mode: result.simplefin.mode,
              inserted: result.simplefin.inserted,
              unmapped: result.simplefin.unmapped?.length || 0
            },
            rewards: {
              mode: result.rewards.mode,
              upserted: result.rewards.upserted,
              amexStatus: result.rewards.amexStatus,
              error: result.rewards.error || null
            }
          });
        }

        if (req.method === "GET" && pathname === "/api/rewards") {
          const result = rewardsEngine.optimize(
            dbApi.listTransactions(db),
            dbApi.listRewardsRules(db),
            dbApi.listRewardsOffers(db),
            { asOfDate: dbApi.getSettings(db).asOfDate }
          );
          return sendJson(res, 200, {
            ...result,
            rules: dbApi.listRewardsRules(db),
            offers: dbApi.listRewardsOffers(db),
            webStatus: dbApi.getMeta(db, "rewardsWebStatus", "never"),
            amexStatus: dbApi.getMeta(db, "rewardsAmexStatus", "seed_only")
          });
        }

        if (req.method === "GET" && pathname === "/api/rewards/optimize") {
          const result = rewardsEngine.optimize(
            dbApi.listTransactions(db),
            dbApi.listRewardsRules(db),
            dbApi.listRewardsOffers(db),
            { asOfDate: dbApi.getSettings(db).asOfDate }
          );
          return sendJson(res, 200, result);
        }

        if (req.method === "POST" && pathname === "/api/rewards/refresh") {
          const body = await readBody(req);
          const forceMock = body.forceMock === true;
          const result = await rewardsWeb.syncRewards(db, {
            forceMock,
            fetchImpl: options.fetchImpl
          });
          return sendJson(res, 200, result);
        }

        if (req.method === "GET" && pathname === "/api/rewards/rules") {
          return sendJson(res, 200, { rules: dbApi.listRewardsRules(db) });
        }

        if (req.method === "POST" && pathname === "/api/rewards/rules") {
          const body = await readBody(req);
          if (!body.id) {
            body.id = `rule:manual:${body.accountId || "card"}:${body.category || "*"}:${Date.now()}`;
          }
          body.source = "manual";
          const rule = dbApi.upsertRewardsRule(db, body);
          return sendJson(res, 200, { ok: true, rule });
        }

        if (req.method === "PATCH" && pathname.startsWith("/api/rewards/rules/")) {
          const id = decodeURIComponent(pathname.slice("/api/rewards/rules/".length));
          const body = await readBody(req);
          const existing = dbApi.getRewardsRule(db, id);
          if (!existing) return sendJson(res, 404, { error: "Unknown rule" });
          const rule = dbApi.upsertRewardsRule(db, {
            ...existing,
            ...body,
            id,
            source: "manual"
          });
          return sendJson(res, 200, { ok: true, rule });
        }

        if (req.method === "DELETE" && pathname.startsWith("/api/rewards/rules/")) {
          const id = decodeURIComponent(pathname.slice("/api/rewards/rules/".length));
          return sendJson(res, 200, dbApi.deleteRewardsRule(db, id));
        }

        if (req.method === "GET" && pathname === "/api/rewards/offers") {
          return sendJson(res, 200, { offers: dbApi.listRewardsOffers(db) });
        }

        if (req.method === "POST" && pathname === "/api/rewards/offers") {
          const body = await readBody(req);
          if (!body.id) {
            body.id = `offer:manual:${body.accountId || "card"}:${Date.now()}`;
          }
          body.source = "manual";
          const offer = dbApi.upsertRewardsOffer(db, body);
          return sendJson(res, 200, { ok: true, offer });
        }

        if (req.method === "PATCH" && pathname.startsWith("/api/rewards/offers/")) {
          const id = decodeURIComponent(pathname.slice("/api/rewards/offers/".length));
          const body = await readBody(req);
          const existing = dbApi.getRewardsOffer(db, id);
          if (!existing) return sendJson(res, 404, { error: "Unknown offer" });
          const offer = dbApi.upsertRewardsOffer(db, {
            ...existing,
            ...body,
            id,
            source: "manual"
          });
          return sendJson(res, 200, { ok: true, offer });
        }

        if (req.method === "GET" && pathname === "/api/ai/mode") {
          return sendJson(res, 200, { mode: ai.getAiMode(db) });
        }

        if (req.method === "POST" && pathname === "/api/ai/mode") {
          const body = await readBody(req);
          return sendJson(res, 200, { mode: ai.setAiMode(db, body.mode) });
        }

        if (req.method === "POST" && pathname === "/api/ai/propose") {
          const before = dbApi.listTransactions(db).length;
          const result = await ai.propose(db);
          const after = dbApi.listTransactions(db).length;
          if (after !== before) {
            return sendJson(res, 500, { error: "AI propose mutated transactions" });
          }
          await sync.publishDown(db, projectRoot, syncRoot);
          return sendJson(res, 200, result);
        }

        if (req.method === "GET" && pathname === "/api/ai/proposals") {
          return sendJson(res, 200, {
            proposals: dbApi.listAiProposals(db).map((row) => ({
              id: row.id,
              mode: row.mode,
              promptSummary: row.promptSummary,
              createdAt: row.createdAt,
              accepted: row.accepted,
              flags: row.body?.flags || [],
              mutations: row.body?.mutations || []
            }))
          });
        }

        return sendJson(res, 404, { error: "Unknown API route" });
      }

      if (req.method === "GET") return serveStatic(req, res, pathname);
      sendJson(res, 405, { error: "Method not allowed" });
    } catch (error) {
      console.error(error);
      sendJson(res, 500, { error: error.message || String(error) });
    }
  });
}

async function main() {
  const dbPath = process.env.HUB_DB_PATH || dbApi.DEFAULT_DB_PATH;
  const encryptionKey = await secretStore.getOrCreateDatabaseKey(dbPath);
  const db = dbApi.openDatabase({ dbPath, encryptionKey });
  sync.ensureSyncLayout(SYNC_ROOT);
  const server = createServer(db);
  server.listen(PORT, HOST, () => {
    console.log(`Finance hub listening on http://${HOST}:${PORT}`);
    console.log(`App: http://127.0.0.1:${PORT}/apps/app.html`);
    console.log(`(Shelf = doorway; open the LAN app URL in Shelf for live hub data)`);
    if (phoneDoorway.isLanBound(HOST)) {
      const ips = phoneDoorway.listLanIPv4();
      if (ips.length) {
        console.log(`Phone (LAN): http://${ips[0]}:${PORT}/apps/app.html`);
      }
    } else {
      console.log(`Phone LAN: set HUB_HOST=0.0.0.0 then restart (Sync tab shows QR)`);
    }
    console.log(`Money UI:  http://127.0.0.1:${PORT}/apps/money/money.html`);
    console.log(`Digest UI: http://127.0.0.1:${PORT}/apps/digest/digest.html`);
    console.log(`Pair phone: http://127.0.0.1:${PORT}/apps/hub/pairing.html`);
    console.log(`SimpleFIN:  http://127.0.0.1:${PORT}/apps/hub/simplefin.html`);
    console.log(`Gmail:      http://127.0.0.1:${PORT}/apps/hub/gmail.html`);
    console.log(`Canvas:     http://127.0.0.1:${PORT}/apps/hub/canvas.html`);
    console.log(`GroupMe:    http://127.0.0.1:${PORT}/apps/hub/groupme.html`);
    console.log(`Encrypted DB key: ${secretStore.SERVICE} in the OS keychain`);
    console.log(`Sync folder: ${SYNC_ROOT}`);
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { createServer, ROOT, SYNC_ROOT };
