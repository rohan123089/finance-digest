"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
const sync = require("../hub/sync.js");
const syllabus = require("../engine/syllabus.js");
const syllabusFiles = require("../hub/connectors/syllabus-files.js");
const ai = require("../hub/ai.js");

function openTempDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glance-"));
  const key = Buffer.alloc(32, 9);
  const db = dbApi.openDatabase({
    seedSample: false,
    dbPath: path.join(tmp, "finance.db"),
    encryptionKey: key
  });
  dbApi.saveSettings(db, { asOfDate: "2026-08-07" });
  return { db, tmp };
}

async function main() {
  const { db, tmp } = openTempDb();

  // Protected tier: mute cannot hide a school deadline.
  dbApi.upsertLearnedRule(db, {
    scope: "digest",
    matchKind: "group_id",
    matchKey: "class-group",
    effect: "mute",
    effectValue: {},
    source: "test"
  });
  dbApi.upsertSyncItem(db, {
    id: "life:task:muted-deadline",
    type: "signal.task",
    source: "groupme",
    at: "2026-08-07T12:00:00Z",
    data: {
      title: "CS homework due",
      dueAt: "2026-08-07T23:59:00Z",
      domain: "school",
      groupId: "class-group",
      why: "deadline"
    }
  });
  dbApi.upsertSyncItem(db, {
    id: "life:link:muted",
    type: "signal.link",
    source: "groupme",
    data: {
      url: "https://example.com/meme",
      title: "meme",
      groupId: "class-group",
      sharedBy: "class"
    }
  });

  let digest = sync.buildDigest(db);
  assert.ok(digest.glance, "glance surface required");
  assert.ok(digest.detail, "detail surface required");
  assert.ok(
    digest.detail.today.some((row) => row.id === "life:task:muted-deadline"),
    "muted group must not hide deadline"
  );
  assert.ok(
    !digest.detail.reading.some((row) => row.id === "life:link:muted"),
    "muted group may hide reading"
  );
  assert.equal(typeof digest.glance.backlog.open, "number");
  assert.equal(typeof digest.glance.clearDay, "boolean");
  assert.equal(typeof digest.glance.heavyDay, "boolean");
  assert.ok(digest.glance.anchor);

  // markDone alias
  dbApi.upsertSyncItem(db, {
    id: "act:markdone-1",
    type: "action.markDone",
    source: "digest",
    data: { taskId: "life:task:muted-deadline", targetRef: { itemId: "life:task:muted-deadline" } }
  });
  sync.executePendingActions(db);
  digest = sync.buildDigest(db);
  assert.ok(
    !digest.detail.today.some((row) => row.id === "life:task:muted-deadline"),
    "markDone removes task from today"
  );

  // Syllabus enrich after calendar seed (calendar owns dates).
  const sample = `
CS 240 Fall 2026
Week 1: Intro
- Pointers — reading: Ch 1
- Memory — reading: Ch 2
Midterm exam Friday, Aug 14 (20%)
Week 2: Processes
- Fork and exec
Final exam Aug 28 (30%)
`;
  const scheduleMap = require("../engine/schedule-map.js");
  scheduleMap.seedFromGcalEvent(dbApi, db, {
    id: "gcal:primary:cs240-midterm",
    data: {
      title: "CS 240 Midterm exam",
      start: "2026-08-14T15:00:00.000Z",
      domain: "school",
      calendarId: "primary"
    }
  });
  const parsed = syllabus.parseSyllabusText(sample, {
    courseName: "CS 240",
    asOfDate: "2026-08-07",
    source: "syllabus"
  });
  assert.ok(parsed.assessments.length >= 1);
  assert.ok(parsed.topics.length >= 1);
  dbApi.applySyllabusParse(db, parsed, {
    id: "syllabus:test:cs240",
    sourceKind: "file",
    contentHash: "testhash"
  });
  digest = sync.buildDigest(db);
  assert.ok(digest.glance.examHorizon.length >= 1, "exam horizon from calendar");
  assert.ok(digest.glance.studyNext?.topic, "studyNext set from syllabus topics");
  assert.equal(typeof digest.glance.examHorizon[0].done, "number");
  assert.equal(typeof digest.glance.examHorizon[0].total, "number");
  assert.ok(digest.detail.needsALook);
  assert.ok(Array.isArray(digest.detail.needsALook.coverageGaps));

  // markReviewed
  const topicId = digest.glance.studyNext.topicId;
  dbApi.upsertSyncItem(db, {
    id: "act:review-1",
    type: "action.markReviewed",
    source: "digest",
    data: { topicId }
  });
  sync.executePendingActions(db);
  digest = sync.buildDigest(db);
  assert.ok(digest.glance.examHorizon[0].done >= 1);

  // confirmDate gate
  dbApi.upsertAssessment(db, {
    id: "assess:confirm-me",
    courseId: parsed.course.id,
    kind: "exam",
    title: "Pop quiz TBA",
    date: "2026-08-12",
    source: "ai",
    confidence: "low",
    confirmed: false,
    leadDays: 14
  });
  digest = sync.buildDigest(db);
  assert.ok(
    !digest.glance.examHorizon.some((e) => e.id === "assess:confirm-me"),
    "unconfirmed stays off glance horizon"
  );
  assert.ok(
    digest.detail.needsALook.confirmDates.some((c) => c.assessmentId === "assess:confirm-me")
  );
  dbApi.upsertSyncItem(db, {
    id: "act:confirm-1",
    type: "action.confirmDate",
    source: "digest",
    data: { assessmentId: "assess:confirm-me", date: "2026-08-12" }
  });
  sync.executePendingActions(db);
  digest = sync.buildDigest(db);
  assert.ok(digest.glance.examHorizon.some((e) => e.id === "assess:confirm-me"));

  // File drop ingest
  const root = path.join(tmp, "data", "syllabi", "BIO 101");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "syllabus.txt"),
    `BIO 101 Spring 2026
Week 1: Cells
- Cell membrane — reading: Ch 3
Exam Monday, Aug 17 (25%)
`
  );
  await syllabusFiles.syncToDb(db, { dataRoot: path.join(tmp, "data") });
  digest = sync.buildDigest(db);
  // Unmatched syllabus exams stay in confirm-me (calendar-first).
  assert.ok(
    digest.detail.needsALook.confirmDates.some((c) => /Exam|BIO/i.test(c.title || "")) ||
      digest.detail.topics.some((t) => /Cell|membrane/i.test(t.title || ""))
  );

  // AI syllabus path is confirm-only
  const aiResult = ai.proposeSyllabusStructure(db, "Messy prose about a final sometime in May", {
    courseName: "HIST 101",
    asOfDate: "2026-08-07"
  });
  assert.equal(aiResult.confirmOnly, true);

  // Date typo guard
  const bad = syllabus.validateAssessmentDate("2026-08-10", "Monday Aug 10");
  // Aug 10 2026 is Monday — ok. Use a mismatch:
  const bad2 = syllabus.validateAssessmentDate("2026-08-11", "Monday Aug 11");
  assert.equal(bad2.ok, false);
  assert.equal(bad2.conflict.kind, "date-typo");

  console.log("glance-syllabus tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
