"use strict";

/**
 * GroupMe connector — pull group chat into Digest via life.extractFromChat.
 * Pairing: paste a personal access token from https://dev.groupme.com, then
 * pick a group (or paste group id). Secrets stay in the OS keychain.
 */

const secretStore = require("../secret-store.js");
const dbApi = require("../db.js");
const life = require("../../engine/life.js");

async function getStatus() {
  const token = Boolean(await secretStore.getConnectorSecret("groupme.token"));
  const groupId = (await secretStore.getConnectorSecret("groupme.groupId")) || "";
  return {
    token,
    groupId: groupId || null,
    connected: Boolean(token && groupId)
  };
}

async function saveCredentials(token, groupId) {
  const accessToken = String(token || "").trim();
  const gid = String(groupId || "").trim();
  if (!accessToken) throw new Error("GroupMe access token is required");
  if (!gid) throw new Error("GroupMe group id is required");
  await secretStore.setConnectorSecret("groupme.token", accessToken);
  await secretStore.setConnectorSecret("groupme.groupId", gid);
  return { ok: true, groupId: gid };
}

async function saveToken(token) {
  const accessToken = String(token || "").trim();
  if (!accessToken) throw new Error("GroupMe access token is required");
  await secretStore.setConnectorSecret("groupme.token", accessToken);
  return { ok: true };
}

async function saveGroupId(groupId) {
  const gid = String(groupId || "").trim();
  if (!gid) throw new Error("GroupMe group id is required");
  const token = await secretStore.getConnectorSecret("groupme.token");
  if (!token) throw new Error("Save an access token first");
  await secretStore.setConnectorSecret("groupme.groupId", gid);
  return { ok: true, groupId: gid };
}

async function disconnect() {
  for (const name of ["groupme.token", "groupme.groupId"]) {
    try {
      await secretStore.deleteConnectorSecret(name);
    } catch (_error) {
      // ignore
    }
  }
  return { ok: true };
}

async function groupmeFetch(path, options = {}) {
  const token =
    options.token || (await secretStore.getConnectorSecret("groupme.token"));
  if (!token) {
    throw new Error("GroupMe token is not configured in the OS keychain");
  }
  const fetchImpl = options.fetchImpl || fetch;
  const url = new URL(
    path.startsWith("http") ? path : `https://api.groupme.com/v3${path}`
  );
  if (options.query) {
    Object.entries(options.query).forEach(([key, value]) => {
      if (value != null) url.searchParams.set(key, String(value));
    });
  }
  const response = await fetchImpl(url, {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      "X-Access-Token": token,
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `GroupMe HTTP ${response.status}${text ? `: ${text.slice(0, 180)}` : ""}`
    );
  }
  return response.json();
}

async function listGroups(options = {}) {
  const payload = await groupmeFetch("/groups", {
    fetchImpl: options.fetchImpl,
    token: options.token,
    query: { per_page: 50 }
  });
  const groups = Array.isArray(payload?.response) ? payload.response : [];
  return groups.map((group) => ({
    id: String(group.id),
    name: group.name || String(group.id),
    members: Array.isArray(group.members) ? group.members.length : null,
    imageUrl: group.image_url || null
  }));
}

async function fetchMessages(options = {}) {
  const groupId =
    options.groupId || (await secretStore.getConnectorSecret("groupme.groupId"));
  if (!groupId) {
    throw new Error("GroupMe group id is not configured in the OS keychain");
  }
  const limit = Number(options.limit) || 20;
  return groupmeFetch(`/groups/${encodeURIComponent(groupId)}/messages`, {
    fetchImpl: options.fetchImpl,
    token: options.token,
    query: { limit }
  });
}

function messagesToSignals(messages, watermark) {
  const emitted = [];
  const collectedAt = new Date().toISOString();
  let lastId = watermark || "0";

  (messages || []).forEach((message) => {
    if (String(message.id) <= String(watermark) && watermark !== "0") return;
    const receivedAt = new Date(
      (message.created_at || Date.now() / 1000) * 1000
    ).toISOString();
    const signals = life.extractFromChat({
      id: String(message.id),
      text: message.text || "",
      from: message.name || "groupme",
      receivedAt,
      source: "groupme",
      sourceRef: `groupme:msg/${message.id}`
    });
    if (!signals.length && message.text) {
      signals.push({
        id: `gm:${message.id}`,
        type: "signal.event",
        source: "groupme",
        at: receivedAt,
        data: {
          title: String(message.text).slice(0, 120),
          start: receivedAt,
          domain: life.inferDomain(String(message.text), "groupme"),
          sourceRef: `groupme:msg/${message.id}`,
          dismissible: true
        }
      });
    }
    signals.forEach((item) => {
      emitted.push({ ...item, collectedAt });
    });
    lastId = String(message.id);
  });

  return { emitted, lastId, collectedAt };
}

async function syncToDb(db, options = {}) {
  const forceMock = options.forceMock === true;
  const watermark = dbApi.getConnectorWatermark(db, "groupme") || "0";
  let messages;
  let mode = "live";

  if (forceMock) {
    mode = "mock";
    messages = [
      {
        id: "998877",
        text: "Dinner Friday 7pm at Luigi's — who's in?",
        created_at: Math.floor(Date.now() / 1000),
        name: "Sam"
      },
      {
        id: "998878",
        text: "Study group tonight in the library for midterm",
        created_at: Math.floor(Date.now() / 1000) + 1,
        name: "Alex"
      }
    ];
  } else {
    const data = await fetchMessages({
      limit: options.limit || 20,
      fetchImpl: options.fetchImpl,
      groupId: options.groupId
    });
    messages = data?.response?.messages || [];
  }

  const { emitted, lastId } = messagesToSignals(messages, watermark);
  emitted.forEach((row) => {
    dbApi.upsertSyncItem(db, row);
  });
  if (lastId && lastId !== "0") {
    dbApi.setConnectorWatermark(db, "groupme", lastId);
  }

  return { source: "groupme", mode, emitted };
}

module.exports = {
  getStatus,
  saveCredentials,
  saveToken,
  saveGroupId,
  disconnect,
  groupmeFetch,
  listGroups,
  fetchMessages,
  messagesToSignals,
  syncToDb
};
