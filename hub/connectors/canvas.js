"use strict";

/**
 * Canvas LMS (Instructure) connector.
 * Students create a personal access token in Account → Settings → New Access Token.
 */

const secretStore = require("../secret-store.js");
const dbApi = require("../db.js");

function normalizeBaseUrl(raw) {
  let value = String(raw || "").trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  return value.replace(/\/+$/, "");
}

async function getStatus() {
  const token = Boolean(await secretStore.getConnectorSecret("canvas.token"));
  const baseUrl = (await secretStore.getConnectorSecret("canvas.baseUrl")) || "";
  return {
    token,
    baseUrl: baseUrl || null,
    connected: Boolean(token && baseUrl)
  };
}

async function saveCredentials(baseUrl, token) {
  const url = normalizeBaseUrl(baseUrl);
  const accessToken = String(token || "").trim();
  if (!url) throw new Error("Canvas base URL is required (e.g. https://canvas.wisc.edu)");
  if (!accessToken) throw new Error("Canvas access token is required");
  await secretStore.setConnectorSecret("canvas.baseUrl", url);
  await secretStore.setConnectorSecret("canvas.token", accessToken);
  return { ok: true, baseUrl: url };
}

async function disconnect() {
  for (const name of ["canvas.token", "canvas.baseUrl"]) {
    try {
      await secretStore.deleteConnectorSecret(name);
    } catch (_error) {
      // ignore
    }
  }
  return { ok: true };
}

async function canvasFetch(path, options = {}) {
  const baseUrl = normalizeBaseUrl(
    options.baseUrl || (await secretStore.getConnectorSecret("canvas.baseUrl"))
  );
  const token =
    options.token || (await secretStore.getConnectorSecret("canvas.token"));
  if (!baseUrl || !token) {
    throw new Error("Canvas baseUrl and token must be configured in the OS keychain");
  }
  const fetchImpl = options.fetchImpl || fetch;
  const url = new URL(path.startsWith("http") ? path : `${baseUrl}${path}`);
  if (options.query) {
    Object.entries(options.query).forEach(([key, value]) => {
      if (value != null) url.searchParams.set(key, String(value));
    });
  }
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Canvas HTTP ${response.status}${text ? `: ${text.slice(0, 180)}` : ""}`
    );
  }
  return response.json();
}

function courseLabel(item) {
  const code = item?.context_code || item?.assignment?.context_code || "";
  const match = String(code).match(/^course_(\d+)/i);
  if (match) return `Course ${match[1]}`;
  if (item?.assignment?.course_id) return `Course ${item.assignment.course_id}`;
  return "Canvas";
}

function todoToSignal(item) {
  const assignment = item?.assignment || item;
  const id =
    assignment?.id != null
      ? `canvas:todo:${assignment.id}`
      : `canvas:todo:${item?.course_id || "x"}:${String(item?.html_url || item?.url || Date.now())}`;
  const title = String(
    assignment?.name || item?.title || item?.assignment_name || "Canvas task"
  ).slice(0, 160);
  const dueAt =
    assignment?.due_at || item?.due_at || item?.end_at || item?.start_at || null;
  const htmlUrl = assignment?.html_url || item?.html_url || null;
  return {
    id,
    type: "signal.task",
    source: "canvas",
    at: dueAt || new Date().toISOString(),
    data: {
      title: htmlUrl ? `${title}` : title,
      dueAt,
      domain: "school",
      sourceRef: id,
      why: "canvas todo",
      url: htmlUrl,
      course: courseLabel(item),
      kind: "canvas.assignment"
    }
  };
}

function upcomingToSignal(item) {
  const isAssignment = Boolean(item?.assignment) || /^assignment_/i.test(String(item?.id || ""));
  if (isAssignment) {
    return todoToSignal(item);
  }
  const id = `canvas:event:${item?.id || item?.html_url || Date.now()}`;
  const start = item?.start_at || item?.end_at || null;
  return {
    id,
    type: "signal.event",
    source: "canvas",
    at: start || new Date().toISOString(),
    data: {
      title: String(item?.title || "Canvas event").slice(0, 160),
      start,
      domain: "school",
      sourceRef: id,
      url: item?.html_url || null,
      course: courseLabel(item),
      dismissible: true
    }
  };
}

function signalsFromPayload({ todo = [], upcoming = [], missing = [] }) {
  const byId = new Map();
  [...todo, ...missing].forEach((item) => {
    const signal = todoToSignal(item);
    byId.set(signal.id, signal);
  });
  upcoming.forEach((item) => {
    const signal = upcomingToSignal(item);
    if (!byId.has(signal.id)) byId.set(signal.id, signal);
  });
  return [...byId.values()];
}

async function syncToDb(db, options = {}) {
  const forceMock = options.forceMock === true;
  let mode = "live";
  let todo = [];
  let upcoming = [];
  let missing = [];

  if (forceMock) {
    mode = "mock";
    todo = [
      {
        assignment: {
          id: 9001,
          name: "CS 240 Assignment 4",
          due_at: "2026-08-12T23:59:00Z",
          html_url: "https://canvas.example.edu/courses/1/assignments/9001",
          course_id: 1
        },
        context_code: "course_1"
      }
    ];
    upcoming = [
      {
        id: "event_42",
        title: "Discussion section",
        start_at: "2026-08-08T15:00:00Z",
        html_url: "https://canvas.example.edu/calendar?event_id=42",
        context_code: "course_1"
      }
    ];
  } else {
    todo = await canvasFetch("/api/v1/users/self/todo", {
      fetchImpl: options.fetchImpl,
      query: { per_page: 50 }
    });
    upcoming = await canvasFetch("/api/v1/users/self/upcoming_events", {
      fetchImpl: options.fetchImpl,
      query: { per_page: 50 }
    });
    try {
      missing = await canvasFetch("/api/v1/users/self/missing_submissions", {
        fetchImpl: options.fetchImpl,
        query: { per_page: 25 }
      });
    } catch (_error) {
      missing = [];
    }
    if (!Array.isArray(todo)) todo = [];
    if (!Array.isArray(upcoming)) upcoming = [];
    if (!Array.isArray(missing)) missing = [];
  }

  const signals = signalsFromPayload({ todo, upcoming, missing });
  const collectedAt = new Date().toISOString();
  const emitted = [];
  signals.forEach((item) => {
    const row = { ...item, collectedAt };
    dbApi.upsertSyncItem(db, row);
    emitted.push(row);
  });
  dbApi.setConnectorWatermark(db, "canvas", collectedAt);
  return {
    source: "canvas",
    mode,
    emitted,
    counts: {
      todo: todo.length,
      upcoming: upcoming.length,
      missing: missing.length,
      signals: emitted.length
    }
  };
}

module.exports = {
  normalizeBaseUrl,
  getStatus,
  saveCredentials,
  disconnect,
  canvasFetch,
  todoToSignal,
  upcomingToSignal,
  signalsFromPayload,
  syncToDb
};
