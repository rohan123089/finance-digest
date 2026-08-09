"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
const sync = require("../hub/sync.js");
const cryptoUtil = require("../hub/crypto.js");
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
            body: text && type.includes("json") ? JSON.parse(text) : null
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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-hub-m2-"));
  const projectRoot = tmpRoot;
  const syncRoot = path.join(tmpRoot, "sync");
  const dbPath = path.join(tmpRoot, "finance.db");
  fs.mkdirSync(path.join(tmpRoot, "data"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "sample-data"), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "../sample-data/transactions.json"),
    path.join(tmpRoot, "sample-data", "transactions.json")
  );

  const key = Buffer.alloc(32, 9);
  const db = dbApi.openDatabase({ seedSample: true, dbPath,
    encryptionKey: key,
    samplePath: path.join(tmpRoot, "sample-data", "transactions.json")
  });

  sync.ensureSyncLayout(syncRoot);
  cryptoUtil.loadOrCreateKey(projectRoot);

  const outboxPath = await sync.writeSampleOutbox(projectRoot, syncRoot, [
    {
      id: "contact:a81f",
      type: "signal.birthday",
      source: "contacts",
      data: { name: "A. Rivera", month: 8, day: 6 }
    },
    {
      id: "gm:998877",
      type: "signal.event",
      source: "groupme",
      data: {
        title: "Dinner",
        start: "2026-08-08T19:00:00",
        sourceRef: "groupme:group/44/msg/998877"
      }
    },
    {
      id: "sms:12345",
      type: "signal.link",
      source: "sms",
      data: { url: "https://example.com/piece", sharedBy: "Sam", context: null }
    },
    {
      id: "act:7f10",
      type: "action.unsubscribe",
      source: "digest",
      data: { targetRef: { listIds: ["news.acme.com"] } }
    }
  ]);
  assert.ok(fs.existsSync(outboxPath));

  const server = createServer(db, { projectRoot, syncRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const health = await request(port, "GET", "/api/health");
  assert.ok(["M2", "M3", "M4", "M5", "M6", "M7"].includes(health.body.milestone));
  assert.equal(typeof health.body.syncKeyFingerprint, "string");

  const ingested = await request(port, "POST", "/api/sync/ingest");
  assert.equal(ingested.status, 200);
  assert.equal(ingested.body.processed.length, 1);
  assert.equal(ingested.body.processed[0].itemCount, 4);
  assert.equal(ingested.body.kind, "digest");
  assert.ok(ingested.body.detail.today.some((item) => item.kind === "birthday"));
  assert.ok(ingested.body.detail.reading.some((item) => item.url.includes("example.com")));
  assert.ok(ingested.body.detail.junk.some((item) => item.action === "unsubscribe"));

  // Second ingest is a no-op (done marker); still returns assembled digest.
  const again = await request(port, "POST", "/api/sync/ingest");
  assert.equal(again.body.processed.length, 0);
  assert.equal(again.body.detail.today.length, ingested.body.detail.today.length);

  const digest = await request(port, "GET", "/api/digest");
  assert.equal(digest.body.kind, "digest");
  assert.ok(digest.body.detail.today.some((item) => item.id === "contact:a81f"));

  const action = dbApi.listSyncItems(db).find((item) => item.id === "act:7f10");
  assert.equal(action.executed, true);

  assert.ok(fs.existsSync(path.join(syncRoot, "down", "digest-latest.json.enc")));
  assert.ok(fs.existsSync(path.join(syncRoot, "down", "snapshot-latest.json.enc")));
  assert.ok(fs.existsSync(path.join(syncRoot, "meta", "hub-cursor.json")));

  const snapshotBytes = fs.readFileSync(
    path.join(syncRoot, "down", "snapshot-latest.json.enc")
  );
  const snapshot = await cryptoUtil.decryptJson(projectRoot, snapshotBytes);
  assert.equal(snapshot.v, 1);
  assert.equal(typeof snapshot.safeToSpend.remaining, "number");
  assert.equal("balances" in snapshot, false);
  assert.equal("expenses" in snapshot, false);
  assert.equal(JSON.stringify(snapshot).includes("rawMerchant"), false);

  // Refuse newer envelope versions.
  const bad = await cryptoUtil.encryptJson(projectRoot, {
    v: 99,
    device: "phone",
    generatedAt: new Date().toISOString(),
    watermarks: {},
    items: [{ id: "x", type: "signal.junk", data: {} }]
  });
  const badPath = path.join(syncRoot, "up", `outbox-bad-${Date.now()}.json.enc`);
  fs.writeFileSync(badPath, bad);
  let refused = false;
  try {
    await sync.ingestOutboxFile(db, projectRoot, syncRoot, badPath);
  } catch (error) {
    refused = /version/i.test(error.message);
  }
  assert.equal(refused, true);

  await new Promise((resolve) => server.close(resolve));
  db.close();
  console.log("Hub M2 sync ingest checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
