"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
const sync = require("../hub/sync.js");
const billsEngine = require("../engine/bills.js");

async function main() {
  const asOf = "2026-08-06";
  const rent = {
    id: "bill:rent",
    title: "Rent",
    amount: 1400,
    dueDay: 1,
    leadDays: 5,
    active: true,
    lastPaidFor: null
  };
  // Aug 1 is overdue on Aug 6 with lead 5 — should still remind
  const overdue = billsEngine.upcomingReminders([rent], asOf);
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].overdue, true);

  const paidReminders = billsEngine.upcomingReminders(
    [{ ...rent, lastPaidFor: "2026-08" }],
    asOf
  );
  // Sept 1 from Aug 6 is outside a 5-day lead — no Digest nag yet.
  assert.equal(paidReminders.length, 0);
  assert.equal(
    billsEngine.upcomingReminders([{ ...rent, lastPaidFor: "2026-08" }], asOf, {
      includeAll: true
    })[0].periodKey,
    "2026-09"
  );

  const soon = billsEngine.upcomingReminders(
    [{ ...rent, dueDay: 10, leadDays: 5, lastPaidFor: null }],
    asOf
  );
  assert.equal(soon.length, 1);
  assert.equal(soon[0].daysUntil, 4);
  assert.match(billsEngine.reminderTitle(soon[0]), /due in 4 days/);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-bills-"));
  const dbPath = path.join(tmpRoot, "finance.db");
  const key = Buffer.alloc(32, 11);
  const db = dbApi.openDatabase({
    dbPath,
    encryptionKey: key,
    seedSample: false
  });
  dbApi.saveSettings(db, { asOfDate: asOf });

  const bills = dbApi.listBills(db);
  assert.ok(bills.some((b) => b.id === "bill:rent"));
  dbApi.upsertBill(db, {
    id: "bill:rent",
    title: "Rent",
    amount: 1450,
    dueDay: 1,
    leadDays: 7,
    active: true
  });

  const digest = sync.buildDigest(db);
  assert.ok(
    digest.today.some((row) => row.kind === "bill" && /Rent/i.test(row.title)),
    "rent reminder should appear in digest Today"
  );

  const billRow = digest.today.find((row) => row.kind === "bill");
  dbApi.upsertSyncItem(db, {
    id: "act:bill-paid",
    type: "action.bill.paid",
    source: "test",
    collectedAt: new Date().toISOString(),
    data: { targetRef: billRow.actions[0].targetRef }
  });
  sync.executePendingActions(db);
  const after = sync.buildDigest(db);
  assert.ok(!after.today.some((row) => row.id === billRow.id));

  db.close();
  console.log("Standing bills schedule + digest reminders passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
