"use strict";

/**
 * Digest payload contract (phone viewer).
 * Spec fields live under glance.* + detail.needsALook (two-surface, flat data).
 */

const GLANCE_KEYS = Object.freeze([
  "clearDay",
  "heavyDay",
  "anchor",
  "examHorizon",
  "today",
  "backlog",
  "studyNext",
  "junk",
  "reading"
]);

const DETAIL_KEYS = Object.freeze([
  "today",
  "watching",
  "backlog",
  "reading",
  "junk",
  "examHorizon",
  "topics",
  "needsALook"
]);

function isInt(n) {
  return typeof n === "number" && Number.isInteger(n);
}

function validateExamRow(row, path, errors) {
  if (!row || typeof row !== "object") {
    errors.push(`${path} must be object`);
    return;
  }
  ["id", "name", "when"].forEach((k) => {
    if (typeof row[k] !== "string" || !row[k]) errors.push(`${path}.${k} string required`);
  });
  if (!isInt(row.done)) errors.push(`${path}.done must be integer`);
  if (!isInt(row.total)) errors.push(`${path}.total must be integer`);
  if (row.leadDays != null && !isInt(row.leadDays)) {
    errors.push(`${path}.leadDays must be integer when set`);
  }
}

function validateGlanceTodayRow(row, path, errors) {
  if (!row || typeof row !== "object") {
    errors.push(`${path} must be object`);
    return;
  }
  if (typeof row.id !== "string") errors.push(`${path}.id required`);
  if (typeof row.title !== "string") errors.push(`${path}.title required`);
  if (typeof row.kind !== "string") errors.push(`${path}.kind required`);
  if (row.protected !== true) errors.push(`${path}.protected must be true`);
}

/**
 * @returns {string[]} errors (empty = valid)
 */
function validateDigestContract(digest) {
  const errors = [];
  if (!digest || typeof digest !== "object") {
    return ["digest must be object"];
  }
  if (digest.v !== 1 && digest.v !== 0) errors.push("v must be 0 or 1");
  if (typeof digest.date !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(digest.date)) {
    errors.push("date YYYY-MM-DD required");
  }
  if (!digest.glance || typeof digest.glance !== "object") {
    errors.push("glance object required");
    return errors;
  }
  if (!digest.detail || typeof digest.detail !== "object") {
    errors.push("detail object required");
    return errors;
  }

  GLANCE_KEYS.forEach((k) => {
    if (!(k in digest.glance)) errors.push(`glance.${k} missing`);
  });
  DETAIL_KEYS.forEach((k) => {
    if (!(k in digest.detail)) errors.push(`detail.${k} missing`);
  });

  // Housekeeping must never sit on the morning glance.
  if ("needsALook" in digest.glance) {
    errors.push("needsALook must not appear on glance");
  }

  const g = digest.glance;
  if (typeof g.clearDay !== "boolean") errors.push("glance.clearDay boolean");
  if (typeof g.heavyDay !== "boolean") errors.push("glance.heavyDay boolean");
  if (typeof g.anchor !== "string" || !g.anchor) errors.push("glance.anchor non-empty string");

  if (!g.backlog || typeof g.backlog !== "object") {
    errors.push("glance.backlog object required");
  } else {
    if (!isInt(g.backlog.open)) errors.push("glance.backlog.open integer");
    if (!isInt(g.backlog.overdue)) errors.push("glance.backlog.overdue integer");
  }

  if (!g.junk || typeof g.junk !== "object") {
    errors.push("glance.junk object required");
  } else if (!isInt(g.junk.count)) {
    errors.push("glance.junk.count integer");
  }

  if (!Array.isArray(g.examHorizon)) errors.push("glance.examHorizon array");
  else g.examHorizon.forEach((row, i) => validateExamRow(row, `glance.examHorizon[${i}]`, errors));

  if (!Array.isArray(g.today)) errors.push("glance.today array");
  else g.today.forEach((row, i) => validateGlanceTodayRow(row, `glance.today[${i}]`, errors));

  if (!Array.isArray(g.reading)) errors.push("glance.reading array");
  else {
    g.reading.forEach((row, i) => {
      if (typeof row?.id !== "string" || typeof row?.title !== "string") {
        errors.push(`glance.reading[${i}] needs id+title`);
      }
    });
    if (g.heavyDay && g.reading.length > 0) {
      errors.push("glance.reading must be empty when heavyDay");
    }
  }

  if (g.studyNext != null) {
    const s = g.studyNext;
    if (typeof s.topic !== "string") errors.push("glance.studyNext.topic string");
    if (typeof s.courseId !== "string") errors.push("glance.studyNext.courseId string");
    if (!isInt(s.done)) errors.push("glance.studyNext.done integer");
    if (!isInt(s.total)) errors.push("glance.studyNext.total integer");
  }

  const n = digest.detail.needsALook;
  if (!n || typeof n !== "object") {
    errors.push("detail.needsALook object required");
  } else {
    ["conflicts", "confirmDates", "coverageGaps"].forEach((k) => {
      if (!Array.isArray(n[k])) errors.push(`detail.needsALook.${k} array`);
    });
  }

  ["today", "watching", "backlog", "reading", "junk", "examHorizon", "topics"].forEach(
    (k) => {
      if (!Array.isArray(digest.detail[k])) errors.push(`detail.${k} array`);
    }
  );

  return errors;
}

function assertDigestContract(digest) {
  const errors = validateDigestContract(digest);
  if (errors.length) {
    const msg = `Digest contract violation: ${errors.join("; ")}`;
    if (process.env.ASSERT_DIGEST_CONTRACT === "1") {
      throw new Error(msg);
    }
    return { ok: false, errors, message: msg };
  }
  return { ok: true, errors: [], message: "" };
}

module.exports = {
  GLANCE_KEYS,
  DETAIL_KEYS,
  validateDigestContract,
  assertDigestContract
};
