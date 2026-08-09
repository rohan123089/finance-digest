"use strict";

/**
 * Watched folder for syllabus PDFs / text files.
 * Drop into data/syllabi/ (optionally per-course subfolders).
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const dbApi = require("../db.js");
const syllabus = require("../../engine/syllabus.js");

function projectDataRoot(options = {}) {
  return (
    options.dataRoot ||
    process.env.HUB_DATA_ROOT ||
    path.join(__dirname, "..", "..", "data")
  );
}

function syllabiRoot(options = {}) {
  return path.join(projectDataRoot(options), "syllabi");
}

function hashBuffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 24);
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".txt" || ext === ".md") {
    return fs.readFileSync(filePath, "utf8");
  }
  if (ext === ".pdf") {
    try {
      const pdfParse = require("pdf-parse");
      const buf = fs.readFileSync(filePath);
      const parsed = await pdfParse(buf);
      return parsed.text || "";
    } catch (error) {
      return "";
    }
  }
  return "";
}

function courseHintFromPath(filePath, root) {
  const rel = path.relative(root, filePath);
  const parts = rel.split(path.sep);
  if (parts.length > 1) return parts[0];
  return path.basename(filePath, path.extname(filePath));
}

async function syncToDb(db, options = {}) {
  const root = syllabiRoot(options);
  fs.mkdirSync(root, { recursive: true });
  const asOfDate =
    dbApi.getSettings(db).asOfDate || new Date().toISOString().slice(0, 10);
  const emitted = [];
  const files = [];

  function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((ent) => {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.(pdf|txt|md)$/i.test(ent.name)) files.push(full);
    });
  }
  walk(root);

  for (const filePath of files) {
    const buf = fs.readFileSync(filePath);
    const contentHash = hashBuffer(buf);
    const sourceId = `syllabus:file:${contentHash}`;
    const existing = dbApi
      .listSyllabusSources(db)
      .find((s) => s.id === sourceId || s.contentHash === contentHash);
    if (existing) continue;

    const text = await extractText(filePath);
    if (!text.trim()) continue;

    const hint = courseHintFromPath(filePath, root);
    const parsed = syllabus.parseSyllabusText(text, {
      courseName: hint,
      courseId: `course:${syllabus.slug(hint)}`,
      asOfDate,
      source: "syllabus"
    });
    const applied = dbApi.applySyllabusParse(db, parsed, {
      id: sourceId,
      sourceKind: "file",
      path: filePath,
      contentHash,
      rawRef: filePath
    });
    const conflicts = [
      ...dbApi.listNeedsALook(db).conflicts.filter((c) => c.kind !== "date-typo"),
      ...(parsed.conflicts || [])
    ];
    dbApi.setSyllabusConflicts(db, conflicts);
    emitted.push({
      file: filePath,
      courseId: applied.course?.id,
      assessments: applied.assessmentCount,
      topics: applied.topicCount
    });
  }

  return {
    source: "syllabus-files",
    mode: "local",
    emitted,
    root
  };
}

/**
 * Ingest syllabus text from email (body or decoded attachment text).
 */
function ingestSyllabusText(db, text, meta = {}) {
  const asOfDate =
    dbApi.getSettings(db).asOfDate || new Date().toISOString().slice(0, 10);
  const contentHash = hashBuffer(Buffer.from(String(text || ""), "utf8"));
  const sourceId = meta.sourceId || `syllabus:email:${contentHash}`;
  if (dbApi.listSyllabusSources(db).some((s) => s.id === sourceId)) {
    return { skipped: true, sourceId };
  }
  const parsed = syllabus.parseSyllabusText(text, {
    courseName: meta.courseName,
    courseId: meta.courseId,
    asOfDate,
    source: meta.source || "email"
  });
  const applied = dbApi.applySyllabusParse(db, parsed, {
    id: sourceId,
    sourceKind: "email",
    contentHash,
    rawRef: meta.rawRef || null,
    path: meta.path || null
  });
  const prior = dbApi.listNeedsALook(db).conflicts || [];
  dbApi.setSyllabusConflicts(db, [...prior, ...(parsed.conflicts || [])]);
  return { skipped: false, ...applied, sourceId };
}

module.exports = {
  syllabiRoot,
  syncToDb,
  ingestSyllabusText,
  extractText
};
