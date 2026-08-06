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
const ai = require("./ai.js");
const pairing = require("./pairing.js");
const importer = require("./import/index.js");

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
    "Cache-Control": "no-store"
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
  // Never rewrite "/" in-place: relative script URLs in money.html would resolve
  // from "/" and 404 (/shelf/... instead of /apps/shelf/...). Redirect instead.
  if (urlPath === "/") {
    res.writeHead(302, {
      Location: "/apps/hub/home.html",
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
    sendJson(res, 404, { error: "Not found" });
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
        if (req.method === "GET" && pathname === "/api/health") {
          return sendJson(res, 200, {
            ok: true,
            database: "sqlcipher",
            milestone: "M7",
            syncKeyFingerprint: cryptoUtil.keyFingerprint(projectRoot),
            connectors: await secretStore.listConfiguredConnectors(),
            aiMode: ai.getAiMode(db),
            pairingPath: "/apps/hub/pairing.html",
            homePath: "/apps/hub/home.html",
            lifeCapture: true
          });
        }

        if (req.method === "GET" && pathname === "/api/transactions") {
          const settings = dbApi.getSettings(db);
          return sendJson(res, 200, {
            kind: "transactions",
            rows: dbApi.listTransactions(db),
            asOfDate: settings.asOfDate,
            settings: {
              monthlyIncome: settings.monthlyIncome,
              weeklyIncome: settings.weeklyIncome,
              weeklySavingsTarget: settings.weeklySavingsTarget
            },
            accounts: dbApi.listAccounts(db)
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

        if (req.method === "POST" && pathname === "/api/import") {
          const body = await readBody(req, { maxBytes: 8 * 1024 * 1024 });
          if (!body.accountId || body.text == null) {
            return sendJson(res, 400, { error: "accountId and text are required" });
          }
          const result = importer.importText(db, {
            accountId: body.accountId,
            text: body.text,
            format: body.format || "auto"
          });
          await sync.publishDown(db, projectRoot, syncRoot);
          return sendJson(res, 200, result);
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
            updateOpeningBalance: body.updateOpeningBalance === true
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

        if (req.method === "GET" && pathname === "/api/snapshot") {
          const snapshot = dbApi.computeLiveSnapshot(db);
          return sendJson(res, 200, {
            kind: "snapshot",
            ...dbApi.redactSnapshot(snapshot)
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
          items.forEach((item) => {
            dbApi.upsertSyncItem(db, item);
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
            reading: digest.reading,
            junk: digest.junk,
            generatedAt: digest.generatedAt,
            asOfDate: digest.asOfDate
          });
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

        if (req.method === "GET" && pathname === "/api/digest") {
          const digest = sync.buildDigest(db);
          return sendJson(res, 200, {
            kind: "digest",
            today: digest.today,
            watching: digest.watching || [],
            reading: digest.reading,
            junk: digest.junk,
            generatedAt: digest.generatedAt,
            asOfDate: digest.asOfDate
          });
        }

        if (req.method === "POST" && pathname === "/api/connectors/run") {
          const body = await readBody(req);
          // Default mock so a casual POST never hits live GroupMe.
          const forceMock = body.forceMock !== false;
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
            simplefin: {
              mode: result.simplefin.mode,
              inserted: result.simplefin.inserted,
              unmapped: result.simplefin.unmapped?.length || 0
            }
          });
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
    console.log(`Hub home:  http://${HOST}:${PORT}/apps/hub/home.html`);
    console.log(`Money UI:  http://${HOST}:${PORT}/apps/money/money.html`);
    console.log(`Digest UI: http://${HOST}:${PORT}/apps/digest/digest.html`);
    console.log(`Pair phone: http://${HOST}:${PORT}/apps/hub/pairing.html`);
    console.log(`SimpleFIN:  http://${HOST}:${PORT}/apps/hub/simplefin.html`);
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
