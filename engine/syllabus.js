"use strict";

/**
 * Deterministic syllabus / assessment map (Sift-style).
 * AI may only suggest low-confidence structure — never auto-trust dates.
 */

const ASSESSMENT_KIND_RE =
  /\b(final\s+exam|midterm|exam|quiz|test|assignment|homework|project|paper|lab\s+report)\b/i;
const WEEK_RE = /^\s*(?:week\s*(\d+)|w(\d+))\s*[:.\-]?\s*(.*)$/i;
const TOPIC_LINE_RE = /^\s*(?:[-•*]|\d+[.)])\s+(.+)$/;
const READING_RE = /\b(?:reading|read|chapter|ch\.?|pp\.?)\s*[\s:\-]+(.+)$/i;
const DATE_IN_LINE_RE =
  /\b((?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,?\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i;
const WEIGHT_RE = /\((\d{1,3})\s*%\)|\b(\d{1,3})\s*%/;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const DEFAULT_LEAD = { exam: 14, quiz: 7, assignment: 5 };

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "x";
}

function inferAssessmentKind(title) {
  const t = String(title || "").toLowerCase();
  if (/\b(final|midterm|exam)\b/.test(t)) return "exam";
  if (/\bquiz|test\b/.test(t)) return "quiz";
  return "assignment";
}

function defaultLeadDays(kind) {
  return DEFAULT_LEAD[kind] || DEFAULT_LEAD.assignment;
}

function parseWeight(line) {
  const m = String(line || "").match(WEIGHT_RE);
  if (!m) return null;
  return Number(m[1] || m[2]);
}

function parseMonthDay(raw, asOfYear) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const slash = text.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    let year = slash[3] ? Number(slash[3]) : asOfYear;
    if (year < 100) year += 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  const named = text.match(
    /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?/i
  );
  if (named) {
    const months = {
      jan: 1,
      feb: 2,
      mar: 3,
      apr: 4,
      may: 5,
      jun: 6,
      jul: 7,
      aug: 8,
      sep: 9,
      oct: 10,
      nov: 11,
      dec: 12
    };
    const month = months[named[1].slice(0, 3).toLowerCase()];
    const day = Number(named[2]);
    const year = named[3] ? Number(named[3]) : asOfYear;
    if (!month || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return null;
}

function weekdayName(isoDate) {
  const ms = Date.parse(`${isoDate}T12:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return WEEKDAYS[new Date(ms).getUTCDay()];
}

function extractWeekdayHint(line) {
  const m = String(line || "").match(
    /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i
  );
  return m ? m[1].slice(0, 3).toLowerCase() : null;
}

/**
 * Guard: weekday-vs-date typo and impossible calendar dates.
 * @returns {{ ok: boolean, conflict?: object }}
 */
function validateAssessmentDate(isoDate, line) {
  if (!isoDate) return { ok: false, conflict: { kind: "date-typo", detail: "missing date" } };
  const parts = isoDate.split("-").map(Number);
  if (parts.length !== 3) {
    return { ok: false, conflict: { kind: "date-typo", detail: `impossible date ${isoDate}` } };
  }
  const [y, m, d] = parts;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return {
      ok: false,
      conflict: { kind: "date-typo", detail: `impossible date ${isoDate}` }
    };
  }
  const hinted = extractWeekdayHint(line);
  const actual = weekdayName(isoDate);
  if (hinted && actual && hinted !== actual) {
    return {
      ok: false,
      conflict: {
        kind: "date-typo",
        detail: `syllabus says ${hinted} but ${isoDate} is ${actual}`
      }
    };
  }
  return { ok: true };
}

function formatWhen(isoDate, asOfDate) {
  if (!isoDate) return "";
  const asOfMs = Date.parse(`${asOfDate}T12:00:00Z`);
  const dueMs = Date.parse(`${String(isoDate).slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(dueMs)) return String(isoDate).slice(0, 10);
  const days = Math.round((dueMs - asOfMs) / (24 * 60 * 60 * 1000));
  if (days < 0) return "past";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  // Through one week out, name the weekday (Fri) — easier to act on than "1 wk".
  if (days <= 7) {
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return names[new Date(dueMs).getUTCDay()];
  }
  if (days < 14) return "1 wk";
  const weeks = Math.round(days / 7);
  return `${weeks} wks`;
}

function daysUntil(isoDate, asOfDate) {
  const asOfMs = Date.parse(`${asOfDate}T12:00:00Z`);
  const dueMs = Date.parse(`${String(isoDate).slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(dueMs)) return 9999;
  return Math.round((dueMs - asOfMs) / (24 * 60 * 60 * 1000));
}

/**
 * Parse plain syllabus text into course / assessments / topics.
 * @param {string} text
 * @param {{ courseId?: string, courseName?: string, term?: string, asOfDate?: string, source?: string }} [options]
 */
function parseSyllabusText(text, options = {}) {
  const asOfDate = options.asOfDate || new Date().toISOString().slice(0, 10);
  const asOfYear = Number(asOfDate.slice(0, 4));
  const source = options.source || "syllabus";
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd());

  let courseName = options.courseName || null;
  let term = options.term || null;
  for (const line of lines.slice(0, 40)) {
    if (!courseName && /[A-Z]{2,}\s*\d{2,4}/.test(line) && line.length < 80) {
      courseName = line.trim();
    }
    if (!term && /\b(fall|spring|summer|winter)\s+\d{4}\b/i.test(line)) {
      term = line.match(/\b((?:fall|spring|summer|winter)\s+\d{4})\b/i)?.[1] || term;
    }
  }
  courseName = courseName || options.courseName || "Course";
  const courseId = options.courseId || `course:${slug(courseName)}`;

  const assessments = [];
  const topics = [];
  const conflicts = [];
  const confirmDates = [];
  let currentWeek = null;
  let pendingTopics = [];

  const flushTopicsToAssessment = (assessmentId) => {
    pendingTopics.forEach((topic) => {
      topic.assessmentId = assessmentId;
      topics.push(topic);
    });
    pendingTopics = [];
  };

  lines.forEach((raw, index) => {
    const line = String(raw || "").trim();
    if (!line) return;

    const weekMatch = line.match(WEEK_RE);
    if (weekMatch) {
      currentWeek = Number(weekMatch[1] || weekMatch[2]);
      const rest = String(weekMatch[3] || "").trim();
      if (rest && !ASSESSMENT_KIND_RE.test(rest)) {
        pendingTopics.push({
          id: `topic:${courseId}:w${currentWeek}:${slug(rest)}:${index}`,
          courseId,
          assessmentId: null,
          title: rest.slice(0, 160),
          week: currentWeek,
          lectureRef: null,
          readings: [],
          confidence: "high",
          source
        });
      }
      return;
    }

    const topicMatch = line.match(TOPIC_LINE_RE);
    if (topicMatch && !ASSESSMENT_KIND_RE.test(line)) {
      const title = topicMatch[1].trim();
      const readingMatch = title.match(READING_RE);
      const readings = [];
      let topicTitle = title;
      if (readingMatch) {
        readings.push(readingMatch[1].trim());
        topicTitle = title.replace(READING_RE, "").replace(/[-–:]\s*$/, "").trim() || title;
      }
      pendingTopics.push({
        id: `topic:${courseId}:${slug(topicTitle)}:${index}`,
        courseId,
        assessmentId: null,
        title: topicTitle.slice(0, 160),
        week: currentWeek,
        lectureRef: currentWeek != null ? `week-${currentWeek}` : null,
        readings,
        confidence: "high",
        source
      });
      return;
    }

    if (!ASSESSMENT_KIND_RE.test(line)) return;

    const dateMatch = line.match(DATE_IN_LINE_RE);
    const dateRaw = dateMatch ? dateMatch[2] : null;
    const isoDate = dateRaw ? parseMonthDay(dateRaw, asOfYear) : null;
    const kind = inferAssessmentKind(line);
    const title = line
      .replace(DATE_IN_LINE_RE, "")
      .replace(WEIGHT_RE, "")
      .replace(/\s{2,}/g, " ")
      .replace(/[-–:]\s*$/, "")
      .trim()
      .slice(0, 160) || kind;

    const confidence = isoDate && dateMatch ? "high" : "low";
    const id = `assess:${courseId}:${slug(title)}:${isoDate || "tbd"}`;
    const assessment = {
      id,
      courseId,
      kind,
      title,
      date: isoDate,
      time: null,
      weight: parseWeight(line),
      source,
      confidence,
      leadDays: defaultLeadDays(kind),
      confirmed: confidence === "high",
      parsedDate: isoDate,
      canvasDate: null
    };

    if (isoDate) {
      const guard = validateAssessmentDate(isoDate, line);
      if (!guard.ok) {
        conflicts.push({ ...guard.conflict, assessmentId: id });
        assessment.confirmed = false;
        assessment.confidence = "low";
      }
    } else {
      assessment.confirmed = false;
      assessment.confidence = "low";
    }

    if (!assessment.confirmed) {
      confirmDates.push({
        assessmentId: id,
        proposedDate: isoDate,
        source,
        title
      });
    }

    assessments.push(assessment);
    flushTopicsToAssessment(id);
  });

  // Orphan topics (no following assessment) stay without assessmentId.
  pendingTopics.forEach((topic) => topics.push(topic));

  return {
    course: { id: courseId, name: courseName, term },
    assessments,
    topics,
    conflicts,
    confirmDates,
    parsedAt: new Date().toISOString()
  };
}

/**
 * Optional AI-shaped structure → always low confidence / confirm-me.
 * Never emit as confirmed fact.
 */
function fromAiExtraction(payload, options = {}) {
  const base = parseSyllabusText("", options);
  const courseId = options.courseId || base.course.id;
  const assessments = (payload?.assessments || []).map((row, i) => {
    const kind = inferAssessmentKind(row.title || row.kind);
    const id = row.id || `assess:${courseId}:ai:${slug(row.title)}:${i}`;
    return {
      id,
      courseId,
      kind,
      title: String(row.title || kind).slice(0, 160),
      date: row.date || null,
      time: row.time || null,
      weight: row.weight != null ? Number(row.weight) : null,
      source: "ai",
      confidence: "low",
      leadDays: defaultLeadDays(kind),
      confirmed: false,
      parsedDate: row.date || null,
      canvasDate: null
    };
  });
  const topics = (payload?.topics || []).map((row, i) => ({
    id: row.id || `topic:${courseId}:ai:${slug(row.title)}:${i}`,
    courseId,
    assessmentId: row.assessmentId || null,
    title: String(row.title || "Topic").slice(0, 160),
    week: row.week != null ? Number(row.week) : null,
    lectureRef: row.lectureRef || null,
    readings: Array.isArray(row.readings) ? row.readings : [],
    confidence: "low",
    source: "ai"
  }));
  const confirmDates = assessments.map((a) => ({
    assessmentId: a.id,
    proposedDate: a.date,
    source: "ai",
    title: a.title
  }));
  return {
    course: {
      id: courseId,
      name: payload?.course?.name || options.courseName || base.course.name,
      term: payload?.course?.term || options.term || null
    },
    assessments,
    topics,
    conflicts: [],
    confirmDates,
    parsedAt: new Date().toISOString()
  };
}

function readinessForAssessment(assessmentId, topics) {
  const tied = (topics || []).filter((t) => t.assessmentId === assessmentId);
  const total = tied.length;
  const done = tied.filter((t) => t.reviewed).length;
  return { done: Math.trunc(done) || 0, total: Math.trunc(total) || 0 };
}

/**
 * Highest-priority not-yet-reviewed topic: nearest confirmed assessment
 * (by proximity, then weight), then topics with readings, then earlier week.
 */
function pickStudyNext(assessments, topics, asOfDate) {
  const upcoming = (assessments || [])
    .filter((a) => a.confirmed && a.date)
    .filter((a) => daysUntil(a.date, asOfDate) >= 0)
    .sort((a, b) => {
      const d = daysUntil(a.date, asOfDate) - daysUntil(b.date, asOfDate);
      if (d !== 0) return d;
      return (Number(b.weight) || 0) - (Number(a.weight) || 0);
    });
  for (const assessment of upcoming) {
    let candidates = (topics || []).filter(
      (t) => t.assessmentId === assessment.id && !t.reviewed
    );
    if (!candidates.length) {
      // Topics hanging on the course/week without an assessment link.
      candidates = (topics || []).filter(
        (t) =>
          t.courseId === assessment.courseId &&
          !t.reviewed &&
          !t.assessmentId
      );
    }
    if (!candidates.length) continue;
    // Prefer topics with a listed reading, then earlier week.
    candidates.sort((a, b) => {
      const aRead = a.readings?.[0] ? 0 : 1;
      const bRead = b.readings?.[0] ? 0 : 1;
      if (aRead !== bRead) return aRead - bRead;
      return (a.week || 999) - (b.week || 999);
    });
    const topic = candidates[0];
    const { done, total } = readinessForAssessment(assessment.id, topics);
    return {
      topic: topic.title,
      topicId: topic.id,
      courseId: topic.courseId,
      assessmentId: assessment.id,
      done,
      total,
      reading: topic.readings?.[0] || null
    };
  }
  return null;
}

function buildExamHorizon(assessments, topics, asOfDate) {
  return (assessments || [])
    .filter((a) => a.confirmed && a.date)
    .map((a) => {
      const until = daysUntil(a.date, asOfDate);
      const lead = a.leadDays != null ? a.leadDays : defaultLeadDays(a.kind);
      return { assessment: a, until, lead };
    })
    .filter((row) => row.until >= 0 && row.until <= row.lead)
    .sort((a, b) => a.until - b.until || (Number(b.assessment.weight) || 0) - (Number(a.assessment.weight) || 0))
    .map(({ assessment: a }) => {
      const { done, total } = readinessForAssessment(a.id, topics);
      return {
        id: a.id,
        name: a.title,
        when: formatWhen(a.date, asOfDate),
        done,
        total,
        leadDays: a.leadDays != null ? a.leadDays : defaultLeadDays(a.kind),
        courseId: a.courseId,
        kind: a.kind,
        date: a.date
      };
    });
}

function pluralKind(kind, n) {
  if (kind === "quiz") return n === 1 ? "quiz" : "quizzes";
  if (kind === "exam") return n === 1 ? "exam" : "exams";
  if (kind === "assignment") return n === 1 ? "assignment" : "assignments";
  return n === 1 ? kind : `${kind}s`;
}

function summarizeWeekPressure(examHorizon, asOfDate) {
  const week = (examHorizon || []).filter(
    (e) => e.date && daysUntil(e.date, asOfDate) >= 0 && daysUntil(e.date, asOfDate) <= 7
  );
  if (week.length < 2) return null;
  const counts = {};
  week.forEach((e) => {
    const k = e.kind || "assessment";
    counts[k] = (counts[k] || 0) + 1;
  });
  const order = ["exam", "quiz", "assignment"];
  const parts = [];
  order.forEach((k) => {
    if (counts[k]) parts.push(`${counts[k]} ${pluralKind(k, counts[k])}`);
  });
  Object.keys(counts).forEach((k) => {
    if (!order.includes(k)) parts.push(`${counts[k]} ${pluralKind(k, counts[k])}`);
  });
  if (!parts.length) return null;
  let joined = parts[0];
  if (parts.length === 2) joined = `${parts[0]} and ${parts[1]}`;
  if (parts.length > 2) {
    joined = `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
  }
  // Capitalize first letter for sentence start.
  joined = joined.charAt(0).toUpperCase() + joined.slice(1);
  return { joined, week };
}

/**
 * One directional sentence. Never scolding. Softens under heavyDay.
 */
function buildGlanceAnchor({
  heavyDay,
  clearDay,
  examHorizon,
  studyNext,
  backlog,
  asOfDate
}) {
  if (clearDay) {
    return "You're clear today — nothing mandatory on the board.";
  }

  const focus = studyNext?.topic || null;
  const chapter = studyNext?.reading ? ` — ${studyNext.reading}` : "";
  const week = summarizeWeekPressure(examHorizon, asOfDate);
  if (week) {
    const start = focus || week.week[0]?.name || "the nearest one";
    if (heavyDay) {
      return `${week.joined} this week — when you have a beat, start with ${start}${chapter}.`;
    }
    return `${week.joined} this week — start with ${start}${chapter}.`;
  }

  const nearest = examHorizon?.[0];
  if (nearest) {
    const readiness =
      nearest.total > 0 ? ` (${nearest.done} of ${nearest.total} topics)` : "";
    if (focus) {
      if (heavyDay) {
        return `${nearest.name} is ${nearest.when}${readiness}. When you have a beat, start with ${focus}${chapter}.`;
      }
      return `${nearest.name} is ${nearest.when}${readiness} — start with ${focus}${chapter}.`;
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

function looksLikeSyllabusEmail(subject, body) {
  const text = `${subject || ""}\n${body || ""}`;
  return /\b(syllabus|course\s+schedule|class\s+schedule|calendar\s+update|schedule\s+update|revised\s+syllabus)\b/i.test(
    text
  );
}

module.exports = {
  DEFAULT_LEAD,
  slug,
  inferAssessmentKind,
  defaultLeadDays,
  parseMonthDay,
  validateAssessmentDate,
  formatWhen,
  daysUntil,
  parseSyllabusText,
  fromAiExtraction,
  readinessForAssessment,
  pickStudyNext,
  buildExamHorizon,
  buildGlanceAnchor,
  summarizeWeekPressure,
  looksLikeSyllabusEmail
};
