"use strict";

/**
 * Calendar-first schedule map.
 * Google Calendar is the date source of truth on conflict.
 * Canvas fills gaps: unmatched Canvas items become confirmed assessments;
 * when titles align with a calendar row, calendar date wins and Canvas date
 * is kept as `canvasDate` with a syllabus-vs-canvas conflict note.
 * Syllabus PDFs/emails enrich topics/readings; unmatched dates → confirm-me.
 */

const syllabus = require("./syllabus.js");

const ASSESSMENT_TITLE_RE =
  /\b(final|midterm|exam|quiz|test|assignment|homework|project|paper|due|deadline|submission)\b/i;
const CLASS_TITLE_RE =
  /\b(lecture|class|lab|discussion|section|seminar|clinic|tutorial|recitation)\b/i;

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(cs|bio|chem|hist|math|phys)\s*(\d{2,4})\b/g, "$1$2")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleTokens(value) {
  return normalizeTitle(value)
    .split(" ")
    .filter((t) => t.length > 2 && !["the", "and", "for", "with", "from"].includes(t));
}

/** Rough token overlap 0..1 */
function titleSimilarity(a, b) {
  const ta = new Set(titleTokens(a));
  const tb = new Set(titleTokens(b));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  ta.forEach((t) => {
    if (tb.has(t)) hit += 1;
  });
  return hit / Math.max(ta.size, tb.size);
}

