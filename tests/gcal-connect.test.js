"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const dbApi = require("../hub/db.js");
const gcal = require("../hub/connectors/gcal.js");
const sync = require("../hub/sync.js");
const connectors = require("../hub/connectors/index.js");

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-gcal-"));
  const dbPath = path.join(tempRoot, "finance.db");
  const key = Buffer.alloc(32, 9);
  const db = dbApi.openDatabase({ dbPath, encryptionKey: key });

  {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + 1);
    const signal = gcal.eventToSignal(
      {
        id: "abc",
        summary: "Block exam review",
        start: { dateTime: start.toISOString() },
        organizer: { email: "ta@school.edu" },
        htmlLink: "https://calendar.google.com/event?eid=abc"
      },
      { calendarId: "primary", mailbox: "you@example.com", db }
    );
    assert.ok(signal);
    assert.equal(signal.type, "signal.event");
    assert.equal(signal.source, "gcal");
    assert.equal(signal.data.calendarId, "primary");
    assert.match(signal.data.domain, /school|personal/);
  }

  {
    const result = await connectors.runGcal(db, { forceMock: true });
    assert.equal(result.mode, "mock");
    assert.ok(result.emitted.length >= 1);
    const digest = sync.buildDigest(db);
    assert.ok(
      digest.detail.today.some(
        (row) => row.source === "gcal" && /Office hours|Anatomy/i.test(row.title)
      ),
      "mock GCal event should appear in Digest Today"
    );
  }

  db.close();
  console.log("gcal-connect.test.js: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
