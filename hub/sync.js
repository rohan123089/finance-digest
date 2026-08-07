"use strict";

const fs = require("node:fs");
const path = require("node:path");
const cryptoUtil = require("./crypto.js");
const dbApi = require("./db.js");
const life = require("../engine/life.js");
const billsEngine = require("../engine/bills.js");

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
    if (item.type === "action.transaction.update" && item.data) {
      dbApi.commitTransactions(db, [item.data]);
      dbApi.markActionExecuted(db, item.id, "executed", "Transaction updated");
      return;
    }
    if (item.type === "action.settings.update" && item.data) {
      dbApi.saveSettings(db, item.data);
      dbApi.markActionExecuted(db, item.id, "executed", "Settings updated");
      return;
    }
    if (item.type === "action.bills.upsert" && item.data) {
      dbApi.upsertBill(db, item.data);
      dbApi.markActionExecuted(db, item.id, "executed", "Bill upserted");
      return;
    }
    if (item.type === "action.bills.delete" && item.data?.id) {
      dbApi.deleteBill(db, item.data.id);
      dbApi.markActionExecuted(db, item.id, "executed", "Bill deleted");
      return;
    }
    if (
      (item.type === "action.bill.paid" || item.type === "action.bill.pay") &&
      item.data
    ) {
      const ref = item.data.targetRef || item.data;
      let billId = ref.billId || null;
      let period = ref.periodKey || null;
      if (!billId && ref.itemId) {
        const match = String(ref.itemId).match(/^(bill:[^:]+)(?::(\d{4}-\d{2}))?$/);
        if (match) {
          billId = match[1];
          period = period || match[2] || null;
        }
      }
      if (billId) {
        dbApi.markBillPaid(db, billId, period);
      }
      dbApi.markActionExecuted(
        db,
        item.id,
        "executed",
        billId ? `Marked ${billId} paid for ${period || "period"}` : "Bill pay missing id"
      );
      return;
    }

    const targetId = item.data?.targetRef?.itemId;
    if (targetId && item.type === "action.dismiss") {
      const billId = item.data?.targetRef?.billId;
      const periodKey = item.data?.targetRef?.periodKey;
      if (billId) {
        dbApi.markBillPaid(db, billId, periodKey);
        dbApi.markActionExecuted(db, item.id, "executed", `Dismissed bill ${billId}`);
        return;
      }
      const target = dbApi.listSyncItems(db).find((row) => row.id === targetId);
      const status = target?.type === "signal.event" ? "declined" : "done";
      dbApi.markActionExecuted(
        db,
        targetId,
        status,
        status === "declined" ? "Not going — kept for awareness" : "Dismissed"
      );
      dbApi.markActionExecuted(db, item.id, "executed", `Dismissed ${targetId}`);
      return;
    }
    if (
      targetId &&
      (item.type === "action.rsvp.no" ||
        (item.type === "action.rsvp" && item.data?.response === "no"))
    ) {
      dbApi.markActionExecuted(db, targetId, "declined", "Not going — kept for awareness");
      dbApi.markActionExecuted(db, item.id, "executed", `Declined ${targetId}`);
      return;
    }
    if (
      targetId &&
      (item.type === "action.rsvp.yes" ||
        item.type === "action.going" ||
        (item.type === "action.rsvp" && item.data?.response === "yes"))
    ) {
      dbApi.markActionExecuted(db, targetId, "going", "Marked going");
      dbApi.markActionExecuted(db, item.id, "executed", `Going ${targetId}`);
      return;
    }
    if (
      targetId &&
      (item.type === "action.ack" ||
        item.type === "action.task.complete" ||
        item.type === "action.complete")
    ) {
      dbApi.markActionExecuted(db, targetId, "done", "Completed / dismissed from Today");
      dbApi.markActionExecuted(db, item.id, "executed", `Completed ${targetId}`);
      return;
    }

    // Hub records execution; phone-side effects happen on the device.
    dbApi.markActionExecuted(
      db,
      item.id,
      "executed",
      `Processed ${item.type} once`
    );
  });
}

