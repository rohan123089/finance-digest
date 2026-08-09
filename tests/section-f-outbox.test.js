"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
const sync = require("../hub/sync.js");
const digestContract = require("../engine/digest-contract.js");

function openTempDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "section-f-"));
  const db = dbApi.openDatabase({
    seedSample: false,
    dbPath: path.join(tmp, "finance.db"),
    encryptionKey: Buffer.alloc(32, 6)
  });
  dbApi.saveSettings(db, { asOfDate: "2026-08-07" });
  return { db, tmp };
}

async function main() {
  const { db } = openTempDb();

  // Seed open loops for triage.
  dbApi.upsertSyncItem(db, {
    id: "life:task:a",
    type: "signal.task",
    source: "email",
    data: {
      title: "Follow up with advisor",
      dueAt: "2026-08-01T12:00:00Z",
      domain: "school",
      why: "follow-up"
    }
  });
  dbApi.upsertSyncItem(db, {
    id: "life:task:b",
    type: "signal.task",
    source: "email",
    data: {
      title: "Register for clinic",
      dueAt: "2026-08-10T12:00:00Z",
      domain: "school",
      why: "task language"
    }
  });

  // Idle: no triage tray
  let digest = sync.buildDigest(db);
  assert.equal(digest.glance.triageAvailable, false);
  assert.equal(digest.detail.triage, null);
  assert.equal(digestContract.assertDigestContract(digest).ok, true);

  // action.triage → fuller backlog on next digest
  dbApi.upsertSyncItem(db, {
    id: "act:triage-1",
    type: "action.triage",
    source: "digest",
    data: {}
  });
  sync.executePendingActions(db);
  digest = sync.buildDigest(db);
  assert.equal(digest.glance.triageAvailable, true);
  assert.ok(Array.isArray(digest.detail.triage));
  assert.ok(digest.detail.triage.length >= 2);
  assert.equal(digest.detail.triage[0].overdue, true, "overdue first");
  assert.ok(!("triage" in digest.glance));

  // markDone still works
  dbApi.upsertSyncItem(db, {
    id: "act:done-1",
    type: "action.markDone",
    source: "digest",
    data: { taskId: "life:task:a", targetRef: { itemId: "life:task:a" } }
  });
  sync.executePendingActions(db);
  digest = sync.buildDigest(db);
  assert.ok(!digest.detail.triage.some((r) => r.id === "life:task:a"));

  // markReviewed / confirmDate / unsubscribe already covered elsewhere — smoke confirmDate
  dbApi.upsertCourse(db, { id: "course:x", name: "X" });
  dbApi.upsertAssessment(db, {
    id: "assess:tba",
    courseId: "course:x",
    kind: "quiz",
    title: "TBA quiz",
    date: "2026-08-20",
    confirmed: false,
    source: "syllabus",
    leadDays: 14
  });
  dbApi.upsertSyncItem(db, {
    id: "act:confirm-f",
    type: "action.confirmDate",
    source: "digest",
    data: { assessmentId: "assess:tba", date: "2026-08-20" }
  });
  sync.executePendingActions(db);
  digest = sync.buildDigest(db);
  assert.ok(digest.glance.examHorizon.some((e) => e.id === "assess:tba"));

  // unsubscribe executes
  dbApi.upsertSyncItem(db, {
    id: "act:unsub-f",
    type: "action.unsubscribe",
    source: "digest",
    data: { targetRef: { listIds: ["news.example.com"] } }
  });
  sync.executePendingActions(db);
  const unsub = dbApi.listSyncItems(db).find((i) => i.id === "act:unsub-f");
  assert.equal(unsub.executed, true);

  // triage.ack clears tray
  dbApi.upsertSyncItem(db, {
    id: "act:triage-ack",
    type: "action.triage.ack",
    source: "digest",
    data: {}
  });
  sync.executePendingActions(db);
  digest = sync.buildDigest(db);
  assert.equal(digest.glance.triageAvailable, false);
  assert.equal(digest.detail.triage, null);

  console.log("section-f-outbox tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
