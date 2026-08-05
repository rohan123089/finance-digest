"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const dbApi = require("../hub/db.js");
const { createServer } = require("../hub/server.js");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fd-m2-"));
const dbPath = path.join(tmpRoot, "test.db");
process.env.HUB_DB_PASSPHRASE = "test-passphrase";
process.env.HUB_SYNC_ROOT = path.join(tmpRoot, "sync");

const db = dbApi.openDatabase({ dbPath, passphrase: "test-passphrase" });
const server = createServer(db);

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
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
          resolve({
            status: res.statusCode,
            body: text ? JSON.parse(text) : null
          });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

server.listen(0, "127.0.0.1", async () => {
  try {
    const { port } = server.address();
    const health = await request(port, "GET", "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const listed = await request(port, "GET", "/api/transactions");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.transactions.length, 25);

    const before = dbApi.computeLiveSnapshot(db);
    const venmo = listed.body.transactions.find((tx) => tx.id === "tx-024");
    assert.ok(venmo.needsReview);

    const commit = await request(port, "POST", "/api/commit", {
      updates: [
        {
          id: "tx-024",
          direction: "transfer",
          category: "",
          transferAccount: "savings"
        }
      ]
    });
    assert.equal(commit.status, 200);
    assert.equal(commit.body.count, 1);

    const after = commit.body.snapshot;
    assert.ok(after.savingsRate >= before.savingsRate);
    const saved = dbApi.listTransactions(db).find((tx) => tx.id === "tx-024");
    assert.equal(saved.direction, "transfer");
    assert.equal(saved.transferAccount, "savings");
    assert.ok(saved.committedAt);

    server.close(() => {
      db.close();
      const reopened = dbApi.openDatabase({
        dbPath,
        passphrase: "test-passphrase"
      });
      assert.equal(dbApi.listTransactions(reopened).length, 25);
      const persisted = dbApi
        .listTransactions(reopened)
        .find((tx) => tx.id === "tx-024");
      assert.equal(persisted.direction, "transfer");
      reopened.close();
      console.log("Milestone 2 hub checks passed.");
      process.exit(0);
    });
  } catch (error) {
    console.error(error);
    server.close(() => {
      try {
        db.close();
      } catch (_error) {
        // ignore
      }
      process.exit(1);
    });
  }
});
