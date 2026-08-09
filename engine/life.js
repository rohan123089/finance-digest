"use strict";

/**
 * Rules-first life capture: turn email/message text into tasks, deadlines,
 * and calendar-shaped events tagged personal | school | professional.
 * No AI — deterministic patterns only. Hub connectors call this; HTML never does.
 */

const DOMAINS = Object.freeze(["personal", "school", "professional"]);

const SCHOOL_RE =
  /\b(assignment|homework|canvas|blackboard|syllabus|lecture|professor|ta\b|midterm|final exam|due date|class of|course)\b/i;
const PROFESSIONAL_RE =
  /\b(meeting|standup|stand-up|interview|client|invoice|payroll|okr|sprint|calendar invite|teams meeting|zoom|deadline for review|action required)\b/i;
const PERSONAL_RE =
  /\b(dentist|doctor|family|birthday|rsvp|party|vacation|lease|rent due|utility)\b/i;

const DEADLINE_RE =
  /\b(?:due(?:\s+(?:by|on|date))?|deadline|submit(?:\s+by)?|complete(?:\s+by)?|rsvp\s+by|sign[- ]?ups?\s+close|apply by|applications?\s+close|fill(?:\s+(?:it|this|the form))?\s+out by)\b[:\s-]*([^\n.!?]{3,60})/i;
const EVENT_RE =
  /\b(?:meeting|call|interview|appointment|class|lecture|dinner|lunch|brunch|drinks|hang(?:\s*out)?|party|game night|trivia|training|who's in|who(?:'s| is) (?:free|coming)|come (?:over|join|to)|see you|lets meet|let's meet|hosting|tonight|this weekend)\b[^\n.!?]{0,100}/i;
/** Chat-only: require a time cue or near-term day word — bare weekdays alone are too noisy. */
const CHAT_EVENT_RE =
  /\b(?:tonight|tmrw|tmr|tomorrow|this weekend)\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\b[^\n]{0,40}\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i;
const TASK_RE =
  /\b(?:todo|to-?do|action required|please (?:complete|review|submit|confirm|fill|sign|apply|register)|reminder[:\s]|don't forget|follow[- ]?up|sign[- ]?up|register|volunteer|fill out|applications?\s+(?:are\s+)?open|still missing)\b/i;
const STATEMENT_RE =
  /\b(?:e-?statement|account statement|monthly statement|your statement|statement (?:is|for|ready|available)|statement notification)\b/i;
/** GroupMe / chat system chatter that should never become Digest work. */
const CHAT_NOISE_RE =
  /\b(?:has joined the group|have joined the group|joined the group|has left the group|have left the group|left the group|added .+ to the group|removed .+ from the group|pinned a message|unpinned a message|this message was deleted|a message was deleted|changed the group(?:'s|s)? (?:name|avatar|topic)|liked (?:your|a) message|named the group|updated the group(?:'s|s)? nickname)\b/i;
/** Receipts / booking confirmations — informational, not open Digest work. */
const CONFIRMATION_RE =
  /\b(?:appointment|registration|booking|reservation|order)\s+confirmation\b|\b(?:payment|order)\s+(?:confirmation|confirmed|is complete|was (?:successful|completed|received))\b|\bconfirmed:\s*your\s+(?:payment|order|purchase)\b|\byour\s+(?:payment|purchase)\s+(?:to\b.+?\s+)?is complete\b/i;
const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

/** Map statement email clues → local Money account ids (PDF/CSV/OFX import targets). */
const STATEMENT_ACCOUNT_RULES = [
  {
    accountId: "uwcu-checking",
    label: "UWCU",
    match: /\b(?:uwcu|uw credit union|university of wisconsin credit union)\b/i
  },
  { accountId: "amex", label: "Amex", match: /\b(?:american express|amex)\b/i },
  { accountId: "discover", label: "Discover", match: /\bdiscover\b/i },
  { accountId: "vanguard", label: "Vanguard", match: /\bvanguard\b/i }
];

const MONTHS = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11
};

function normalizeDomain(value) {
  const d = String(value || "").toLowerCase();
  return DOMAINS.includes(d) ? d : "personal";
}

function inferDomain(text, from = "") {
  const hay = `${text}\n${from}`;
  if (SCHOOL_RE.test(hay) || /@(?:edu|ac\.)/i.test(from)) return "school";
  if (PROFESSIONAL_RE.test(hay) || /@(?:corp|inc|llc)\./i.test(from)) return "professional";
  if (PERSONAL_RE.test(hay)) return "personal";
  return "personal";
}

