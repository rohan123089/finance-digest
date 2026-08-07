"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-delta-"));
  const dbPath = path.join(dir, "finance.db");
  const db = dbApi.openDatabase({
    dbPath,
    encryptionKey: Buffer.alloc(32, 9)
  });

  const before = dbApi.getDataCursors(db);
  assert.equal(typeof before.txCursor, "string");

  const t0 = new Date().toISOString();
  db.prepare(
    `INSERT INTO transactions(
      id, date, raw_merchant, amount, account, account_type, direction, category,
      merchant, needs_review, transfer_account, suggested_transfer_account,
      committed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', '', NULL, ?)`
  ).run("tx-delta-1", "2026-08-01", "COFFEE", 4.5, "uwcu-checking", "depository", "out", "food", "Coffee", t0);

  const delta = dbApi.listTransactionsSince(db, "2026-07-01T00:00:00.000Z");
  assert.ok(delta.some((r) => r.id === "tx-delta-1"));

  const none = dbApi.listTransactionsSince(db, "2099-01-01T00:00:00.000Z");
  assert.equal(none.length, 0);

  const cursors = dbApi.getDataCursors(db);
  assert.ok(cursors.txCount >= 1);
  assert.ok(cursors.txCursor);

  db.close();
  console.log("Incremental transaction cursor checks passed.");
}

main();
