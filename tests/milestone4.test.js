"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
const connectors = require("../hub/connectors/index.js");

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fd-m4-"));
  const dbPath = path.join(tmpRoot, "test.db");
  const samplePath = path.join(__dirname, "../sample-data/transactions.json");
  const db = dbApi.openDatabase({ seedSample: true, dbPath,
    encryptionKey: Buffer.alloc(32, 4),
    samplePath
  });

  const beforeCount = dbApi.listTransactions(db).length;
  const result = await connectors.runAll(db, { forceMock: true });

  assert.equal(result.groupme.mode, "mock");
  assert.ok(result.groupme.emitted.length >= 1);
  assert.equal(result.email.mode, "mock");
  assert.ok(result.email.emitted.length >= 1);
  assert.equal(result.bank.mode, "mock");
  assert.ok(result.bank.emitted.length >= 1);

  const afterCount = dbApi.listTransactions(db).length;
  assert.equal(afterCount, beforeCount + result.bank.emitted.length);
  assert.equal(dbApi.getConnectorWatermark(db, "groupme"), "998878");
  assert.ok(dbApi.listSyncItems(db).some((item) => item.source === "groupme"));

  db.close();
  console.log("Milestone 4 connector checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