function daysUntilBirthday(month, day, asOfDate) {
  if (!month || !day) return 366;
  const asOf = new Date(`${asOfDate}T12:00:00Z`);
  let next = new Date(Date.UTC(asOf.getUTCFullYear(), month - 1, day, 12));
  if (next < asOf) next = new Date(Date.UTC(asOf.getUTCFullYear() + 1, month - 1, day, 12));
  return Math.round((next - asOf) / (24 * 60 * 60 * 1000));
}

function readingScore(item) {
  const source = String(item.source || "").toLowerCase();
  const sharedBy = String(item.data?.sharedBy || "").toLowerCase();
  let score = 0;
  if (source === "sms" || source === "contacts") score += 30;
  else if (source === "groupme") score += 20;
  else if (source === "email") score += 10;
  if (sharedBy && sharedBy !== "newsletter") score += 5;
  return score;
}

function moneyTasksFromSnapshot(db) {
  const snapshot = dbApi.redactSnapshot(dbApi.computeLiveSnapshot(db));
  const tasks = [];
  if (snapshot.owed > 0) {
    tasks.push({
      kind: "task",
      id: "task:owed",
      title: `Reimburse outside payments · $${snapshot.owed.toFixed(2)}`,
      actions: [{ type: "ack", targetRef: { itemId: "task:owed", reason: "owed" } }]
    });
  }
  if (snapshot.safeToSpend.remaining < 0) {
    tasks.push({
      kind: "task",
      id: "task:safe-negative",
      title: `Safe-to-spend is negative · $${snapshot.safeToSpend.remaining.toFixed(2)}`,
      actions: [{ type: "ack", targetRef: { itemId: "task:safe-negative", reason: "safeToSpend" } }]
    });
  }
  return tasks;
}

/** Drop stale AI flags that no longer match the live redacted snapshot. */
function aiFlagStillRelevant(flag, snapshot) {
  if (!flag) return false;
  const trigger = String(flag.trigger || flag.id || "").toLowerCase();
  if (trigger.includes("owed")) return Number(snapshot.owed) > 0;
  if (trigger.includes("safe")) return Number(snapshot.safeToSpend?.remaining) < 0;
  if (trigger.includes("savings")) return Number(snapshot.savingsRatePct) < 20;
  // Unknown flags: keep only if they look like current proposal content with no stale trigger.
  return true;
}

