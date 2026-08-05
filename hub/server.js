"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const dbApi = require("./db.js");
const sync = require("./sync.js");
const connectors = require("./connectors/index.js");
const ai = require("./ai.js");
const cryptoUtil = require("./crypto.js");

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
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
  const full = path.join(root, cleaned);
  if (!full.startsWith(root)) return null;
  return full;
}

function serveStatic(req, res, urlPath) {
  let relative = urlPath === "/" ? "/apps/money/money.html" : urlPath;
  const filePath = safeJoin(ROOT, relative);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
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

function createServer(db) {
  sync.ensureSyncLayout(SYNC_ROOT);
  cryptoUtil.loadOrCreateKey(ROOT);

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${HOST}:${PORT}`);
      const { pathname } = url;

      if (pathname.startsWith("/api/")) {
        if (req.method === "GET" && pathname === "/api/health") {
          return sendJson(res, 200, {
            ok: true,
            aiMode: ai.getAiMode(db),
            syncKeyFingerprint: cryptoUtil.keyFingerprint(ROOT)
          });
        }

        if (req.method === "GET" && pathname === "/api/transactions") {
          return sendJson(res, 200, {
            transactions: dbApi.listTransactions(db),
            settings: dbApi.getSettings(db)
          });
        }

        if (req.method === "GET" && pathname === "/api/snapshot") {
          const settings = Object.fromEntries(url.searchParams.entries());
          const parsed = {
            monthlyIncome: settings.monthlyIncome
              ? Number(settings.monthlyIncome)
              : undefined,
            weeklyIncome: settings.weeklyIncome
              ? Number(settings.weeklyIncome)
              : undefined,
            weeklySavingsTarget: settings.weeklySavingsTarget
              ? Number(settings.weeklySavingsTarget)
              : undefined,
            asOfDate: settings.asOfDate
          };
          const snapshot = dbApi.computeLiveSnapshot(db, parsed);
          return sendJson(res, 200, {
            snapshot,
            redacted: dbApi.redactSnapshot(snapshot)
          });
        }

        if (req.method === "POST" && pathname === "/api/settings") {
          const body = await readBody(req);
          dbApi.saveSettings(db, body);
          return sendJson(res, 200, { settings: dbApi.getSettings(db) });
        }

        if (req.method === "POST" && pathname === "/api/commit") {
          const body = await readBody(req);
          if (!Array.isArray(body.updates)) {
            return sendJson(res, 400, { error: "updates[] required" });
          }
          const result = dbApi.commitTransactions(db, body.updates);
          if (body.settings) dbApi.saveSettings(db, body.settings);
          await sync.publishDown(db, ROOT, SYNC_ROOT);
          return sendJson(res, 200, result);
        }

        if (req.method === "POST" && pathname === "/api/sync/ingest") {
          const processed = await sync.ingestAllPending(db, ROOT, SYNC_ROOT);
          return sendJson(res, 200, {
            processed,
            digest: sync.buildDigest(db),
            items: dbApi.listSyncItems(db)
          });
        }

        if (req.method === "GET" && pathname === "/api/digest") {
          return sendJson(res, 200, {
            digest: sync.buildDigest(db),
            items: dbApi.listSyncItems(db)
          });
        }

        if (req.method === "POST" && pathname === "/api/connectors/run") {
          const body = await readBody(req);
          const result = await connectors.runAll(db, {
            forceMock: body.forceMock !== false
          });
          await sync.publishDown(db, ROOT, SYNC_ROOT);
          return sendJson(res, 200, result);
        }

        if (req.method === "GET" && pathname === "/api/ai/mode") {
          return sendJson(res, 200, { mode: ai.getAiMode(db) });
        }

        if (req.method === "POST" && pathname === "/api/ai/mode") {
          const body = await readBody(req);
          return sendJson(res, 200, { mode: ai.setAiMode(db, body.mode) });
        }

        if (req.method === "POST" && pathname === "/api/ai/propose") {
          const result = await ai.propose(db);
          return sendJson(res, 200, result);
        }

        if (req.method === "GET" && pathname === "/api/ai/proposals") {
          return sendJson(res, 200, { proposals: dbApi.listAiProposals(db) });
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

function main() {
  const db = dbApi.openDatabase();
  const server = createServer(db);
  server.listen(PORT, HOST, () => {
    console.log(`Finance hub listening on http://${HOST}:${PORT}`);
    console.log(`Money UI:  http://${HOST}:${PORT}/apps/money/money.html`);
    console.log(`Digest UI: http://${HOST}:${PORT}/apps/digest/digest.html`);
    console.log(`DB passphrase from HUB_DB_PASSPHRASE (default dev passphrase)`);
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
  main();
}

module.exports = { createServer, ROOT, SYNC_ROOT };
