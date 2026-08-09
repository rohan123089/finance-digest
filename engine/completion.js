"use strict";

/**
 * Auto-inferred completion closes (reversible, marked how:"inferred").
 * - Lecture/calendar → topic reviewed (caller in sync.js)
 * - Matching money txn → bill paid for period
 * - Confirmation / sent-reply email → close open follow-up task
 */

const billsEngine = require("./bills.js");

function loadSkipSet(dbApi, db) {
  try {
    const raw = JSON.parse(dbApi.getMeta(db, "inferenceSkip", "[]"));
    return new Set(Array.isArray(raw) ? raw : []);
  } catch (_e) {
    return new Set();
  }
}

function saveSkipSet(dbApi, db, set) {
  dbApi.setMeta(db, "inferenceSkip", JSON.stringify([...set].slice(0, 200)));
}

function skipInference(dbApi, db, key) {
  if (!key) return;
  const set = loadSkipSet(dbApi, db);
  set.add(String(key));
  saveSkipSet(dbApi, db, set);
}

function isInferenceSkipped(dbApi, db, key) {
  return loadSkipSet(dbApi, db).has(String(key));
}

function recordInferredClose(dbApi, db, entry) {
  let list = [];
  try {
    list = JSON.parse(dbApi.getMeta(db, "inferredCloses", "[]"));
  } catch (_e) {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  list.unshift({
    ...entry,
    at: entry.at || new Date().toISOString(),
    how: "inferred"
  });
  dbApi.setMeta(db, "inferredCloses", JSON.stringify(list.slice(0, 100)));
}

function normalizeNeedle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value) {
  return normalizeNeedle(value)
    .split(" ")
    .filter((t) => t.length > 2);
}

function tokenOverlap(a, b) {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  ta.forEach((t) => {
    if (tb.has(t)) hit += 1;
  });
  return hit / Math.max(ta.size, tb.size);
}

function daysBetween(isoA, isoB) {
  const a = Date.parse(`${String(isoA).slice(0, 10)}T12:00:00Z`);
  const b = Date.parse(`${String(isoB).slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 9999;
  return Math.abs(Math.round((a - b) / 86400000));
}

/**
 * Match expense transactions to open bill reminders → mark paid (inferred).
 */
function inferBillPaidFromTransactions(dbApi, db) {
  const asOf =
    dbApi.getSettings(db).asOfDate || new Date().toISOString().slice(0, 10);
  const reminders = billsEngine.upcomingReminders(dbApi.listBills(db), asOf);
  if (!reminders.length) return [];
  const txs = dbApi
    .listTransactions(db)
    .filter((tx) => {
      if (tx.duplicateOf) return false;
      const dir = String(tx.direction || "").toLowerCase();
      if (dir === "in" || dir === "income") return false;
      // Outflows may be stored as negative amount OR positive + direction out.
      if (dir === "out" || dir === "expense") return true;
      return Number(tx.amount) < 0;
    });
  const closed = [];

  reminders.forEach((row) => {
    const inferKey = `bill:${row.bill.id}:${row.periodKey}`;
    if (isInferenceSkipped(dbApi, db, inferKey)) return;
    const billTitle = row.bill.title || "";
    const billAmt = Math.abs(Number(row.bill.amount) || 0);
    const dueDay = String(row.dueAt || "").slice(0, 10);

    const match = txs.find((tx) => {
      const merchant = tx.merchant || tx.rawMerchant || "";
      const overlap = tokenOverlap(billTitle, merchant);
      const nameHit =
        overlap >= 0.4 ||
        normalizeNeedle(merchant).includes(normalizeNeedle(billTitle)) ||
        normalizeNeedle(billTitle).includes(normalizeNeedle(merchant).slice(0, 12));
      if (!nameHit) return false;
      const txAmt = Math.abs(Number(tx.amount) || 0);
      const amountOk =
        billAmt === 0 || Math.abs(txAmt - billAmt) <= Math.max(1, billAmt * 0.05);
      if (!amountOk) return false;
      return daysBetween(tx.date, dueDay) <= 14;
    });

    if (!match) return;
    try {
      dbApi.markBillPaid(db, row.bill.id, row.periodKey);
      recordInferredClose(dbApi, db, {
        kind: "bill",
        id: inferKey,
        billId: row.bill.id,
        periodKey: row.periodKey,
        evidence: match.id,
        detail: `Inferred paid from txn ${match.id}`
      });
      closed.push(inferKey);
    } catch (_e) {
      // unknown bill — ignore
    }
  });

  return closed;
}

function isFollowUpTask(item) {
  if (!item || item.type !== "signal.task") return false;
  if (item.executed) return false;
  const title = String(item.data?.title || "");
  const why = String(item.data?.why || "");
  return /follow[- ]?up|reply|respond|get back|confirm/i.test(`${title} ${why}`);
}

/**
 * Confirmation or sent-reply signals close matching open follow-up tasks.
 */
function inferFollowUpsFromReplies(dbApi, db) {
  const items = dbApi.listSyncItems(db);
  const closers = items.filter(
    (item) =>
      (item.type === "signal.confirmation" || item.type === "signal.replySent") &&
      !item.executed
  );
  const followUps = items.filter(isFollowUpTask);
  const closed = [];

  closers.forEach((closer) => {
    if (isInferenceSkipped(dbApi, db, closer.id)) return;
    const hay = `${closer.data?.title || ""} ${closer.data?.subject || ""} ${closer.data?.from || ""}`;
    let best = null;
    let bestScore = 0;
    followUps.forEach((task) => {
      if (closed.includes(task.id)) return;
      if (isInferenceSkipped(dbApi, db, task.id)) return;
      const needle = `${task.data?.title || ""} ${task.data?.from || ""}`;
      let score = tokenOverlap(hay, needle);
      if (
        task.data?.from &&
        closer.data?.from &&
        normalizeNeedle(task.data.from) === normalizeNeedle(closer.data.from)
      ) {
        score += 0.35;
      }
      if (score > bestScore) {
        bestScore = score;
        best = task;
      }
    });

    if (best && bestScore >= 0.35) {
      dbApi.markActionExecuted(
        db,
        best.id,
        "done",
        `Inferred close via ${closer.type}`,
        { how: "inferred" }
      );
      recordInferredClose(dbApi, db, {
        kind: "task",
        id: best.id,
        evidence: closer.id,
        detail: `Closed by ${closer.type}`
      });
      closed.push(best.id);
    }

    dbApi.markActionExecuted(
      db,
      closer.id,
      "executed",
      best ? `Closed follow-up ${best.id}` : "Confirmation noted (no matching follow-up)",
      { how: "inferred" }
    );
  });

  return closed;
}

module.exports = {
  skipInference,
  isInferenceSkipped,
  recordInferredClose,
  inferBillPaidFromTransactions,
  inferFollowUpsFromReplies,
  tokenOverlap,
  isFollowUpTask
};