function buildDigest(db) {
  const settings = dbApi.getSettings(db);
  const asOfDate = settings.asOfDate || new Date().toISOString().slice(0, 10);
  const items = dbApi.listSyncItems(db);
  const today = [];
  const watching = [];
  const reading = [];
  const junk = [];
  const seenReading = new Set();

  items.forEach((item) => {
    if (item.type === "signal.birthday") {
      if (item.executed && item.result?.status === "done") return;
      today.push({
        kind: "birthday",
        id: item.id,
        name: item.data.name,
        month: item.data.month,
        day: item.data.day,
        sortKey: daysUntilBirthday(item.data.month, item.data.day, asOfDate),
        actions: [{ type: "ack", targetRef: { itemId: item.id } }]
      });
    } else if (item.type === "signal.event") {
      const status = item.executed ? item.result?.status || "done" : "open";
      const row = {
        kind: "event",
        id: item.id,
        title: item.data.title,
        start: item.data.start,
        domain: item.data.domain || null,
        source: item.source || null,
        status,
        sortKey: item.data.start ? Date.parse(item.data.start) : Number.MAX_SAFE_INTEGER,
        actions: []
      };
      if (status === "declined") {
        // Still visible so you know it's happening — just not going.
        watching.push({ ...row, actions: [] });
        return;
      }
      if (status === "going" || status === "done") {
        return;
      }
      row.actions = [
        {
          type: "rsvp.yes",
          targetRef: { itemId: item.id, sourceRef: item.data.sourceRef, response: "yes" }
        },
        {
          type: "rsvp.no",
          targetRef: { itemId: item.id, sourceRef: item.data.sourceRef, response: "no" }
        },
        {
          type: "calendar.add",
          targetRef: { itemId: item.id, sourceRef: item.data.sourceRef }
        }
      ];
      today.push(row);
    } else if (item.type === "signal.task" || item.type === "signal.deadline") {
      if (item.executed && ["done", "declined"].includes(item.result?.status)) return;
      const dueAt = item.data.dueAt || item.data.deadline || null;
      const isImport = item.data.kind === "import.statement";
      const actions = [
        {
          type: "task.complete",
          targetRef: { itemId: item.id }
        }
      ];
      if (isImport) {
        actions.unshift({
          type: "import.statement",
          targetRef: {
            itemId: item.id,
            accountId: item.data.accountId || null,
            href: "/apps/money/money.html"
          }
        });
      } else {
        actions.push({
          type: "calendar.add",
          targetRef: { itemId: item.id, dueAt }
        });
        actions.push({
          type: "dismiss",
          targetRef: { itemId: item.id }
        });
      }
      today.push({
        kind: isImport ? "import" : "task",
        id: item.id,
        title: item.data.title || "Task",
        start: dueAt,
        dueAt,
        domain: item.data.domain || "personal",
        why: item.data.why || null,
        accountId: item.data.accountId || null,
        source: item.source || null,
        sortKey: dueAt ? Date.parse(dueAt) : Number.MAX_SAFE_INTEGER - 2,
        actions
      });
    } else if (item.type === "signal.receipt") {
      if (item.executed && item.result?.status === "done") return;
      today.push({
        kind: "task",
        id: item.id,
        title: `Review receipt · ${item.data.merchant || "Receipt"} · $${Number(item.data.total || 0).toFixed(2)}`,
        start: item.data.date || item.at,
        sortKey: item.data.date ? Date.parse(`${item.data.date}T12:00:00Z`) : Number.MAX_SAFE_INTEGER,
        actions: [{ type: "ack", targetRef: { itemId: item.id, imageRef: item.data.imageRef } }]
      });
    } else if (item.type === "signal.sms" && item.data?.text) {
      // Phone may push raw SMS; expand into life signals on the hub.
      // Already-expanded chats use signal.event/task/link directly.
      return;
    } else if (item.type === "signal.link") {
      const url = item.data.url;
      if (!url || seenReading.has(url)) return;
      seenReading.add(url);
      reading.push({
        id: item.id,
        title: item.data.title || url,
        url,
        source: item.data.sharedBy || item.source,
        score: readingScore(item)
      });
    } else if (item.type === "action.unsubscribe" || item.type === "signal.junk") {
      junk.push({
        id: item.id,
        action: item.type === "action.unsubscribe" ? "unsubscribe" : "mute",
        targetRef: item.data.targetRef || { itemId: item.id },
        status: item.executed ? item.result?.status || "executed" : "pending",
        pending: !item.executed
      });
    }
  });

  moneyTasksFromSnapshot(db).forEach((task) => {
    if (!today.some((row) => row.id === task.id)) {
      today.push({ ...task, sortKey: Number.MAX_SAFE_INTEGER - 1 });
    }
  });

  billsEngine.upcomingReminders(dbApi.listBills(db), asOfDate).forEach((row) => {
    const id = `bill:${row.bill.id.replace(/^bill:/, "")}:${row.periodKey}`;
    if (today.some((item) => item.id === id)) return;
    today.push({
      kind: "bill",
      id,
      title: billsEngine.reminderTitle(row),
      start: row.dueAt,
      dueAt: row.dueAt,
      domain: "personal",
      category: row.bill.category || null,
      amount: row.bill.amount,
      daysUntil: row.daysUntil,
      overdue: row.overdue,
      sortKey: row.dueAt ? Date.parse(row.dueAt) : Number.MAX_SAFE_INTEGER - 3,
      actions: [
        {
          type: "bill.paid",
          targetRef: {
            itemId: id,
            billId: row.bill.id,
            periodKey: row.periodKey
          }
        },
        {
          type: "dismiss",
          targetRef: {
            itemId: id,
            billId: row.bill.id,
            periodKey: row.periodKey
          }
        }
      ]
    });
  });

  // Latest AI proposal flags appear as read-only nudges — only while still true.
  const snapshot = dbApi.redactSnapshot(dbApi.computeLiveSnapshot(db));
  const latestProposal = dbApi.listAiProposals(db)[0];
  if (latestProposal && !latestProposal.accepted && Array.isArray(latestProposal.body?.flags)) {
    latestProposal.body.flags.forEach((flag) => {
      if (!aiFlagStillRelevant(flag, snapshot)) return;
      const id = `ai:${latestProposal.id}:${flag.id}`;
      if (today.some((row) => row.id === id)) return;
      today.push({
        kind: "nudge",
        id,
        title: flag.action || flag.why || "AI nudge",
        sortKey: Number.MAX_SAFE_INTEGER,
        actions: [
          {
            type: "ack",
            targetRef: {
              proposalId: latestProposal.id,
              flagId: flag.id
            }
          }
        ]
      });
    });
  }

  today.sort((a, b) => {
    const kindOrder = { birthday: 0, bill: 1, event: 2, task: 3, import: 3, nudge: 4 };
    const kindDiff = (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9);
    if (kindDiff !== 0) return kindDiff;
    if (a.kind === "task" && b.kind === "task") {
      const aLife = a.domain ? 0 : 1;
      const bLife = b.domain ? 0 : 1;
      if (aLife !== bLife) return aLife - bLife;
    }
    return (a.sortKey ?? 0) - (b.sortKey ?? 0);
  });

  watching.sort((a, b) => (a.sortKey ?? 0) - (b.sortKey ?? 0));

  reading
    .sort((a, b) => b.score - a.score)
    .forEach((row, index) => {
      row.rank = index + 1;
      delete row.score;
    });

  junk.sort((a, b) => Number(b.pending) - Number(a.pending));
  junk.forEach((row) => {
    delete row.pending;
  });
  today.forEach((row) => {
    delete row.sortKey;
  });
  watching.forEach((row) => {
    delete row.sortKey;
  });

  return {
    v: CURRENT_VERSION,
    generatedAt: new Date().toISOString(),
    asOfDate,
    today,
    watching,
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
    if (
      (item.type === "signal.sms" || item.type === "signal.chat") &&
      (item.data?.text || item.data?.body)
    ) {
      const signals = life.extractFromChat({
        id: item.id.replace(/^(sms|chat):/, ""),
        text: item.data.text || item.data.body,
        from: item.data.from || item.data.sharedBy || item.source,
        receivedAt: item.at || item.collectedAt,
        source: item.source || "sms",
        sourceRef: item.data.sourceRef || item.id,
        url: item.data.url
      });
      signals.forEach((signal) => {
        dbApi.upsertSyncItem(db, {
          ...signal,
          collectedAt: item.collectedAt || new Date().toISOString()
        });
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
  // Phone down-file must match the contract: redacted aggregates only.
  const live = dbApi.computeLiveSnapshot(db);
  const full = dbApi.redactSnapshot(live);
  const snapshot = {
    netWorth: full.netWorth,
    liquid: full.liquid,
    invested: full.invested,
    savingsRatePct: full.savingsRatePct,
    recurringMonthly: full.recurringMonthly,
    runwayMonths: full.runwayMonths,
    owed: full.owed,
    safeToSpend: {
      period: full.safeToSpend.period,
      amount: full.safeToSpend.amount,
      spent: full.safeToSpend.spent,
      remaining: full.safeToSpend.remaining
    },
    flags: full.flags || []
  };
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
  acceptVersion,
  executePendingActions
};
