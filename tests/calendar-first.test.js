"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
const sync = require("../hub/sync.js");
const scheduleMap = require("../engine/schedule-map.js");
const gcal = require("../hub/connectors/gcal.js");
const canvas = require("../hub/connectors/canvas.js");

function openTempDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cal-first-"));
  const db = dbApi.openDatabase({
    seedSample: false,
    dbPath: path.join(tmp, "finance.db"),
    encryptionKey: Buffer.alloc(32, 3)
  });
  dbApi.saveSettings(db, { asOfDate: "2026-08-07" });
  return { db, tmp };
}

async function main() {
  const { db } = openTempDb();

  // GCal assessment seeds the map as confirmed.
  const start = "2026-08-14T15:00:00.000Z";
  const signal = gcal.eventToSignal(
    {
      id: "midterm-1",
      summary: "CS 240 Midterm Exam",
      start: { dateTime: start },
      organizer: { email: "prof@wisc.edu" }
    },
    { calendarId: "primary", mailbox: "you@example.com", db }
  );
  dbApi.upsertSyncItem(db, { ...signal, collectedAt: new Date().toISOString() });
  scheduleMap.seedFromGcalEvent(dbApi, db, signal);

  let assessments = dbApi.listAssessments(db);
  assert.equal(assessments.length, 1);
  assert.equal(assessments[0].source, "gcal");
  assert.equal(assessments[0].confirmed, true);
  assert.equal(assessments[0].date, "2026-08-14");

  // Canvas match trusts calendar date when titles align but dates differ.
  const canvasSignal = {
    id: "canvas:todo:9001",
    type: "signal.task",
    source: "canvas",
    data: {
      title: "CS 240 Midterm Exam",
      dueAt: "2026-08-15T23:59:00Z",
      domain: "school",
      course: "Course 1",
      context_code: "course_1"
    }
  };
  scheduleMap.seedFromCanvasSignal(dbApi, db, canvasSignal);
  assessments = dbApi.listAssessments(db);
  const gcalRow = assessments.find((a) => a.source === "gcal");
  assert.ok(gcalRow);
  assert.equal(gcalRow.date, "2026-08-14", "calendar date wins");
  assert.equal(gcalRow.canvasDate, "2026-08-15");
  const conflicts = dbApi.listNeedsALook(db).conflicts;
  assert.ok(conflicts.some((c) => /calendar wins|calendar says/i.test(c.detail)));

  // Syllabus without calendar match → confirm-me, not glance horizon.
  const enriched = dbApi.applySyllabusParse(
    db,
    {
      course: { id: "course:hist-101", name: "HIST 101", term: "Fall 2026" },
      assessments: [
        {
          id: "assess:syllabus:hist-final",
          courseId: "course:hist-101",
          kind: "exam",
          title: "HIST 101 Final",
          date: "2026-12-12",
          source: "syllabus",
          confidence: "high",
          leadDays: 14,
          confirmed: true,
          parsedDate: "2026-12-12"
        }
      ],
      topics: [
        {
          id: "topic:hist:w1",
          courseId: "course:hist-101",
          title: "Reconstruction",
          readings: ["Ch 1"],
          week: 1
        }
      ],
      conflicts: [],
      confirmDates: [],
      parsedAt: new Date().toISOString()
    },
    { id: "syllabus:test:hist", sourceKind: "file", contentHash: "hist1" }
  );
  assert.ok(enriched.confirmDates.length >= 1);
  const digest = sync.buildDigest(db);
  assert.ok(digest.glance.examHorizon.some((e) => /Midterm/i.test(e.name)));
  assert.ok(
    !digest.glance.examHorizon.some((e) => /HIST 101 Final/i.test(e.name)),
    "unmatched syllabus exam stays off glance until confirm"
  );
  assert.ok(
    digest.detail.needsALook.confirmDates.some((c) =>
      /HIST 101 Final/i.test(c.title || "")
    )
  );

  // Canvas-only (no calendar) still surfaces — schedules often live only in Canvas.
  scheduleMap.seedFromCanvasSignal(dbApi, db, {
    id: "canvas:todo:quiz9",
    data: {
      title: "Weekly Quiz 9",
      dueAt: "2026-08-10T23:59:00Z",
      domain: "school",
      course: "Course 2"
    }
  });
  const after = sync.buildDigest(db);
  assert.ok(after.glance.examHorizon.some((e) => /Quiz 9/i.test(e.name)));

  // Similarity helper
  assert.ok(scheduleMap.titleSimilarity("CS 240 Midterm Exam", "Midterm Exam CS240") > 0.4);

  console.log("calendar-first schedule map tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
