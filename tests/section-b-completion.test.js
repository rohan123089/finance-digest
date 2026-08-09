"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
const sync = require("../hub/sync.js");
const life = require("../engine/life.js");
const completion = require("../engine/completion.js");

function openTempDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "section-b-"));
  const db = dbApi.openDatabase({
    seedSample: false,
    dbPath: path.join(tmp, "finance.db"),
    encryptionKey: Buffer.alloc(32, 7)
  });
  dbApi.saveSettings(db, { asOfDate: "2026-08-06" });
  return { db, tmp };
}

async function main() {
  const { db } = openTempDb();

  // --- Paid bill auto-close (inferred) ---
  dbApi.upsertBill(db, {
    id: "bill:rent",
    title: "Rent",
    amount: 1400,
    dueDay: 1,
    leadDays: 7,
    active: true,
    lastPaidFor: null
  });
  dbApi.insertRawTransaction(db, {
    id: "tx:rent-aug",
    date: "2026-08-01",
    amount: -1400,
    account: "uwcu-checking",
    accountType: "cash",
    rawMerchant: "RENT ACME PROPERTY",
    merchant: "Rent Acme Property",
    category: "Housing",
    direction: "out"
  });

  let digest = sync.buildDigest(db);
  assert.ok(
    !digest.detail.today.some((row) => row.kind === "bill" && /Rent/i.test(row.title)),
    "matching txn should infer bill paid and drop rent nag"
  );
  assert.equal(dbApi.getBill(db, "bill:rent").lastPaidFor, "2026-08");

  // Reverse inferred bill close — skip re-inference
  dbApi.clearBillPaid(db, "bill:rent");
  completion.skipInference(dbApi, db, "bill:bill:rent:2026-08");
  digest = sync.buildDigest(db);
  assert.ok(
    digest.detail.today.some((row) => row.kind === "bill" && /Rent/i.test(row.title)),
    "after undo + skip, rent nag returns and stays"
  );

  // --- Sent reply / confirmation closes follow-up ---
  dbApi.upsertSyncItem(db, {
    id: "life:task:follow-dentist",
    type: "signal.task",
    source: "email",
    at: "2026-08-05T12:00:00Z",
    data: {
      title: "Follow up with dentist office",
      dueAt: "2026-08-08T12:00:00Z",
      domain: "personal",
      why: "follow-up",
      from: "dentist@clinic.example"
    }
  });
  const confirmItems = life.extractFromMessage({
    id: "mail-confirm-1",
    subject: "Appointment confirmation",
    body: "Your appointment confirmation is complete with the dentist office.",
    from: "dentist@clinic.example",
    receivedAt: "2026-08-06T09:00:00Z",
    source: "email"
  });
  assert.ok(
    confirmItems.some((i) => i.type === "signal.confirmation"),
    "confirmations emit signal.confirmation"
  );
  confirmItems.forEach((item) => dbApi.upsertSyncItem(db, item));

  digest = sync.buildDigest(db);
  assert.ok(
    !digest.detail.today.some((row) => row.id === "life:task:follow-dentist"),
    "confirmation should infer-close the follow-up task"
  );
  const closed = dbApi.listSyncItems(db).find((i) => i.id === "life:task:follow-dentist");
  assert.equal(closed.executed, true);
  assert.equal(closed.result?.how, "inferred");
  assert.equal(closed.result?.reversible, true);

  // Topic reviewedHow stays distinguishable
  dbApi.upsertCourse(db, { id: "course:cs", name: "CS" });
  dbApi.upsertTopic(db, {
    id: "topic:pointers",
    courseId: "course:cs",
    title: "Pointers and memory",
    reviewed: false
  });
  dbApi.markTopicReviewed(db, "topic:pointers", "inferred");
  assert.equal(dbApi.listTopics(db)[0].reviewedHow, "inferred");
  dbApi.clearTopicReviewed(db, "topic:pointers");
  assert.equal(dbApi.listTopics(db)[0].reviewed, false);
  assert.ok(completion.isInferenceSkipped(dbApi, db, "topic:pointers"));

  console.log("section-b-completion tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
