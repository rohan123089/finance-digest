"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
const sync = require("../hub/sync.js");
const digestContract = require("../engine/digest-contract.js");

function openTempDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "section-e-"));
  const db = dbApi.openDatabase({
    seedSample: false,
    dbPath: path.join(tmp, "finance.db"),
    encryptionKey: Buffer.alloc(32, 2)
  });
  dbApi.saveSettings(db, { asOfDate: "2026-08-07" });
  return { db, tmp };
}

async function main() {
  const { db } = openTempDb();

  dbApi.upsertCourse(db, { id: "course:cs", name: "CS 240" });
  dbApi.upsertAssessment(db, {
    id: "assess:mid",
    courseId: "course:cs",
    kind: "exam",
    title: "Midterm",
    date: "2026-08-08",
    confirmed: true,
    leadDays: 14,
    source: "gcal"
  });
  dbApi.upsertTopic(db, {
    id: "topic:1",
    courseId: "course:cs",
    assessmentId: "assess:mid",
    title: "Pointers",
    readings: ["Ch 1"],
    reviewed: false
  });
  dbApi.upsertSyncItem(db, {
    id: "life:link:1",
    type: "signal.link",
    source: "sms",
    data: { url: "https://example.com/a", title: "Article" }
  });

  const digest = sync.buildDigest(db);
  const result = digestContract.assertDigestContract(digest);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(digestContract.validateDigestContract(digest), []);

  // Spec field mapping present on glance
  digestContract.GLANCE_KEYS.forEach((k) => {
    assert.ok(k in digest.glance, `glance.${k}`);
  });
  digestContract.DETAIL_KEYS.forEach((k) => {
    assert.ok(k in digest.detail, `detail.${k}`);
  });
  assert.ok(!("needsALook" in digest.glance));
  assert.ok(digest.detail.needsALook.conflicts);
  assert.ok(digest.detail.needsALook.confirmDates);
  assert.ok(digest.detail.needsALook.coverageGaps);

  // heavyDay → empty reading
  assert.equal(digest.glance.heavyDay, true);
  assert.deepEqual(digest.glance.reading, []);

  // Integers on horizon / studyNext
  assert.ok(Number.isInteger(digest.glance.examHorizon[0].done));
  assert.ok(Number.isInteger(digest.glance.examHorizon[0].total));
  if (digest.glance.studyNext) {
    assert.ok(Number.isInteger(digest.glance.studyNext.done));
    assert.ok(Number.isInteger(digest.glance.studyNext.total));
  }

  // Validator catches housekeeping on glance
  const bad = JSON.parse(JSON.stringify(digest));
  bad.glance.needsALook = { conflicts: [] };
  const badErrors = digestContract.validateDigestContract(bad);
  assert.ok(badErrors.some((e) => /needsALook must not appear on glance/.test(e)));

  // Validator catches reading on heavyDay
  const bad2 = JSON.parse(JSON.stringify(digest));
  bad2.glance.reading = [{ id: "x", title: "y" }];
  assert.ok(
    digestContract
      .validateDigestContract(bad2)
      .some((e) => /reading must be empty when heavyDay/.test(e))
  );

  assert.equal(dbApi.getMeta(db, "digestContractViolation", ""), "");

  console.log("section-e-contract tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
