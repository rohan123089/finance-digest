"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
const sync = require("../hub/sync.js");
const cryptoUtil = require("../hub/crypto.js");

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fd-m3-"));
  const projectRoot = tmpRoot;
  const syncRoot = path.join(tmpRoot, "sync");
  const dbPath = path.join(tmpRoot, "test.db");
  fs.mkdirSync(path.join(tmpRoot, "data"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "sample-data"), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "../sample-data/transactions.json"),
    path.join(tmpRoot, "sample-data", "transactions.json")
  );

  // Point sample seed path via openDatabase samplePath.
  const db = dbApi.openDatabase({ seedSample: true, dbPath,
    encryptionKey: Buffer.from("sync-test-key-32-bytes-long!!!!"),
    samplePath: path.join(tmpRoot, "sample-data", "transactions.json")
  });

  sync.ensureSyncLayout(syncRoot);
  cryptoUtil.loadOrCreateKey(projectRoot);

  const outboxPath = await sync.writeSampleOutbox(projectRoot, syncRoot, [
    {
      id: "contact:a81f",
      type: "signal.birthday",
      source: "contacts",
      data: { name: "A. Rivera", month: 8, day: 6 }
    },
    {
      id: "gm:998877",
      type: "signal.event",
      source: "groupme",
      data: {
        title: "Dinner",
        start: "2026-08-08T19:00:00",
        sourceRef: "groupme:group/44/msg/998877"
      }
    },
    {
      id: "act:7f10",
      type: "action.unsubscribe",
      source: "digest",
      data: { targetRef: { listIds: ["news.acme.com"] } }
    }
  ]);

  assert.ok(fs.existsSync(outboxPath));
  const processed = await sync.ingestAllPending(db, projectRoot, syncRoot);
  assert.equal(processed.length, 1);
  assert.equal(processed[0].itemCount, 3);

  const items = dbApi.listSyncItems(db);
  assert.equal(items.length, 3);
  const action = items.find((item) => item.id === "act:7f10");
  assert.equal(action.executed, true);

  assert.ok(fs.existsSync(path.join(syncRoot, "down", "digest-latest.json.enc")));
  assert.ok(fs.existsSync(path.join(syncRoot, "down", "snapshot-latest.json.enc")));

  const digestBytes = fs.readFileSync(
    path.join(syncRoot, "down", "digest-latest.json.enc")
  );
  const digest = await cryptoUtil.decryptJson(projectRoot, digestBytes);
  assert.equal(digest.v, 1);
  assert.ok(digest.detail.today.some((item) => item.kind === "birthday"));
  assert.ok(digest.detail.junk.some((item) => item.action === "unsubscribe"));

  // Refuse newer envelope versions.
  let refused = false;
  try {
    sync.acceptVersion(99);
    const bad = await cryptoUtil.encryptJson(projectRoot, {
      v: 99,
      device: "phone",
      generatedAt: new Date().toISOString(),
      watermarks: {},
      items: []
    });
    const badPath = path.join(syncRoot, "up", `outbox-bad-${Date.now()}.json.enc`);
    fs.writeFileSync(badPath, bad);
    await sync.ingestOutboxFile(db, projectRoot, syncRoot, badPath);
  } catch (error) {
    refused = /version/i.test(error.message);
  }
  assert.equal(refused, true);

  db.close();
  console.log("Milestone 3 (legacy) sync ingest checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
