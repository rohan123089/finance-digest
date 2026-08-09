"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
const sync = require("../hub/sync.js");
const syllabus = require("../engine/syllabus.js");

function openTempDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "section-c-"));
  const db = dbApi.openDatabase({
    seedSample: false,
    dbPath: path.join(tmp, "finance.db"),
    encryptionKey: Buffer.alloc(32, 8)
  });
  dbApi.saveSettings(db, { asOfDate: "2026-08-07" });
  return { db, tmp };
}

async function main() {
  const asOf = "2026-08-07";

  // when labels: Fri / 2 wks style
  assert.equal(syllabus.formatWhen("2026-08-07", asOf), "today");
  assert.equal(syllabus.formatWhen("2026-08-14", asOf), "Fri");
  assert.match(syllabus.formatWhen("2026-08-28", asOf), /wks?/);

  // Multi-assessment week anchor (directional, not scolding)
  const horizon = [
    {
      id: "a1",
      name: "Renal exam",
      when: "Mon",
      done: 2,
      total: 10,
      leadDays: 14,
      kind: "exam",
      date: "2026-08-10"
    },
    {
      id: "a2",
      name: "Cardio exam",
      when: "Wed",
      done: 0,
      total: 8,
      leadDays: 14,
      kind: "exam",
      date: "2026-08-12"
    },
    {
      id: "a3",
      name: "Pharm quiz",
      when: "Fri",
      done: 1,
      total: 4,
      leadDays: 7,
      kind: "quiz",
      date: "2026-08-14"
    }
  ];
  const studyNext = {
    topic: "renal physiology",
    reading: "Ch 12",
    done: 2,
    total: 10
  };
  const anchor = syllabus.buildGlanceAnchor({
    heavyDay: false,
    clearDay: false,
    examHorizon: horizon,
    studyNext,
    backlog: { open: 0, overdue: 0 },
    asOfDate: asOf
  });
  assert.match(anchor, /2 exams and 1 quiz this week/i);
  assert.match(anchor, /renal physiology/i);
  assert.match(anchor, /Ch 12/);
  assert.ok(!/behind|failing|late/i.test(anchor), "never scolding");

  const heavy = syllabus.buildGlanceAnchor({
    heavyDay: true,
    clearDay: false,
    examHorizon: horizon,
    studyNext,
    backlog: { open: 12, overdue: 3 },
    asOfDate: asOf
  });
  assert.match(heavy, /when you have a beat/i);

  // studyNext prefers reading + nearest exam; readiness integers
  const assessments = [
    {
      id: "assess:mid",
      courseId: "course:cs",
      kind: "exam",
      title: "Midterm",
      date: "2026-08-14",
      weight: 20,
      confirmed: true,
      leadDays: 14
    }
  ];
  const topics = [
    {
      id: "t1",
      courseId: "course:cs",
      assessmentId: "assess:mid",
      title: "Pointers",
      week: 1,
      readings: [],
      reviewed: false
    },
    {
      id: "t2",
      courseId: "course:cs",
      assessmentId: "assess:mid",
      title: "Memory",
      week: 2,
      readings: ["Ch 2"],
      reviewed: false
    },
    {
      id: "t3",
      courseId: "course:cs",
      assessmentId: "assess:mid",
      title: "Done topic",
      week: 1,
      readings: ["Ch 0"],
      reviewed: true
    }
  ];
  const next = syllabus.pickStudyNext(assessments, topics, asOf);
  assert.equal(next.topic, "Memory");
  assert.equal(next.reading, "Ch 2");
  assert.equal(typeof next.done, "number");
  assert.equal(typeof next.total, "number");
  assert.equal(next.done, 1);
  assert.equal(next.total, 3);
  assert.ok(Number.isInteger(next.done) && Number.isInteger(next.total));

  const built = syllabus.buildExamHorizon(assessments, topics, asOf);
  assert.equal(built.length, 1);
  assert.ok(Number.isInteger(built[0].done));
  assert.ok(Number.isInteger(built[0].total));
  assert.equal(built[0].when, "Fri");

  // Digest wiring: heavyDay clears reading; backlog counts; clearDay
  const { db } = openTempDb();
  dbApi.upsertCourse(db, { id: "course:cs", name: "CS 240" });
  dbApi.upsertAssessment(db, {
    id: "assess:mid",
    courseId: "course:cs",
    kind: "exam",
    title: "CS 240 Midterm",
    date: "2026-08-08",
    confirmed: true,
    leadDays: 14,
    weight: 25,
    source: "gcal"
  });
  dbApi.upsertAssessment(db, {
    id: "assess:quiz",
    courseId: "course:cs",
    kind: "quiz",
    title: "Weekly quiz",
    date: "2026-08-09",
    confirmed: true,
    leadDays: 7,
    source: "gcal"
  });
  dbApi.upsertTopic(db, {
    id: "topic:renal",
    courseId: "course:cs",
    assessmentId: "assess:mid",
    title: "renal",
    readings: ["Ch 12"],
    reviewed: false
  });
  dbApi.upsertSyncItem(db, {
    id: "life:task:overdue-1",
    type: "signal.task",
    source: "email",
    data: {
      title: "Old follow-up",
      dueAt: "2026-08-01T12:00:00Z",
      domain: "personal",
      why: "follow-up"
    }
  });

  const digest = sync.buildDigest(db);
  assert.ok(digest.glance.examHorizon.length >= 2);
  assert.equal(typeof digest.glance.backlog.open, "number");
  assert.ok(digest.glance.backlog.overdue >= 1);
  assert.ok(digest.glance.studyNext?.topic);
  assert.ok(Number.isInteger(digest.glance.examHorizon[0].done));
  assert.ok(Number.isInteger(digest.glance.examHorizon[0].total));
  // Exam tomorrow (Aug 8 from Aug 7) → heavyDay; reading empty
  assert.equal(digest.glance.heavyDay, true);
  assert.deepEqual(digest.glance.reading, []);
  assert.match(digest.glance.anchor, /this week|is tomorrow|When you have a beat/i);
  assert.equal(digest.glance.clearDay, false);

  console.log("section-c-derived tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
