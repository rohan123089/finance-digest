"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
const sync = require("../hub/sync.js");

function openTempDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "section-d-"));
  const db = dbApi.openDatabase({
    seedSample: false,
    dbPath: path.join(tmp, "finance.db"),
    encryptionKey: Buffer.alloc(32, 4)
  });
  dbApi.saveSettings(db, { asOfDate: "2026-08-07" });
  return { db, tmp };
}

async function main() {
  const { db } = openTempDb();

  // Mute the class GroupMe — reading/social only.
  dbApi.upsertLearnedRule(db, {
    scope: "digest",
    matchKind: "group_id",
    matchKey: "class-group",
    effect: "mute",
    effectValue: {},
    source: "test"
  });

  // Due-date change from muted class group (must stay).
  dbApi.upsertSyncItem(db, {
    id: "life:task:due-change",
    type: "signal.task",
    source: "groupme",
    at: "2026-08-07T12:00:00Z",
    data: {
      title: "Quiz moved to Friday — due date change",
      dueAt: "2026-08-14T23:59:00Z",
      domain: "school",
      groupId: "class-group",
      why: "deadline"
    }
  });

  // Mandatory class event from muted group (must stay).
  dbApi.upsertSyncItem(db, {
    id: "life:event:class-review",
    type: "signal.event",
    source: "groupme",
    at: "2026-08-07T12:00:00Z",
    data: {
      title: "Mandatory review session Thursday 5pm",
      start: "2026-08-13T17:00:00Z",
      domain: "school",
      groupId: "class-group"
    }
  });

  // Social link from muted group (must hide).
  dbApi.upsertSyncItem(db, {
    id: "life:link:meme",
    type: "signal.link",
    source: "groupme",
    data: {
      url: "https://example.com/meme",
      title: "class meme",
      groupId: "class-group",
      sharedBy: "classmate"
    }
  });

  // Assessment on horizon (never mute-keyed).
  dbApi.upsertCourse(db, { id: "course:cs", name: "CS 240" });
  dbApi.upsertAssessment(db, {
    id: "assess:quiz-fri",
    courseId: "course:cs",
    kind: "quiz",
    title: "CS 240 Quiz",
    date: "2026-08-14",
    confirmed: true,
    leadDays: 14,
    source: "gcal"
  });

  const digest = sync.buildDigest(db);

  assert.ok(
    digest.detail.today.some((row) => row.id === "life:task:due-change"),
    "muted class group must not swallow due-date change"
  );
  assert.ok(
    digest.detail.today.some((row) => row.id === "life:event:class-review"),
    "muted class group must not swallow mandatory event"
  );
  assert.ok(
    digest.glance.today.some((row) => row.id === "life:task:due-change") ||
      digest.glance.examHorizon.some((e) => e.id === "assess:quiz-fri"),
    "protected work still surfaces on glance or horizon"
  );
  assert.ok(
    digest.glance.examHorizon.some((e) => e.id === "assess:quiz-fri"),
    "assessment horizon never filtered by mute"
  );
  assert.ok(
    !digest.detail.reading.some((row) => row.id === "life:link:meme"),
    "muted group may hide reading/social"
  );
  assert.ok(
    digest.detail.today
      .filter((row) => row.id === "life:task:due-change" || row.id === "life:event:class-review")
      .every((row) => row.protected === true),
    "protected flag set on school deadline/event"
  );

  // Assembly assert finds no violations on a correct digest.
  const violations = sync.assertProtectedTier(db, {
    items: dbApi.listSyncItems(db),
    today: digest.detail.today,
    watching: digest.detail.watching,
    reading: digest.detail.reading,
    examHorizon: digest.glance.examHorizon,
    asOfDate: "2026-08-07"
  });
  assert.deepEqual(violations, []);
  assert.equal(dbApi.getMeta(db, "protectedTierViolation", ""), "");

  // isLearnedMutedItem only true for links.
  assert.equal(
    sync.isLearnedMutedItem(db, {
      type: "signal.task",
      data: { groupId: "class-group" }
    }),
    false
  );
  assert.equal(
    sync.isLearnedMutedItem(db, {
      type: "signal.link",
      data: { groupId: "class-group", url: "https://x.test" }
    }),
    true
  );

  console.log("section-d-protected tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
