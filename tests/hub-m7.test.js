"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
const connectors = require("../hub/connectors/index.js");
const sync = require("../hub/sync.js");
const life = require("../engine/life.js");
const { createServer } = require("../hub/server.js");

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload)
            }
          : {}
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const type = res.headers["content-type"] || "";
          resolve({
            status: res.statusCode,
            body: text && type.includes("json") ? JSON.parse(text) : null
          });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const asOf = new Date("2026-08-06T12:00:00Z");
  const school = life.extractFromMessage(
    {
      id: "s1",
      subject: "Homework due",
      snippet: "Assignment 2 due by 2026-08-20 on Canvas",
      from: "ta@college.edu"
    },
    { asOf }
  );
  assert.equal(school[0].type, "signal.task");
  assert.equal(school[0].data.domain, "school");
  assert.match(school[0].data.dueAt, /^2026-08-20/);

  const pro = life.extractFromMessage(
    {
      id: "p1",
      subject: "Standup",
      snippet: "Meeting tomorrow at 9am. Action required: update the doc.",
      from: "boss@corp.example"
    },
    { asOf }
  );
  assert.ok(pro.some((i) => i.type === "signal.task" || i.type === "signal.event"));
  assert.equal(pro[0].data.domain, "professional");

  const linkOnly = life.extractFromMessage(
    {
      id: "n1",
      subject: "Newsletter",
      snippet: "Enjoy https://example.com/read",
      from: "news@acme.example",
      sharedBy: "newsletter"
    },
    { asOf }
  );
  assert.equal(linkOnly[0].type, "signal.link");

  const statement = life.extractFromMessage(
    {
      id: "st1",
      subject: "Your UWCU e-Statement is ready",
      snippet: "Your University of Wisconsin Credit Union monthly statement is available.",
      from: "estatements@uwcu.org"
    },
    { asOf }
  );
  assert.equal(statement[0].type, "signal.task");
  assert.equal(statement[0].data.kind, "import.statement");
  assert.equal(statement[0].data.accountId, "uwcu-checking");
  assert.match(statement[0].data.title, /UWCU PDF statement/i);
  assert.equal(statement[0].data.preferredFormat, "pdf");

  const chat = life.extractFromChat(
    {
      id: "gm1",
      text: "Dinner Friday 7pm at Luigi's — who's in?",
      from: "Sam",
      source: "groupme"
    },
    { asOf }
  );
  assert.equal(chat[0].type, "signal.event");
  assert.match(chat[0].data.start, /T/);

  assert.deepEqual(
    life.extractFromChat({
      id: "gm-noise",
      text: "Nahush Keshav has joined the group",
      from: "GroupMe",
      source: "groupme"
    }),
    []
  );
  assert.equal(life.isGroupMeNoiseMessage({ system: true, text: "x pinned a message." }), true);
  assert.deepEqual(
    life.extractFromChat({
      id: "gm-plain",
      text: "lol same",
      from: "Sam",
      source: "groupme"
    }),
    []
  );

  const signup = life.extractFromChat(
    {
      id: "gm-form",
      text: "Please fill out this form by Friday if you want to sign up https://forms.gle/abc",
      from: "Sam",
      source: "groupme"
    },
    { asOf }
  );
  assert.ok(signup.some((row) => row.type === "signal.task" || row.type === "signal.link"));

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-hub-m7-"));
  const projectRoot = tmpRoot;
  const syncRoot = path.join(tmpRoot, "sync");
  const dbPath = path.join(tmpRoot, "finance.db");
  fs.mkdirSync(path.join(tmpRoot, "data"), { recursive: true });

  const key = Buffer.alloc(32, 7);
  const db = dbApi.openDatabase({
    seedSample: true,
    dbPath,
    encryptionKey: key,
    samplePath: path.join(__dirname, "../sample-data/transactions.json")
  });

  const email = await connectors.runEmail(db, { forceMock: true });
  assert.equal(email.mode, "mock");
  assert.ok(email.emitted.some((i) => i.type === "signal.task" && i.data.domain === "school"));
  assert.ok(
    email.emitted.some((i) => i.type === "signal.task" && i.data.domain === "professional")
  );
  assert.ok(email.emitted.some((i) => i.type === "signal.task" && i.data.domain === "personal"));
  assert.ok(email.emitted.some((i) => i.type === "signal.link"));
  assert.ok(
    email.emitted.some(
      (i) => i.type === "signal.task" && i.data.kind === "import.statement"
    )
  );

  const sms = await connectors.runSms(db, { forceMock: true });
  assert.ok(sms.emitted.some((i) => i.type === "signal.event" && i.source === "sms"));

  const groupme = await connectors.runGroupMe(db, { forceMock: true });
  assert.ok(groupme.emitted.some((i) => i.type === "signal.event"));

  const digest = sync.buildDigest(db);
  assert.ok(
    digest.detail.today.some(
      (row) => row.kind === "task" && row.domain === "school" && row.dueAt
    )
  );
  assert.ok(
    digest.detail.today.some(
      (row) =>
        row.kind === "import" &&
        row.actions?.some((a) => a.type === "import.statement")
    )
  );
  assert.ok(digest.detail.today.some((row) => row.actions?.some((a) => a.type === "calendar.add")));
  assert.ok(digest.detail.today.some((row) => row.actions?.some((a) => a.type === "rsvp.no")));
  assert.ok(digest.detail.today.some((row) => row.source === "sms" || row.source === "groupme"));
  assert.ok(digest.detail.reading.some((row) => String(row.url).includes("example.com/piece")));
  assert.ok(Array.isArray(digest.detail.watching));

  const event = digest.detail.today.find((row) =>
    row.kind === "event" && row.actions?.some((a) => a.type === "rsvp.no")
  );
  assert.ok(event);
  dbApi.upsertSyncItem(db, {
    id: "digest-act:rsvp.no:test",
    type: "action.rsvp.no",
    source: "digest",
    collectedAt: new Date().toISOString(),
    data: { targetRef: { itemId: event.id, response: "no" } }
  });
  sync.executePendingActions(db);
  const afterDecline = sync.buildDigest(db);
  assert.ok(afterDecline.detail.watching.some((row) => row.id === event.id));
  assert.ok(!afterDecline.detail.today.some((row) => row.id === event.id));

  const server = createServer(db, { projectRoot, syncRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const health = await request(port, "GET", "/api/health");
  assert.equal(health.body.milestone, "M7");
  assert.equal(health.body.lifeCapture, true);

  const apiDigest = await request(port, "GET", "/api/digest");
  assert.ok(apiDigest.body.detail.today.some((row) => row.domain === "school"));
  assert.ok(Array.isArray(apiDigest.body.detail.watching));

  // LAN outbox expands raw SMS the same way file ingest does
  const smsOut = await request(port, "POST", "/api/outbox", {
    items: [
      {
        id: "sms:outbox-test-1",
        type: "signal.sms",
        source: "sms",
        collectedAt: new Date().toISOString(),
        data: {
          text: "CS 400 assignment due Aug 20 — submit on Canvas",
          from: "classmate@wisc.edu"
        }
      }
    ]
  });
  assert.equal(smsOut.status, 200);
  assert.ok(smsOut.body.expanded >= 1);
  const afterSms = sync.buildDigest(db);
  assert.ok(
    afterSms.detail.today.some(
      (row) =>
        row.domain === "school" &&
        /assignment|CS 400/i.test(row.title || "")
    )
  );

  const calItem = afterSms.detail.today.find(
    (row) => row.actions?.some((a) => a.type === "calendar.add" && a.targetRef?.href)
  );
  assert.ok(calItem);
  const href = calItem.actions.find((a) => a.type === "calendar.add").targetRef.href;
  assert.match(href, /\/api\/calendar\/ics\?itemId=/);

  const icsRes = await new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${href}`, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            type: res.headers["content-type"],
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
      })
      .on("error", reject);
  });
  assert.equal(icsRes.status, 200);
  assert.match(icsRes.type, /text\/calendar/);
  assert.match(icsRes.body, /BEGIN:VCALENDAR/);
  assert.match(icsRes.body, /BEGIN:VEVENT/);
  assert.match(icsRes.body, /SUMMARY:/);

  await new Promise((resolve) => server.close(resolve));
  db.close();
  console.log("Hub M7 life capture (email/SMS/GroupMe → tasks + Watching) passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
