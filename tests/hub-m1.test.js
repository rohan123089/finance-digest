"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
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
          let parsed = null;
          if (text && type.includes("json")) {
            parsed = JSON.parse(text);
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: parsed,
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-hub-m1-"));
  const dbPath = path.join(tempRoot, "finance.db");
  const key = Buffer.alloc(32, 7);
  const db = dbApi.openDatabase({ seedSample: true, dbPath, encryptionKey: key });

  assert.equal(dbApi.listTransactions(db).length, 25);
  assert.notEqual(
    fs.readFileSync(dbPath).subarray(0, 16).toString("utf8"),
    "SQLite format 3\u0000",
    "database header must be encrypted"
  );

  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const transactions = await request(port, "GET", "/api/transactions");
  assert.equal(transactions.status, 200);
  assert.equal(transactions.body.kind, "transactions");
  assert.equal(transactions.body.rows.length, 25);
  assert.equal(typeof transactions.body.settings.weeklySavingsTarget, "number");

  const snapshotBefore = await request(port, "GET", "/api/snapshot");
  assert.equal(snapshotBefore.body.kind, "snapshot");
  assert.equal(typeof snapshotBefore.body.safeToSpend.remaining, "number");
  assert.equal(JSON.stringify(snapshotBefore.body).includes("rawMerchant"), false);

  const digest = await request(port, "GET", "/api/digest");
  assert.equal(digest.body.kind, "digest");
  assert.ok(Array.isArray(digest.body.today));
  assert.deepEqual(digest.body.reading, []);
  assert.deepEqual(digest.body.junk, []);
  // Seeded sample data can surface deterministic money tasks (owed / safe-to-spend).
  assert.ok(
    digest.body.today.every((item) =>
      ["task", "birthday", "event", "nudge"].includes(item.kind)
    )
  );
  const root = await request(port, "GET", "/");
  assert.equal(root.status, 302, "root must redirect so hub home relative scripts resolve");
  assert.equal(root.headers.location, "/apps/hub/home.html");
  const homePage = await request(port, "GET", "/apps/hub/home.html");
  assert.equal(homePage.status, 200);
  assert.match(homePage.text, /money\.html|Daily Digest|Money/i);
  const moneyPage = await request(port, "GET", "/apps/money/money.html");
  assert.equal(moneyPage.status, 200);
  assert.match(moneyPage.text, /hub-shelf\.js/);
  assert.equal(
    (await request(port, "GET", "/data/sync.key")).status,
    404,
    "data files must never be browser-served"
  );
  assert.equal(
    (await request(port, "GET", "/hub/secret-store.js")).status,
    404,
    "hub source files must never be browser-served"
  );

  const action = {
    id: "test:money-edit:tx-024",
    type: "action.transaction.update",
    source: "test",
    data: {
      id: "tx-024",
      direction: "transfer",
      category: "",
      transferAccount: "savings"
    }
  };
  const queued = await request(port, "POST", "/api/outbox", { items: [action] });
  assert.equal(queued.status, 200);
  assert.equal(queued.body.queued, 1);
  const replayed = await request(port, "POST", "/api/outbox", { items: [action] });
  assert.equal(replayed.body.total, queued.body.total, "stable IDs must merge idempotently");

  const updated = await request(port, "GET", "/api/transactions");
  assert.equal(
    updated.body.rows.find((row) => row.id === "tx-024").transferAccount,
    "savings"
  );

  await new Promise((resolve) => server.close(resolve));
  db.close();

  const reopened = dbApi.openDatabase({ seedSample: true, dbPath, encryptionKey: key });
  assert.equal(
    dbApi.listTransactions(reopened).find((row) => row.id === "tx-024").direction,
    "transfer"
  );
  reopened.close();
  assert.throws(
    () => dbApi.openDatabase({ seedSample: true, dbPath, encryptionKey: Buffer.alloc(32, 8) }),
    /not a database|encrypted|file/i
  );

  console.log("Hub M0-M1 acceptance checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