function parseLooseDate(fragment, asOf = new Date()) {
  if (!fragment) return null;
  const raw = String(fragment).trim();
  const iso = raw.match(/\b(20\d{2}-\d{2}-\d{2})(?:[T\s](\d{2}:\d{2})(?::\d{2})?)?/);
  if (iso) {
    const time = iso[2] ? `${iso[2]}:00` : "12:00:00";
    const d = new Date(`${iso[1]}T${time}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const lower = raw.toLowerCase();
  if (/\b(?:tomorrow|tmrw|tmr)\b/.test(lower)) {
    const d = new Date(asOf);
    d.setUTCDate(d.getUTCDate() + 1);
    const time = parseClock(lower);
    d.setUTCHours(time?.hour ?? 12, time?.minute ?? 0, 0, 0);
    return d.toISOString();
  }
  if (/\btonight\b/.test(lower)) {
    const d = new Date(asOf);
    d.setUTCHours(19, 0, 0, 0);
    return d.toISOString();
  }
  if (/\bthis weekend\b/.test(lower)) {
    const d = new Date(asOf);
    const day = d.getUTCDay();
    const add = day <= 6 ? (6 - day) % 7 || 7 : 0;
    d.setUTCDate(d.getUTCDate() + (add || 0));
    if (d <= asOf) d.setUTCDate(d.getUTCDate() + 7);
    d.setUTCHours(12, 0, 0, 0);
    return d.toISOString();
  }
  const inDays = lower.match(/\bin\s+(\d+)\s+days?\b/);
  if (inDays) {
    const d = new Date(asOf);
    d.setUTCDate(d.getUTCDate() + Number(inDays[1]));
    d.setUTCHours(12, 0, 0, 0);
    return d.toISOString();
  }

  const weekday = lower.match(
    /\b(sun|mon|tue|wed|thu|fri|sat)(?:day)?\b(?:\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/
  );
  if (weekday) {
    const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const target = map[weekday[1]];
    const d = new Date(asOf);
    const delta = (target - d.getUTCDay() + 7) % 7 || 7;
    d.setUTCDate(d.getUTCDate() + delta);
    let hour = weekday[2] != null ? Number(weekday[2]) : 19;
    let minute = weekday[3] != null ? Number(weekday[3]) : 0;
    const ampm = (weekday[4] || "").toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    if (!ampm && hour <= 7) hour += 12; // "Friday 7" → 7pm social default
    d.setUTCHours(hour, minute, 0, 0);
    return d.toISOString();
  }

  const clockOnly = parseClock(lower);
  if (clockOnly && /\b(?:at|@)\s*\d{1,2}/.test(lower)) {
    const d = new Date(asOf);
    d.setUTCHours(clockOnly.hour, clockOnly.minute, 0, 0);
    if (d < asOf) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString();
  }

  const md = raw.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d{2}))?(?:\s+(\d{1,2}):(\d{2})\s*(am|pm)?)?/i
  );
  if (md) {
    const month = MONTHS[md[1].toLowerCase().slice(0, 3)] ?? MONTHS[md[1].toLowerCase()];
    const day = Number(md[2]);
    const year = md[3] ? Number(md[3]) : asOf.getUTCFullYear();
    let hour = 12;
    let minute = 0;
    if (md[4] != null) {
      hour = Number(md[4]);
      minute = Number(md[5] || 0);
      const ampm = (md[6] || "").toLowerCase();
      if (ampm === "pm" && hour < 12) hour += 12;
      if (ampm === "am" && hour === 12) hour = 0;
    }
    const d = new Date(Date.UTC(year, month, day, hour, minute, 0));
    if (d < asOf && !md[3]) d.setUTCFullYear(year + 1);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  return null;
}

function parseClock(text) {
  const m = String(text).match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  const ampm = m[3].toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  return { hour, minute };
}

function titleFrom(subject, fallback) {
  const t = String(subject || fallback || "Untitled").replace(/\s+/g, " ").trim();
  return t.slice(0, 140);
}

function matchStatementAccount(text, from) {
  const hay = `${text}\n${from}`;
  return STATEMENT_ACCOUNT_RULES.find((rule) => rule.match.test(hay)) || null;
}

function isStatementMessage(text) {
  return STATEMENT_RE.test(text);
}

function isChatSource(source) {
  const s = String(source || "").toLowerCase();
  return s === "sms" || s === "groupme" || s === "imessage" || s === "chat";
}

function isChatNoiseText(text) {
  const raw = String(text || "").trim();
  if (!raw) return true;
  return CHAT_NOISE_RE.test(raw);
}

function isConfirmationText(text) {
  return CONFIRMATION_RE.test(String(text || ""));
}

/**
 * GroupMe system / membership / pin / delete lines — not actionable Digest work.
 * Prefer structured flags when present; fall back to text patterns.
 */
function isGroupMeNoiseMessage(message) {
  if (!message || typeof message !== "object") return true;
  if (message.system === true) return true;
  const senderType = String(message.sender_type || "").toLowerCase();
  if (senderType === "system" || senderType === "service") return true;
  const eventType = String(message.event?.type || message.event?.name || "").toLowerCase();
  if (eventType) {
    // Keep GroupMe calendar / scheduled-event payloads — those can be real plans.
    if (/^(calendar\.|event\.(?:create|update|starting))/.test(eventType)) {
      // fall through to text extraction
    } else if (
      /^(membership\.|message\.|group\.|channel\.|poll\.|reaction\.)/.test(eventType)
    ) {
      return true;
    }
  }
  return isChatNoiseText(message.text || message.subject || "");
}

function extractFromChat(message, options = {}) {
  if (isChatNoiseText(message.text || message.subject || "")) {
    return [];
  }
  return extractFromMessage(
    {
      ...message,
      source: message.source || "sms",
      subject: message.subject || message.text || "",
      snippet: message.snippet || message.body || message.text || "",
      from: message.from || message.sender || message.source || ""
    },
    options
  );
}

/**
 * @param {{ id: string, subject?: string, snippet?: string, body?: string, from?: string, receivedAt?: string, url?: string }} message
 * @param {{ asOf?: Date }} [options]
 * @returns {Array<object>} sync-shaped signal items (without collectedAt)
 */
function extractFromMessage(message, options = {}) {
  const idBase = String(message.id || "msg");
  const subject = String(message.subject || "");
  const body = String(message.body || message.snippet || "");
  const text = `${subject}\n${body}`;
  const from = String(message.from || "");
  const asOf = options.asOf instanceof Date ? options.asOf : new Date();
  const receivedAt = message.receivedAt || asOf.toISOString();
  const hints = options.learnedHints || {};

  // Protected tier: mute/drop suppress reading/social links only — never tasks/events/deadlines.
  const muteReadingOnly = Boolean(hints.mute || hints.forceKind === "drop");

  let domain = normalizeDomain(
    hints.domain || message.domain || inferDomain(text, from)
  );
  const items = [];

  // Bank/credit-union statements → remind to import PDF/CSV/OFX (SimpleFIN covers live sync elsewhere).
  if (isStatementMessage(text) || isStatementMessage(from)) {
    const matched = matchStatementAccount(text, from);
    const label = matched?.label || "account";
    const accountId = matched?.accountId || null;
    const isUwcu = accountId === "uwcu-checking" || /uwcu/i.test(label);
    items.push({
      id: `life:statement:${idBase}`,
      type: "signal.task",
      source: message.source || "email",
      at: receivedAt,
      data: {
        title: accountId
          ? isUwcu
            ? `Import ${label} PDF statement into Money`
            : `Import ${label} statement into Money`
          : `Import bank statement into Money`,
        dueAt: receivedAt,
        domain: "personal",
        sourceRef: message.sourceRef || `email:${idBase}`,
        why: "statement email",
        kind: "import.statement",
        accountId,
        accountLabel: label,
        preferredFormat: isUwcu ? "pdf" : "auto",
        from: from || null,
        mailbox: message.mailbox || null
      }
    });
    return items;
  }

  // Pure confirmations (appointment booked, payment landed) are not open Today
  // work — emit a close-hint so follow-up loops can auto-resolve as inferred.
  // Note: "is complete" can trip DEADLINE_RE via "complete"; confirmation wins.
  if (CONFIRMATION_RE.test(text) && !TASK_RE.test(text)) {
    items.push({
      id: `life:confirm:${idBase}`,
      type: "signal.confirmation",
      source: message.source || "email",
      at: receivedAt,
      data: {
        title: titleFrom(subject, "Confirmation"),
        subject,
        from: from || null,
        why: "confirmation",
        sourceRef: message.sourceRef || `email:${idBase}`
      }
    });
    return items;
  }

  // Outbound / sent reply — closes matching follow-up loops (inferred).
  if (
    message.sent === true ||
    message.outbound === true ||
    /\b(?:^|\s)re:\s/i.test(subject)
  ) {
    const looksOutbound =
      message.sent === true ||
      message.outbound === true ||
      Boolean(message.labelIds?.includes?.("SENT"));
    if (looksOutbound || message.replySent === true) {
      items.push({
        id: `life:reply:${idBase}`,
        type: "signal.replySent",
        source: message.source || "email",
        at: receivedAt,
        data: {
          title: titleFrom(subject, "Sent reply"),
          subject,
          from: from || null,
          why: "sent reply",
          sourceRef: message.sourceRef || `email:${idBase}`
        }
      });
    }
  }
  const forceKind = hints.forceKind || null;
  const deadlineMatch = text.match(DEADLINE_RE);
  const dueAt =
    parseLooseDate(deadlineMatch?.[1], asOf) ||
    parseLooseDate(text, asOf);

  const wantTask =
    forceKind === "task" ||
    (!forceKind &&
      (deadlineMatch || (TASK_RE.test(text) && dueAt) || TASK_RE.test(text)));
  const wantEvent =
    forceKind === "event" ||
    (!forceKind &&
      !wantTask &&
      (EVENT_RE.test(text) ||
        (isChatSource(message.source) && CHAT_EVENT_RE.test(text))));

  if (wantTask && (deadlineMatch || dueAt || TASK_RE.test(text) || forceKind === "task")) {
    items.push({
      id: `life:task:${idBase}`,
      type: "signal.task",
      source: message.source || "email",
      at: receivedAt,
      data: {
        title: titleFrom(subject, deadlineMatch?.[0] || "Task"),
        dueAt: dueAt || null,
        domain,
        sourceRef: message.sourceRef || `email:${idBase}`,
        why: forceKind === "task" ? "learned force task" : deadlineMatch ? "deadline language" : "task language",
        from: from || null,
        groupId: message.groupId || null,
        mailbox: message.mailbox || null,
        accountSlot: message.accountSlot || null
      }
    });
  } else if (wantEvent) {
    const start =
      dueAt ||
      parseLooseDate(text, asOf) ||
      parseLooseDate(text.match(/\b(?:on|at)\s+([^\n.!?]{3,40})/i)?.[1], asOf) ||
      receivedAt;
    items.push({
      id: `life:event:${idBase}`,
      type: "signal.event",
      source: message.source || "email",
      at: receivedAt,
      data: {
        title: titleFrom(subject || body, "Event"),
        start,
        domain,
        sourceRef: message.sourceRef || `${message.source || "email"}:${idBase}`,
        dismissible: true,
        groupId: message.groupId || null,
        calendarId: message.calendarId || null,
        from: from || null,
        mailbox: message.mailbox || null,
        accountSlot: message.accountSlot || null
      }
    });
  }

  const urls = text.match(URL_RE) || (message.url ? [message.url] : []);
  // Only emit reading links when we did not already promote this message to life work,
  // or when it looks like a newsletter / plain share.
  if (urls.length && items.length === 0) {
    if (muteReadingOnly || hints.junkReading) return items;
    const cleaned = urls[0].replace(/[.,;:]+$/, "");
    let host = "";
    try {
      host = new URL(cleaned).hostname.replace(/^www\./, "");
    } catch (_error) {
      host = "";
    }
    items.push({
      id: `life:link:${idBase}`,
      type: "signal.link",
      source: message.source || "email",
      at: receivedAt,
      data: {
        url: cleaned,
        host: host || null,
        title: titleFrom(subject, cleaned),
        sharedBy: message.sharedBy || from || "email",
        from: from || null,
        context: null,
        domain,
        listIds: message.listIds || [],
        mailbox: message.mailbox || null,
        groupId: message.groupId || null
      }
    });
  }

  return items;
}

module.exports = {
  DOMAINS,
  STATEMENT_ACCOUNT_RULES,
  inferDomain,
  parseLooseDate,
  extractFromMessage,
  extractFromChat,
  matchStatementAccount,
  isStatementMessage,
  isChatSource,
  isChatNoiseText,
  isConfirmationText,
  isGroupMeNoiseMessage,
  normalizeDomain
};
