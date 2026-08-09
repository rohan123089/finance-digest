"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
const sync = require("../hub/sync.js");
const secretStore = require("../hub/secret-store.js");
const syllabus = require("../engine/syllabus.js");

function openTempDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "section-a-"));
  const db = dbApi.openDatabase({
    seedSample: false,
    dbPath: path.join(tmp, "finance.db"),
    encryptionKey: Buffer.alloc(32, 5)
  });
  dbApi.saveSettings(db, { asOfDate: "2026-08-07" });
  return { db, tmp };
}

async function main() {
  // Outlook secrets are registered so live connect can use the keychain.
  for (const name of [
    "outlook.clientId",
    "outlook.clientSecret",
    "outlook.refreshToken",
    "outlook.accessToken"
  ]) {
    assert.ok(
      secretStore.CONNECTOR_ACCOUNTS[name],
      `missing CONNECTOR_ACCOUNTS entry for ${name}`
    );
  }

  const { db } = openTempDb();

  // Canvas course with zero assessments → blocks clearDay.
  dbApi.upsertCourse(db, {
    id: "course:canvas:99",
    name: "BIO 101",
    canvasCourseId: "99"
  });
  let digest = sync.buildDigest(db);
  assert.ok(
    digest.detail.needsALook.coverageGaps.some(
      (g) => g.blocksClear && /no syllabus loaded for BIO 101/i.test(g.note)
    ),
    "empty enrolled course must surface coverage gap"
  );
  assert.equal(
    digest.glance.clearDay,
    false,
    "missing syllabus must never read as all-clear"
  );

  // Re-parse records a map change.
  const sample = `
BIO 101 Fall 2026
Week 1: Cells
- Membrane — reading: Ch 1
Exam Aug 20 (25%)
`;
  const parsed = syllabus.parseSyllabusText(sample, {
    courseName: "BIO 101",
    courseId: "course:canvas:99",
    asOfDate: "2026-08-07",
    source: "email"
  });
  const first = dbApi.applySyllabusParse(db, parsed, {
    id: "syllabus:email:bio-v1",
    sourceKind: "email",
    contentHash: "biohash1"
  });
  assert.equal(first.changed, false);
  assert.equal(dbApi.listSyllabusMapChanges(db).length, 0);

  const sample2 = `
BIO 101 Fall 2026 — UPDATED
Week 1: Cells
- Membrane — reading: Ch 1
- Organelles — reading: Ch 2
Exam Aug 21 (25%)
`;
  const parsed2 = syllabus.parseSyllabusText(sample2, {
    courseName: "BIO 101",
    courseId: "course:canvas:99",
    asOfDate: "2026-08-07",
    source: "email"
  });
  const second = dbApi.applySyllabusParse(db, parsed2, {
    id: "syllabus:email:bio-v2",
    sourceKind: "email",
    contentHash: "biohash2"
  });
  assert.equal(second.changed, true);
  const changes = dbApi.listSyllabusMapChanges(db);
  assert.ok(changes.length >= 1);
  assert.equal(changes[0].courseId, "course:canvas:99");
  assert.match(changes[0].note, /re-parsed/i);

  // Source + parsedAt stored for staleness.
  const sources = dbApi.listSyllabusSources(db, "course:canvas:99");
  assert.ok(sources.length >= 2);
  assert.ok(sources.every((s) => s.parsedAt));

  console.log("section-a-syllabus tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