function daysApart(isoA, isoB) {
  const a = Date.parse(`${String(isoA).slice(0, 10)}T12:00:00Z`);
  const b = Date.parse(`${String(isoB).slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 9999;
  return Math.abs(Math.round((a - b) / (24 * 60 * 60 * 1000)));
}

function inferKind(title) {
  return syllabus.inferAssessmentKind(title);
}

function leadForKind(kind) {
  return syllabus.defaultLeadDays(kind);
}

function courseIdFromCalendar(title, calendarId) {
  const code = String(title || "").match(/\b([A-Z]{2,4})\s*-?\s*(\d{2,4})\b/);
  if (code) {
    return `course:${syllabus.slug(`${code[1]}${code[2]}`)}`;
  }
  const cal = String(calendarId || "primary")
    .replace(/@.*/, "")
    .slice(0, 40);
  return `course:gcal:${syllabus.slug(cal)}`;
}

function courseNameFromTitle(title, fallback) {
  const code = String(title || "").match(/\b([A-Z]{2,4})\s*-?\s*(\d{2,4})\b/);
  if (code) return `${code[1]} ${code[2]}`;
  return fallback || "Calendar";
}

function isAssessmentLike(title, domain) {
  if (ASSESSMENT_TITLE_RE.test(title || "")) return true;
  if (String(domain || "").toLowerCase() === "school" && /\bdue\b/i.test(title || "")) {
    return true;
  }
  return false;
}

function isClassLike(title) {
  return CLASS_TITLE_RE.test(title || "");
}

/**
 * Find best calendar assessment matching a Canvas/syllabus title+date.
 * Prefers same-day (±1) + title similarity ≥ 0.35, else title ≥ 0.55 within 7 days.
 */
function findCalendarMatch(assessments, title, date) {
  const cals = (assessments || []).filter(
    (a) => a.source === "gcal" || a.source === "calendar"
  );
  let best = null;
  let bestScore = 0;
  cals.forEach((a) => {
    const sim = titleSimilarity(title, a.title);
    const apart = date && a.date ? daysApart(date, a.date) : 3;
    let score = sim;
    if (apart <= 1) score += 0.35;
    else if (apart <= 3) score += 0.15;
    else if (apart <= 7) score += 0.05;
    else score -= 0.2;
    if (score > bestScore && (sim >= 0.35 || (apart <= 1 && sim >= 0.2))) {
      bestScore = score;
      best = a;
    }
  });
  return bestScore >= 0.45 ? best : null;
}

/**
 * Seed / refresh an assessment from a Google Calendar event.
 * Calendar date is authoritative and confirmed.
 */
function seedFromGcalEvent(dbApi, db, signal) {
  const data = signal.data || {};
  const title = String(data.title || "").slice(0, 160);
  const start = data.start || signal.at;
  const date = start ? String(start).slice(0, 10) : null;
  if (!date || !title) return null;

  const domain = data.domain || "personal";
  const assessmentLike = isAssessmentLike(title, domain);
  const classLike = isClassLike(title);
  // School calendar items and assessment-like titles enter the map.
  if (!assessmentLike && String(domain).toLowerCase() !== "school" && !classLike) {
    return null;
  }

  const courseName = courseNameFromTitle(title, data.calendarId || "Calendar");
  const courseId = courseIdFromCalendar(title, data.calendarId);
  dbApi.upsertCourse(db, {
    id: courseId,
    name: courseName,
    canvasCourseId: null
  });

  const kind = assessmentLike ? inferKind(title) : "assignment";
  const id = `assess:gcal:${syllabus.slug(signal.id)}`;
  const time =
    start && String(start).length > 10
      ? String(start).slice(11, 16)
      : null;

  // Class/lecture rows still help topic coverage inference; mark as soft exams only if assessment-like.
  if (!assessmentLike && classLike) {
    // Optional topic stub from lecture title for study map.
    const topicId = `topic:gcal:${syllabus.slug(signal.id)}`;
    dbApi.upsertTopic(db, {
      id: topicId,
      courseId,
      assessmentId: null,
      title,
      week: null,
      lectureRef: title.slice(0, 80),
      readings: [],
      reviewed: false
    });
    return { kind: "topic", id: topicId };
  }

  return dbApi.upsertAssessment(db, {
    id,
    courseId,
    kind,
    title,
    date,
    time,
    source: "gcal",
    confidence: "high",
    leadDays: leadForKind(kind),
    confirmed: true,
    canvasDate: null,
    parsedDate: null
  });
}

/**
 * Seed Canvas item: match onto GCal when possible (calendar date wins).
 * No calendar match → Canvas fills the gap as a confirmed live assessment.
 */
function seedFromCanvasSignal(dbApi, db, signal) {
  const data = signal.data || {};
  const title = String(data.title || "Canvas item").slice(0, 160);
  const date = (data.dueAt || data.start || "").slice(0, 10) || null;
  if (!date) return null;

  const label = data.course || courseNameFromTitle(title, "Canvas");
  const courseId = (() => {
    const fromCode = String(data.context_code || "").match(/^course_(\d+)/i);
    if (fromCode) return `course:canvas:${fromCode[1]}`;
    const fromLabel = String(label).match(/Course\s+(\d+)/i);
    if (fromLabel) return `course:canvas:${fromLabel[1]}`;
    const code = title.match(/\b([A-Z]{2,4})\s*-?\s*(\d{2,4})\b/);
    if (code) return `course:${syllabus.slug(`${code[1]}${code[2]}`)}`;
    return `course:canvas:${syllabus.slug(label)}`;
  })();

  dbApi.upsertCourse(db, {
    id: courseId,
    name: label,
    canvasCourseId: courseId.replace(/^course:canvas:/, "") || null
  });

  const existing = dbApi.listAssessments(db);
  const match = findCalendarMatch(existing, title, date);
  if (match) {
    if (match.date !== date) {
      const conflicts = (() => {
        try {
          return JSON.parse(dbApi.getMeta(db, "syllabusConflicts", "[]"));
        } catch (_e) {
          return [];
        }
      })();
      const detail = `Canvas says ${date}, calendar says ${match.date} (calendar wins)`;
      if (!conflicts.some((c) => c.assessmentId === match.id && c.kind === "syllabus-vs-canvas")) {
        conflicts.push({
          kind: "syllabus-vs-canvas",
          detail,
          assessmentId: match.id,
          courseId: match.courseId
        });
        dbApi.setSyllabusConflicts(db, conflicts);
      }
    }
    // Keep calendar date; record Canvas date for honesty.
    return dbApi.upsertAssessment(db, {
      ...match,
      canvasDate: date,
      title: match.title || title,
      confirmed: true,
      confidence: "high"
    });
  }

  const kind = inferKind(title);
  return dbApi.upsertAssessment(db, {
    id: `assess:canvas:${syllabus.slug(signal.id)}`,
    courseId,
    kind,
    title,
    date,
    source: "canvas",
    confidence: "high",
    leadDays: leadForKind(kind),
    confirmed: true,
    canvasDate: date,
    parsedDate: null
  });
}

/**
 * Apply syllabus parse as enrichment only:
 * - topics/readings always welcome
 * - assessment dates match onto GCal/Canvas when possible
 * - unmatched syllabus dates → confirm-me only (never auto-horizon)
 * - never delete gcal/canvas assessments
 */
function applySyllabusEnrichment(dbApi, db, parsed, sourceMeta = {}) {
  if (!parsed?.course?.id) throw new Error("parsed.course.id required");
  const priorSources = dbApi.listSyllabusSources(db, parsed.course.id);
  const isUpdate = priorSources.length > 0;
  dbApi.upsertCourse(db, parsed.course);
  const sourceId =
    sourceMeta.id ||
    `syllabus:${parsed.course.id}:${sourceMeta.contentHash || parsed.parsedAt || Date.now()}`;
  dbApi.upsertSyllabusSource(db, {
    id: sourceId,
    courseId: parsed.course.id,
    sourceKind: sourceMeta.sourceKind || "file",
    path: sourceMeta.path || null,
    contentHash: sourceMeta.contentHash || null,
    parsedAt: parsed.parsedAt || new Date().toISOString(),
    rawRef: sourceMeta.rawRef || null
  });

  // Replace syllabus/email topics for this course; keep calendar-derived lecture topics.
  db.prepare(
    `DELETE FROM topics WHERE course_id = ? AND id NOT LIKE 'topic:gcal:%'`
  ).run(parsed.course.id);

  const live = dbApi.listAssessments(db);
  const confirmDates = [];
  const conflicts = [...(parsed.conflicts || [])];

  (parsed.assessments || []).forEach((a) => {
    const match =
      findCalendarMatch(live, a.title, a.date) ||
      findCalendarMatch(
        live.filter((x) => x.source === "canvas"),
        a.title,
        a.date
      );
    if (match) {
      if (a.date && match.date && a.date !== match.date) {
        conflicts.push({
          kind: "syllabus-vs-canvas",
          detail: `syllabus says ${a.date}, ${match.source} says ${match.date} (live schedule wins)`,
          assessmentId: match.id,
          courseId: match.courseId
        });
      }
      dbApi.upsertAssessment(db, {
        ...match,
        parsedDate: a.date || match.parsedDate,
        confirmed: true
      });
      return;
    }
    // No live match — confirm-me only, not on glance until approved.
    confirmDates.push({
      assessmentId: a.id,
      proposedDate: a.date,
      source: a.source || "syllabus",
      title: a.title
    });
    dbApi.upsertAssessment(db, {
      ...a,
      courseId: parsed.course.id,
      confirmed: false,
      confidence: "low",
      source: a.source || "syllabus",
      parsedDate: a.date
    });
  });

  (parsed.topics || []).forEach((t) => {
    // Attach topic to nearest matched assessment by week order if assessmentId set.
    let assessmentId = t.assessmentId || null;
    if (assessmentId) {
      const exists = live.some((x) => x.id === assessmentId);
      if (!exists) {
        const byTitle = (parsed.assessments || []).find((a) => a.id === assessmentId);
        if (byTitle) {
          const m = findCalendarMatch(live, byTitle.title, byTitle.date);
          assessmentId = m?.id || null;
        }
      }
    }
    dbApi.upsertTopic(db, { ...t, courseId: parsed.course.id, assessmentId });
  });

  const prior = (() => {
    try {
      return JSON.parse(dbApi.getMeta(db, "syllabusConflicts", "[]"));
    } catch (_e) {
      return [];
    }
  })();
  dbApi.setSyllabusConflicts(db, [...prior, ...conflicts]);

  if (isUpdate && typeof dbApi.recordSyllabusMapChange === "function") {
    dbApi.recordSyllabusMapChange(db, {
      courseId: parsed.course.id,
      sourceId,
      sourceKind: sourceMeta.sourceKind || "file",
      note: `re-parsed and re-reconciled ${parsed.course.name || parsed.course.id}`
    });
  }

  return {
    course: parsed.course,
    sourceId,
    changed: isUpdate,
    assessmentCount: dbApi.listAssessments(db, parsed.course.id).length,
    topicCount: dbApi.listTopics(db, parsed.course.id).length,
    conflicts,
    confirmDates
  };
}

module.exports = {
  normalizeTitle,
  titleSimilarity,
  findCalendarMatch,
  isAssessmentLike,
  isClassLike,
  seedFromGcalEvent,
  seedFromCanvasSignal,
  applySyllabusEnrichment,
  courseIdFromCalendar
};
