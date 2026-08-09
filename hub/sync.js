"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cryptoUtil = require("./crypto.js");
const dbApi = require("./db.js");
const life = require("../engine/life.js");
const billsEngine = require("../engine/bills.js");
const syllabus = require("../engine/syllabus.js");
const completion = require("../engine/completion.js");

const CURRENT_VERSION = 1;
const PRIOR_VERSION = 0;

const HEAVY_EXAM_DAYS = 3;
const HEAVY_OVERDUE = 3;
const HEAVY_OPEN = 12;

function ensureSyncLayout(syncRoot) {
  ["up", "down", "meta", path.join("up", "attachments")].forEach((part) => {
    fs.mkdirSync(path.join(syncRoot, part), { recursive: true });
  });
}

function acceptVersion(v) {
  if (v === CURRENT_VERSION || v === PRIOR_VERSION) return true;
  return false;
}

/** Merge outbox targetRef learning keys onto the stored sync item. */
function enrichTargetForLearning(target, actionItem) {
  const ref = actionItem?.data?.targetRef || {};
  if (!target) {
    if (!ref.itemId) return null;
    return {
      id: ref.itemId,
      type: "signal.event",
      data: { ...ref }
    };
  }
  return {
    ...target,
    data: {
      ...(target.data || {}),
      from: target.data?.from || ref.from || null,
      groupId: target.data?.groupId || ref.groupId || null,
      calendarId: target.data?.calendarId || ref.calendarId || null,
      url: target.data?.url || ref.url || null,
      host: target.data?.host || ref.host || null,
      sourceRef: target.data?.sourceRef || ref.sourceRef || null,
      domain: target.data?.domain || ref.domain || null,
      listIds: target.data?.listIds || ref.listIds || null
    }
  };
}

function escapeIcsText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function toIcsUtc(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Build a downloadable .ics for a life event/task. Opens in any calendar app.
 */
function buildIcsForSyncItem(item) {
  if (!item || !item.data) return null;
  const title = item.data.title || item.data.name || "Life item";
  const startIso =
    item.data.start || item.data.dueAt || item.data.deadline || null;
  const startUtc = startIso ? toIcsUtc(startIso) : null;
  if (!startUtc) return null;

  const startMs = Date.parse(startIso);
  const endUtc = toIcsUtc(
    item.data.end || new Date(startMs + 60 * 60 * 1000).toISOString()
  );
  const uid = `${item.id}@finance-digest.local`;
  const domain = item.data.domain ? ` [${item.data.domain}]` : "";
  const description = [
    item.data.why || "",
    item.data.sourceRef ? `Source: ${item.data.sourceRef}` : "",
    item.source ? `Via: ${item.source}` : ""
  ]
    .filter(Boolean)
    .join("\n");
  const stamp = toIcsUtc(new Date().toISOString());

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Shelf Finance Digest//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${startUtc}`,
    `DTEND:${endUtc}`,
    `SUMMARY:${escapeIcsText(`${title}${domain}`)}`,
    description ? `DESCRIPTION:${escapeIcsText(description)}` : null,
    "END:VEVENT",
    "END:VCALENDAR",
    ""
  ]
    .filter((line) => line != null)
    .join("\r\n");
}

function icsForItemId(db, itemId) {
  const item = dbApi.listSyncItems(db).find((row) => row.id === itemId);
  if (!item) return null;
  if (
    item.type !== "signal.event" &&
    item.type !== "signal.task" &&
    item.type !== "signal.deadline"
  ) {
    return null;
  }
  return buildIcsForSyncItem(item);
}

/**
 * Expand raw SMS/chat outbox items into life signals (same rules as email).
 * Used by encrypted file ingest and LAN POST /api/outbox.
 */
