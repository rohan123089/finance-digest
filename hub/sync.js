"use strict";

const fs = require("node:fs");
const path = require("node:path");
const cryptoUtil = require("./crypto.js");
const dbApi = require("./db.js");

const CURRENT_VERSION = 1;
const PRIOR_VERSION = 0;

function ensureSyncLayout(syncRoot) {
  ["up", "down", "meta", path.join("up", "attachments")].forEach((part) => {
    fs.mkdirSync(path.join(syncRoot, part), { recursive: true });
  });
}

function acceptVersion(v) {
  if (v === CURRENT_VERSION || v === PRIOR_VERSION) return true;
  return false;
}

function executePendingActions(db) {
  const items = dbApi.listSyncItems(db).filter(
    (item) => item.type.startsWith("action.") && !item.executed
  );
  items.forEach((item) => {
    // Hub records execution; phone-side effects happen on the device.
    dbApi.markActionExecuted(
      db,
      item.id,
      "executed",
      `Processed ${item.type} once`
    );
  });
}

function buildDigest(db) {
  const items = dbApi.listSyncItems(db);
  const today = [];
  const reading = [];
  const junk = [];

  items.forEach((item) => {
    if (item.type === "signal.birthday") {
      today.push({
        kind: "birthday",
        id: item.id,
        name: item.data.name,
        month: item.data.month,
        day: item.data.day,
        actions: [
          {
            type: "ack",
            targetRef: { itemId: item.id }
          }
        ]
      });
    } else if (item.type === "signal.event") {
      today.push({
        kind: "event",
        id: item.id,
        title: item.data.title,
        start: item.data.start,
        actions: [
          {
            type: "rsvp",
            targetRef: { itemId: item.id, sourceRef: item.data.sourceRef }
          }
        ]
      });
    } else if (item.type === "signal.link") {
      reading.push({
        id: item.id,
        title: item.data.url,
        url: item.data.url,
        source: item.data.sharedBy || item.source,
        rank: reading.length + 1
      });
    } else if (item.type === "action.unsubscribe" || item.type === "signal.junk") {
      junk.push({
        id: item.id,
        action: item.type === "action.unsubscribe" ? "unsubscribe" : "mute",
        targetRef: item.data.targetRef || { itemId: item.id },
        status: item.executed ? item.result?.status : "pending"
      });
    }
  });

  return {
    v: CURRENT_VERSION,
    generatedAt: new Date().toISOString(),
    today,
    reading,
    junk
  };
}

async function ingestOutboxFile(db, projectRoot, syncRoot, filePath) {
  const bytes = fs.readFileSync(filePath);
  const envelope = await cryptoUtil.decryptJson(projectRoot, bytes);
  if (!acceptVersion(envelope.v)) {
    throw new Error(
      `Refusing envelope version ${envelope.v}; supported ${PRIOR_VERSION}-${CURRENT_VERSION}`
    );
  }

  const items = Array.isArray(envelope.items) ? envelope.items : [];
  items.forEach((item) => {
    if (!item?.id || !item?.type) return;
    dbApi.upsertSyncItem(db, item);
    if (item.type === "signal.receipt" && item.data) {
      const receiptId = `rcpt-tx:${item.id}`;
      dbApi.insertRawTransaction(db, {
        id: receiptId,
        date: item.data.date || new Date().toISOString().slice(0, 10),
        rawMerchant: item.data.merchant || "Receipt",
        amount: item.data.total || 0,
        account: "checking"
      });
    }
  });

  if (envelope.watermarks) {
    Object.entries(envelope.watermarks).forEach(([source, watermark]) => {
      dbApi.setConnectorWatermark(db, source, watermark);
    });
  }

  const hubCursor = dbApi.getCursor(db, "hub");
  hubCursor.lastIngest = path.basename(filePath);
  hubCursor.lastIngestAt = new Date().toISOString();
  hubCursor.itemCount = (hubCursor.itemCount || 0) + items.length;
  dbApi.setCursor(db, "hub", hubCursor);

  executePendingActions(db);
  await publishDown(db, projectRoot, syncRoot);
  return { itemCount: items.length, envelope };
}

async function publishDown(db, projectRoot, syncRoot) {
  ensureSyncLayout(syncRoot);
  const snapshot = dbApi.redactSnapshot(dbApi.computeLiveSnapshot(db));
  const digest = buildDigest(db);

  const snapshotBytes = await cryptoUtil.encryptJson(projectRoot, {
    v: CURRENT_VERSION,
    generatedAt: new Date().toISOString(),
    ...snapshot
  });
  const digestBytes = await cryptoUtil.encryptJson(projectRoot, digest);

  fs.writeFileSync(path.join(syncRoot, "down", "snapshot-latest.json.enc"), snapshotBytes);
  fs.writeFileSync(path.join(syncRoot, "down", "digest-latest.json.enc"), digestBytes);

  const phoneCursor = {
    snapshotAt: new Date().toISOString(),
    digestAt: new Date().toISOString(),
    keyFingerprint: cryptoUtil.keyFingerprint(projectRoot)
  };
  fs.writeFileSync(
    path.join(syncRoot, "meta", "hub-cursor.json"),
    JSON.stringify(phoneCursor, null, 2)
  );
  dbApi.setCursor(db, "phone", phoneCursor);
  return { snapshot, digest };
}

async function ingestAllPending(db, projectRoot, syncRoot) {
  ensureSyncLayout(syncRoot);
  const upDir = path.join(syncRoot, "up");
  const files = fs
    .readdirSync(upDir)
    .filter((name) => name.startsWith("outbox-") && name.endsWith(".json.enc"))
    .sort();

  const processed = [];
  for (const name of files) {
    const full = path.join(upDir, name);
    const doneMarker = `${full}.done`;
    if (fs.existsSync(doneMarker)) continue;
    const result = await ingestOutboxFile(db, projectRoot, syncRoot, full);
    fs.writeFileSync(doneMarker, new Date().toISOString());
    processed.push({ file: name, itemCount: result.itemCount });
  }

  if (processed.length === 0) {
    await publishDown(db, projectRoot, syncRoot);
  }
  return processed;
}

async function writeSampleOutbox(projectRoot, syncRoot, items) {
  ensureSyncLayout(syncRoot);
  const envelope = {
    v: CURRENT_VERSION,
    device: "phone",
    generatedAt: new Date().toISOString(),
    watermarks: { sms: "12345", groupme: "998877" },
    items
  };
  const bytes = await cryptoUtil.encryptJson(projectRoot, envelope);
  const name = `outbox-${Date.now()}.json.enc`;
  const full = path.join(syncRoot, "up", name);
  fs.writeFileSync(full, bytes);
  return full;
}

module.exports = {
  CURRENT_VERSION,
  ensureSyncLayout,
  ingestOutboxFile,
  ingestAllPending,
  publishDown,
  buildDigest,
  writeSampleOutbox,
  acceptVersion
};
