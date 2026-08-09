"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
const connectors = require("../hub/connectors/index.js");
const sync = require("../hub/sync.js");
const { createServer } = require("../hub/server.js");

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload)
            }
          : {}
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const type = res.headers["content-type"] || "";
          resolve({
            status: res.statusCode,
            body: text && type.includes("json") ? JSON.parse(text) : null,
            text
          });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const html = fs.readFileSync(
    path.join(__dirname, "../apps/digest/digest.html"),
    "utf8"
  );
  assert.match(html, /Shelf\.data\.get\(\s*['"]digest['"]\s*\)/);
  assert.match(html, /Shelf\.outbox\.push/);
  assert.match(html, /hub-shelf\.js/);
  assert.doesNotMatch(html, /\bfetch\s*\(/);
  assert.doesNotMatch(html, /\/api\/connectors/);
  assert.doesNotMatch(html, /\/api\/ai/);
  assert.doesNotMatch(html, /\blocalStorage\b/);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-hub-m4-"));
  const projectRoot = tmpRoot;
  const syncRoot = path.join(tmpRoot, "sync");
  const dbPath = path.join(tmpRoot, "finance.db");
  fs.mkdirSync(path.join(tmpRoot, "data"), { recursive: true });

  const key = Buffer.alloc(32, 5);
  const db = dbApi.openDatabase({ seedSample: true, dbPath,
    encryptionKey: key,
    samplePath: path.join(__dirname, "../sample-data/transactions.json")
  });

  await connectors.runAll(db, { forceMock: true });
  dbApi.upsertSyncItem(db, {
    id: "sms:dup",
    type: "signal.link",
    source: "sms",
    at: new Date().toISOString(),
    data: { url: "https://example.com/piece", sharedBy: "Sam" }
  });
  dbApi.upsertSyncItem(db, {
    id: "rcpt:demo",
    type: "signal.receipt",
    source: "camera",
    data: { merchant: "Trader Joe's", total: 12.34, date: "2026-08-05" }
  });

  const assembled = sync.buildDigest(db);
  assert.ok(assembled.detail.today.some((item) => item.kind === "event"));
  assert.ok(assembled.detail.today.some((item) => item.kind === "task" && item.id === "rcpt:demo"));
  assert.ok(assembled.detail.today.some((item) => item.id === "task:owed" || item.kind === "task"));
  assert.equal(
    assembled.detail.reading.filter((item) => item.url === "https://example.com/piece").length,
    1,
    "duplicate reading URLs must collapse"
  );
  assert.equal(assembled.detail.reading[0].rank, 1);
  assert.ok(assembled.detail.reading[0].actions === undefined);
  assert.ok(assembled.detail.today[0].actions?.length >= 1);
  assert.equal(typeof assembled.asOfDate, "string");

  const server = createServer(db, { projectRoot, syncRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const health = await request(port, "GET", "/api/health");
  assert.ok(["M4", "M5", "M6", "M7"].includes(health.body.milestone));

  const digest = await request(port, "GET", "/api/digest");
  assert.equal(digest.body.kind, "digest");
  assert.ok(digest.body.detail.today.some((item) => item.actions?.length));

  const ack = await request(port, "POST", "/api/outbox", {
    items: [
      {
        id: "digest-act:ack:test",
        type: "action.ack",
        source: "digest",
        data: { targetRef: { itemId: "contact:a81f" } }
      }
    ]
  });
  assert.equal(ack.status, 200);
  const executed = dbApi.listSyncItems(db).find((item) => item.id === "digest-act:ack:test");
  assert.equal(executed.executed, true);

  const page = await request(port, "GET", "/apps/digest/digest.html");
  assert.equal(page.status, 200);
  assert.match(page.text, /Shelf\.data\.get/);

  await new Promise((resolve) => server.close(resolve));
  db.close();
  console.log("Hub M4 digest assembly checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