function expandIncomingLifeItem(db, item) {
  if (!item?.id || !item?.type) return [];
  if (
    item.type !== "signal.sms" &&
    item.type !== "signal.chat"
  ) {
    return [];
  }
  const text = item.data?.text || item.data?.body;
  if (!text) return [];

  const chatMsg = {
    id: String(item.id).replace(/^(sms|chat):/, ""),
    text,
    from: item.data.from || item.data.sharedBy || item.source,
    receivedAt: item.at || item.collectedAt,
    source: item.source || (item.type === "signal.chat" ? "chat" : "sms"),
    sourceRef: item.data.sourceRef || item.id,
    url: item.data.url,
    groupId: item.data.groupId
  };
  const learnedHints = dbApi.resolveDigestLearned(db, chatMsg);
  const signals = life.extractFromChat(chatMsg, { learnedHints });
  const collectedAt = item.collectedAt || new Date().toISOString();
  signals.forEach((signal) => {
    dbApi.upsertSyncItem(db, {
      ...signal,
      collectedAt
    });
  });
  return signals;
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
    if (item.type === "action.bills.fromSuggestion" && item.data) {
      const bill = dbApi.promoteBillFromSuggestion(db, item.data);
      dbApi.markActionExecuted(
        db,
        item.id,
        "executed",
        `Bill promoted ${bill.id}`
      );
      return;
    }
    if (item.type === "action.bills.delete" && item.data?.id) {
      dbApi.deleteBill(db, item.data.id);
      dbApi.markActionExecuted(db, item.id, "executed", "Bill deleted");
      return;
    }
    if (
      item.type === "action.unsubscribe" ||
      item.type === "signal.junk"
    ) {
      dbApi.learnFromDigestAction(db, item, null);
      dbApi.markActionExecuted(db, item.id, "executed", "Muted / unsubscribed (learned)");
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
      const target = enrichTargetForLearning(
        dbApi.listSyncItems(db).find((row) => row.id === targetId),
        item
      );
      dbApi.learnFromDigestAction(db, item, target);
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
      const target = enrichTargetForLearning(
        dbApi.listSyncItems(db).find((row) => row.id === targetId),
        item
      );
      dbApi.learnFromDigestAction(
        db,
        { ...item, type: "action.rsvp.no" },
        target
      );
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
      const target = enrichTargetForLearning(
        dbApi.listSyncItems(db).find((row) => row.id === targetId),
        item
      );
      dbApi.learnFromDigestAction(
        db,
        { ...item, type: "action.rsvp.yes" },
        target
      );
      dbApi.markActionExecuted(db, targetId, "going", "Marked going");
      dbApi.markActionExecuted(db, item.id, "executed", `Going ${targetId}`);
      return;
    }
    if (
      targetId &&
      (item.type === "action.ack" ||
        item.type === "action.task.complete" ||
        item.type === "action.complete" ||
        item.type === "action.markDone")
    ) {
      const doneId = targetId || item.data?.taskId;
      if (doneId) {
        dbApi.markActionExecuted(db, doneId, "done", "Completed / dismissed from Today");
      }
      dbApi.markActionExecuted(db, item.id, "executed", `Completed ${doneId || "unknown"}`);
      return;
    }

    if (item.type === "action.markDone" && item.data?.taskId && !targetId) {
      dbApi.markActionExecuted(db, item.data.taskId, "done", "Completed via markDone");
      dbApi.markActionExecuted(db, item.id, "executed", `Completed ${item.data.taskId}`);
      return;
    }

    if (item.type === "action.markReviewed") {
      const topicId = item.data?.topicId || item.data?.targetRef?.topicId;
      if (topicId && (item.data?.clear === true || item.data?.undo === true)) {
        dbApi.clearTopicReviewed(db, topicId);
        dbApi.markActionExecuted(
          db,
          item.id,
          "executed",
          `Cleared review ${topicId}`
        );
        return;
      }
      if (topicId) {
        dbApi.markTopicReviewed(db, topicId, "manual");
      }
      dbApi.markActionExecuted(
        db,
        item.id,
        "executed",
        topicId ? `Reviewed topic ${topicId}` : "markReviewed missing topicId"
      );
      return;
    }

    // Reverse an inferred bill close (re-open that period's nag).
    if (
      (item.type === "action.bill.unpaid" || item.type === "action.unmarkDone") &&
      item.data
    ) {
      const ref = item.data.targetRef || item.data;
      const billId = ref.billId || null;
      const taskId = ref.taskId || ref.itemId || item.data.taskId || null;
      if (billId) {
        const periodKey = ref.periodKey || null;
        dbApi.clearBillPaid(db, billId);
        if (periodKey) {
          completion.skipInference(dbApi, db, `bill:${billId}:${periodKey}`);
        }
        dbApi.markActionExecuted(db, item.id, "executed", `Reopened bill ${billId}`);
        return;
      }
      if (taskId && item.type === "action.unmarkDone") {
        // Re-open: clear executed flag by upserting a fresh open copy is heavy —
        // skip re-inference and leave a note; caller may re-push the task.
        completion.skipInference(dbApi, db, taskId);
        dbApi.markActionExecuted(db, item.id, "executed", `Undo inferred close ${taskId}`);
        return;
      }
    }

    if (item.type === "action.confirmDate") {
      const assessmentId =
        item.data?.assessmentId || item.data?.targetRef?.assessmentId;
      const date = item.data?.date || item.data?.targetRef?.date || null;
      if (assessmentId) {
        dbApi.confirmAssessmentDate(db, assessmentId, date);
      }
      dbApi.markActionExecuted(
        db,
        item.id,
        "executed",
        assessmentId ? `Confirmed date ${assessmentId}` : "confirmDate missing id"
      );
      return;
    }

    if (item.type === "action.calendar.add") {
      const calTarget = item.data?.targetRef?.itemId;
      const ics = calTarget ? icsForItemId(db, calTarget) : null;
      dbApi.markActionExecuted(
        db,
        item.id,
        "executed",
        ics
          ? `Calendar ICS ready for ${calTarget}`
          : `Calendar add queued for ${calTarget || "unknown"} (no date)`
      );
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

/** Drop legacy GroupMe join/leave/pin rows and old "every message → event" fallbacks. */
function isNoiseDigestEvent(item) {
  const source = String(item.source || "").toLowerCase();
  const title = String(item.data?.title || item.data?.name || "");
  if (life.isChatNoiseText(title)) return true;
  if (life.isConfirmationText(title)) return true;
  if (source !== "groupme" && source !== "sms" && source !== "chat" && source !== "email") {
    return false;
  }
  // Re-run extraction on the stored title. Legacy GroupMe fallback events and
  // confirmation/newsletter leftovers that no longer match stay out of Today.
  const again =
    source === "email"
      ? life.extractFromMessage({
          id: "probe",
          subject: title,
          snippet: "",
          from: "",
          source: "email"
        })
      : life.extractFromChat({
          id: "probe",
          text: title,
          from: source,
          source
        });
  // Stored as event → only keep if title still looks like an event (not merely a task).
  return !again.some((row) => row.type === "signal.event");
}

function isNoiseDigestTask(item) {
  const title = String(item.data?.title || "");
  if (life.isChatNoiseText(title)) return true;
  if (!life.isConfirmationText(title)) return false;
  // Keep confirmations that also carry real deadline/action language.
  const again = life.extractFromMessage({
    id: "probe",
    subject: title,
    snippet: "",
    from: "",
    source: item.source || "email"
  });
  return again.length === 0;
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

/**
 * Protected-tier rule: learned mutes apply ONLY to reading/social (signal.link).
 * Deadlines, tasks, events, bills, assessments are never muted away.
 */
function isLearnedMutedItem(db, item) {
  if (!item) return false;
  if (item.type !== "signal.link") return false;
  const data = item.data || {};
  const hints = dbApi.resolveDigestLearned(db, {
    from: data.from || data.sender || data.sharedBy,
    sender: data.from || data.sender,
    groupId: data.groupId,
    calendarId: data.calendarId,
    listIds: data.listIds || [],
    url: data.url,
    sourceRef: data.sourceRef,
    data
  });
  if (hints.mute || hints.forceKind === "drop") return true;
  if (hints.junkReading) return true;
  return false;
}

function isProtectedTodayRow(row) {
  if (!row) return false;
  if (row.protected === true) return true;
  if (row.kind === "bill" || row.kind === "birthday") return true;
  if (row.kind === "deadline") return true;
  if (String(row.domain || "").toLowerCase() === "school") return true;
  if (row.kind === "task" && (row.dueAt || row.start)) return true;
  if (row.kind === "event" && String(row.source || "").toLowerCase() === "gcal") {
    return true;
  }
  if (row.kind === "event" && String(row.source || "").toLowerCase() === "canvas") {
    return true;
  }
  return false;
}

function glanceKind(row) {
  if (row.kind === "bill") return "deadline";
  if (row.kind === "birthday") return "personal";
  if (row.kind === "event") {
    const title = String(row.title || "").toLowerCase();
    if (/clinic|rotation|ward/.test(title)) return "clinic";
    if (/class|lecture|discussion|lab\b|section/.test(title)) return "class";
    if (String(row.domain || "").toLowerCase() === "school") return "class";
    return "event";
  }
  if (row.kind === "task" || row.kind === "import") {
    if (row.dueAt || row.start) return "deadline";
    return "personal";
  }
  return row.kind || "event";
}

function timeLabel(row) {
  const iso = row.start || row.dueAt || null;
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(11, 16) || null;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  if (hh === "00" && mm === "00" && String(iso).length <= 10) return null;
  return `${hh}:${mm}`;
}

function isDueOnDate(row, asOfDate) {
  const iso = row.start || row.dueAt || null;
  if (!iso) return false;
  return String(iso).slice(0, 10) === asOfDate;
}

function isOverdueRow(row, asOfDate) {
  if (row.overdue) return true;
  const iso = row.dueAt || row.start || null;
  if (!iso) return false;
  const day = String(iso).slice(0, 10);
  return day < asOfDate && (row.kind === "task" || row.kind === "bill" || row.kind === "import");
}

function buildAnchor({ heavyDay, clearDay, examHorizon, studyNext, backlog }) {
  if (clearDay) {
    return "You're clear today — nothing mandatory on the board.";
  }
  const nearest = examHorizon?.[0];
  if (nearest) {
    const readiness =
      nearest.total > 0 ? ` (${nearest.done} of ${nearest.total} topics)` : "";
    if (studyNext?.topic) {
      const chapter = studyNext.reading ? ` — ${studyNext.reading}` : "";
      if (heavyDay) {
        return `${nearest.name} is ${nearest.when}${readiness}. When you have a beat, start with ${studyNext.topic}${chapter}.`;
      }
      return `${nearest.name} is ${nearest.when}${readiness} — start with ${studyNext.topic}${chapter}.`;
    }
    if (heavyDay) {
      return `${nearest.name} is ${nearest.when}${readiness}. Keep the day light where you can.`;
    }
    return `${nearest.name} is ${nearest.when}${readiness}.`;
  }
  if (backlog?.overdue > 0) {
    return heavyDay
      ? `${backlog.overdue} overdue loop${backlog.overdue === 1 ? "" : "s"} waiting — pick one when you can.`
      : `${backlog.overdue} overdue · ${backlog.open} open loops.`;
  }
  if (backlog?.open > 0) {
    return `${backlog.open} open loop${backlog.open === 1 ? "" : "s"} on the board.`;
  }
  return "Quiet board — check Detail if you want the full picture.";
}

function inferTopicCoverageFromCalendar(db) {
  const topics = dbApi.listTopics(db).filter((t) => !t.reviewed);
  if (!topics.length) return;
  const events = dbApi
    .listSyncItems(db)
    .filter((item) => item.type === "signal.event" && item.source === "gcal");
  const asOf = dbApi.getSettings(db).asOfDate || new Date().toISOString().slice(0, 10);
  events.forEach((event) => {
    const status = event.executed ? event.result?.status : "open";
    if (status === "declined") return;
    const startDay = String(event.data?.start || "").slice(0, 10);
    if (startDay && startDay > asOf) return;
    // Only infer for events that already happened or are marked going.
    if (startDay === asOf && status !== "going" && status !== "done") return;
    const title = String(event.data?.title || "").toLowerCase();
    topics.forEach((topic) => {
      if (completion.isInferenceSkipped(dbApi, db, topic.id)) return;
      const needle = String(topic.title || "").toLowerCase();
      const lecture = String(topic.lectureRef || "").toLowerCase();
      if (!needle || needle.length < 4) return;
      if (title.includes(needle) || (lecture && title.includes(lecture))) {
        dbApi.markTopicReviewed(db, topic.id, "inferred");
        completion.recordInferredClose(dbApi, db, {
          kind: "topic",
          id: topic.id,
          evidence: event.id,
          detail: "Inferred from calendar attendance"
        });
      }
    });
  });
}

/** Learning keys + action identity for outbox → learnFromDigestAction. */
function digestTargetRef(item, extra = {}) {
  const data = item?.data || {};
  return {
    itemId: item.id,
    sourceRef: data.sourceRef || null,
    from: data.from || data.sender || data.sharedBy || null,
    groupId: data.groupId || null,
    calendarId: data.calendarId || null,
    url: data.url || null,
    host: data.host || null,
    mailbox: data.mailbox || null,
    listIds: data.listIds || null,
    domain: data.domain || null,
    ...extra
  };
}

const CANVAS_STALE_DAYS = 45;

function isStaleCanvasTask(item, asOfDate) {
  if (String(item.source || "").toLowerCase() !== "canvas") return false;
  const dueAt = item.data?.dueAt || item.data?.deadline || null;
  if (!dueAt) return false;
  const dueMs = Date.parse(dueAt);
  if (!Number.isFinite(dueMs)) return false;
  const asOfMs = Date.parse(`${asOfDate}T12:00:00Z`);
  if (!Number.isFinite(asOfMs)) return false;
  return asOfMs - dueMs > CANVAS_STALE_DAYS * 24 * 60 * 60 * 1000;
}

function eventDedupeKey(title, start) {
  const day = String(start || "").slice(0, 10);
  return `${String(title || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
    .toLowerCase()}|${day}`;
}

function buildDigest(db) {
  const settings = dbApi.getSettings(db);
  const asOfDate = settings.asOfDate || new Date().toISOString().slice(0, 10);
  // Auto-closes first so this digest reflects inferred done/paid state.
  completion.inferBillPaidFromTransactions(dbApi, db);
  completion.inferFollowUpsFromReplies(dbApi, db);
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
      if (isNoiseDigestEvent(item)) return;
      const status = item.executed ? item.result?.status || "done" : "open";
      // Watching keeps declined events for awareness even if learning mutes the source.
      if (status === "declined") {
        watching.push({
          kind: "event",
          id: item.id,
          title: item.data.title,
          start: item.data.start,
          domain: item.data.domain || null,
          source: item.source || null,
          status,
          sortKey: item.data.start ? Date.parse(item.data.start) : Number.MAX_SAFE_INTEGER,
          actions: []
        });
        return;
      }
      // Protected tier: never mute events away (mutes are reading/social only).
      const row = {
        kind: "event",
        id: item.id,
        title: item.data.title,
        start: item.data.start,
        domain: item.data.domain || null,
        source: item.source || null,
        from: item.data.from || null,
        groupId: item.data.groupId || null,
        calendarId: item.data.calendarId || null,
        status,
        sortKey: item.data.start ? Date.parse(item.data.start) : Number.MAX_SAFE_INTEGER,
        actions: []
      };
      if (status === "going" || status === "done") {
        return;
      }
      row.actions = [
        {
          type: "rsvp.yes",
          targetRef: digestTargetRef(item, { response: "yes" })
        },
        {
          type: "rsvp.no",
          targetRef: digestTargetRef(item, { response: "no" })
        },
        {
          type: "calendar.add",
          targetRef: digestTargetRef(item, {
            href: `/api/calendar/ics?itemId=${encodeURIComponent(item.id)}`
          })
        }
      ];
      // Prefer Google Calendar over duplicate chat/email events same title+day.
      row._dedupeKey = eventDedupeKey(row.title, row.start);
      row._sourceRank =
        String(item.source || "").toLowerCase() === "gcal"
          ? 0
          : String(item.source || "").toLowerCase() === "canvas"
            ? 1
            : 2;
      today.push(row);
    } else if (item.type === "signal.task" || item.type === "signal.deadline") {
      // Protected tier: never mute tasks/deadlines (mutes are reading/social only).
      if (isNoiseDigestTask(item)) return;
      if (isStaleCanvasTask(item, asOfDate)) return;
      if (item.executed && ["done", "declined"].includes(item.result?.status)) return;
      const dueAt = item.data.dueAt || item.data.deadline || null;
      const isImport = item.data.kind === "import.statement";
      const actions = [
        {
          type: "task.complete",
          targetRef: digestTargetRef(item)
        }
      ];
      if (isImport) {
        actions.unshift({
          type: "import.statement",
          targetRef: digestTargetRef(item, {
            accountId: item.data.accountId || null,
            href: "/apps/money/money.html"
          })
        });
      } else {
        actions.push({
          type: "calendar.add",
          targetRef: digestTargetRef(item, {
            dueAt,
            href: `/api/calendar/ics?itemId=${encodeURIComponent(item.id)}`
          })
        });
        actions.push({
          type: "dismiss",
          targetRef: digestTargetRef(item)
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
        from: item.data.from || null,
        groupId: item.data.groupId || null,
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
      if (isLearnedMutedItem(db, item)) return;
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
    } else if (
      item.type === "signal.confirmation" ||
      item.type === "signal.replySent"
    ) {
      // Used for inferred loop closes only — never on the glance.
      return;
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

  // Same chat/email often produced both a legacy event and a task — keep the task.
  const taskTitleKeys = new Set(
    today
      .filter((row) => row.kind === "task" || row.kind === "import")
      .map((row) =>
        String(row.title || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 100)
          .toLowerCase()
      )
  );
  for (let i = today.length - 1; i >= 0; i -= 1) {
    const row = today[i];
    if (row.kind !== "event") continue;
    const key = String(row.title || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100)
      .toLowerCase();
    if (taskTitleKeys.has(key)) today.splice(i, 1);
  }

  // Prefer gcal (then canvas) when the same title+day appears from multiple sources.
  const bestByKey = new Map();
  today.forEach((row, index) => {
    if (row.kind !== "event" || !row._dedupeKey) return;
    const prev = bestByKey.get(row._dedupeKey);
    if (
      !prev ||
      (row._sourceRank ?? 9) < (prev.row._sourceRank ?? 9)
    ) {
      bestByKey.set(row._dedupeKey, { row, index });
    }
  });
  const dropIndexes = new Set();
  today.forEach((row, index) => {
    if (row.kind !== "event" || !row._dedupeKey) return;
    const best = bestByKey.get(row._dedupeKey);
    if (best && best.index !== index) dropIndexes.add(index);
  });
  for (let i = today.length - 1; i >= 0; i -= 1) {
    if (dropIndexes.has(i)) today.splice(i, 1);
  }

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
    delete row._dedupeKey;
    delete row._sourceRank;
  });
  watching.forEach((row) => {
    delete row.sortKey;
  });

  // Tag protected rows for both surfaces.
  today.forEach((row) => {
    row.protected = isProtectedTodayRow(row);
    if (row.leadDays == null && row.kind === "bill") row.leadDays = 5;
    if (row.leadDays == null && row.domain === "school") row.leadDays = 7;
  });

  inferTopicCoverageFromCalendar(db);

  const assessments = dbApi.listAssessments(db);
  const topics = dbApi.listTopics(db);
  const examHorizon = syllabus.buildExamHorizon(assessments, topics, asOfDate);
  const studyNext = syllabus.pickStudyNext(assessments, topics, asOfDate);
  const needsALook = dbApi.listNeedsALook(db);

  const openLoops = today.filter(
    (row) =>
      row.kind === "task" ||
      row.kind === "import" ||
      row.kind === "bill" ||
      row.kind === "deadline"
  );
  const overdueLoops = openLoops.filter((row) => isOverdueRow(row, asOfDate));
  const backlogCounts = { open: openLoops.length, overdue: overdueLoops.length };

  const mandatoryToday = today.filter(
    (row) => row.protected && isDueOnDate(row, asOfDate)
  );
  // Missing syllabus/assessments must never read as all-clear.
  const coverageBlocksClear = (needsALook.coverageGaps || []).some(
    (gap) => gap.blocksClear
  );
  const clearDay =
    mandatoryToday.length === 0 &&
    overdueLoops.length === 0 &&
    !examHorizon.some((e) => e.when === "today") &&
    !coverageBlocksClear;
  const heavyDay =
    examHorizon.some((e) => syllabus.daysUntil(e.date, asOfDate) <= HEAVY_EXAM_DAYS) ||
    backlogCounts.overdue >= HEAVY_OVERDUE ||
    backlogCounts.open >= HEAVY_OPEN;

  const glanceToday = today
    .filter((row) => row.protected)
    .filter((row) => {
      const iso = row.start || row.dueAt;
      if (!iso) return row.kind === "birthday" || row.kind === "bill";
      const day = String(iso).slice(0, 10);
      const lead = row.leadDays != null ? row.leadDays : 3;
      const until = syllabus.daysUntil(day, asOfDate);
      return until <= lead;
    })
    .slice(0, 12)
    .map((row) => ({
      id: row.id,
      time: timeLabel(row),
      title: row.title || row.name || "Item",
      kind: glanceKind(row),
      protected: true,
      leadDays: row.leadDays != null ? row.leadDays : null
    }));

  const junkSummary = {
    count: junk.length,
    targetRef: junk[0]?.targetRef || null
  };

  const glanceReading = heavyDay
    ? []
    : reading.map((row) => ({ id: row.id, title: row.title }));

  const anchor = buildAnchor({
    heavyDay,
    clearDay,
    examHorizon,
    studyNext,
    backlog: backlogCounts
  });

  const detailBacklog = openLoops.map((row) => ({
    ...row,
    overdue: isOverdueRow(row, asOfDate)
  }));

  return {
    v: CURRENT_VERSION,
    generatedAt: new Date().toISOString(),
    date: asOfDate,
    asOfDate,
    glance: {
      clearDay,
      heavyDay,
      anchor,
      examHorizon,
      today: glanceToday,
      backlog: backlogCounts,
      studyNext,
      junk: junkSummary,
      reading: glanceReading
    },
    detail: {
      today,
      watching,
      backlog: detailBacklog,
      reading,
      junk,
      examHorizon,
      topics: topics.map((t) => ({
        id: t.id,
        courseId: t.courseId,
        assessmentId: t.assessmentId,
        title: t.title,
        week: t.week,
        readings: t.readings,
        reviewed: t.reviewed,
        reviewedHow: t.reviewedHow
      })),
      needsALook
    }
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
      expandIncomingLifeItem(db, item);
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
  executePendingActions,
  expandIncomingLifeItem,
  buildIcsForSyncItem,
  icsForItemId
};
