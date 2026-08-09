"use strict";

/**
 * Outlook / Microsoft Graph mail connector for syllabus updates.
 * Mirrors Gmail syllabus watch: body + attachments → same parser.
 * Credentials: outlook.clientId, outlook.clientSecret, outlook.refreshToken (keychain).
 */

const secretStore = require("../secret-store.js");
const dbApi = require("../db.js");
const syllabus = require("../../engine/syllabus.js");
const syllabusFiles = require("./syllabus-files.js");

async function getStatus() {
  const refresh = Boolean(
    await secretStore.getConnectorSecret("outlook.refreshToken")
  );
  const clientId = Boolean(
    await secretStore.getConnectorSecret("outlook.clientId")
  );
  return {
    refresh,
    clientId,
    connected: refresh && clientId
  };
}

async function saveCredentials(payload = {}) {
  if (payload.clientId) {
    await secretStore.setConnectorSecret("outlook.clientId", payload.clientId);
  }
  if (payload.clientSecret) {
    await secretStore.setConnectorSecret(
      "outlook.clientSecret",
      payload.clientSecret
    );
  }
  if (payload.refreshToken) {
    await secretStore.setConnectorSecret(
      "outlook.refreshToken",
      payload.refreshToken
    );
  }
  return { ok: true };
}

async function disconnect() {
  for (const name of [
    "outlook.refreshToken",
    "outlook.clientId",
    "outlook.clientSecret",
    "outlook.accessToken"
  ]) {
    try {
      await secretStore.deleteConnectorSecret(name);
    } catch (_error) {
      // ignore
    }
  }
  return { ok: true };
}

async function graphFetch(pathname, options = {}) {
  const token =
    options.accessToken ||
    (await secretStore.getConnectorSecret("outlook.accessToken"));
  if (!token) throw new Error("Outlook access token missing");
  const fetchImpl = options.fetchImpl || fetch;
  const url = pathname.startsWith("http")
    ? pathname
    : `https://graph.microsoft.com/v1.0${pathname}`;
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Outlook Graph HTTP ${response.status}: ${text.slice(0, 180)}`);
  }
  return response.json();
}

/**
 * Mock or live sync. Live requires a valid Graph access token in keychain.
 */
async function syncToDb(db, options = {}) {
  const forceMock = options.forceMock === true;
  const emitted = [];
  let mode = "live";

  if (forceMock) {
    mode = "mock";
    const sample = `
CS 240 Fall 2026
Week 1: Intro to systems
- Pointers and memory — reading: Ch 1
- Processes — reading: Ch 2
Midterm exam Friday, Oct 10 (20%)
Week 8: Concurrency
- Locks and semaphores
Final exam Dec 12 (30%)
`;
    const result = syllabusFiles.ingestSyllabusText(db, sample, {
      courseName: "CS 240",
      sourceId: "syllabus:outlook:mock-cs240",
      source: "email",
      rawRef: "outlook:mock"
    });
    emitted.push(result);
    dbApi.setConnectorWatermark(db, "outlook", new Date().toISOString());
    return { source: "outlook", mode, emitted };
  }

  const status = await getStatus();
  if (!status.connected) {
    return {
      source: "outlook",
      mode: "skip",
      emitted: [],
      note: "Outlook not connected"
    };
  }

  try {
    const list = await graphFetch(
      "/me/messages?$top=25&$select=id,subject,bodyPreview,body,hasAttachments,receivedDateTime",
      options
    );
    const messages = list.value || [];
    for (const msg of messages) {
      const subject = msg.subject || "";
      const body = msg.body?.content || msg.bodyPreview || "";
      if (!syllabus.looksLikeSyllabusEmail(subject, body)) continue;
      const text = `${subject}\n${body.replace(/<[^>]+>/g, " ")}`;
      const result = syllabusFiles.ingestSyllabusText(db, text, {
        courseName: subject.slice(0, 80),
        sourceId: `syllabus:outlook:${msg.id}`,
        source: "email",
        rawRef: `outlook:${msg.id}`
      });
      emitted.push(result);
    }
    dbApi.setConnectorWatermark(db, "outlook", new Date().toISOString());
    return { source: "outlook", mode, emitted };
  } catch (error) {
    return {
      source: "outlook",
      mode: "error",
      emitted: [],
      error: String(error.message || error)
    };
  }
}

module.exports = {
  getStatus,
  saveCredentials,
  disconnect,
  syncToDb,
  graphFetch
};
