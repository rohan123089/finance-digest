"use strict";

/**
 * GroupMe connector — pull group chat into Digest via life.extractFromChat.
 * Pairing: paste a personal access token from https://dev.groupme.com, then
 * pick one or more groups. Secrets stay in the OS keychain.
 */

const secretStore = require("../secret-store.js");
const dbApi = require("../db.js");
const life = require("../../engine/life.js");

function normalizeGroupIds(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((id) => String(id || "").trim()).filter(Boolean))];
  }
  if (value == null || value === "") return [];
  const raw = String(value).trim();
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      return normalizeGroupIds(JSON.parse(raw));
    } catch (_error) {
      // fall through
    }
  }
  return [
    ...new Set(
      raw
        .split(/[,;\s]+/)
        .map((id) => id.trim())
        .filter(Boolean)
    )
  ];
}

async function getGroupIds() {
  const multi = await secretStore.getConnectorSecret("groupme.groupIds");
  const ids = normalizeGroupIds(multi);
  if (ids.length) return ids;
  const legacy = await secretStore.getConnectorSecret("groupme.groupId");
  return normalizeGroupIds(legacy);
}

async function persistGroupIds(ids, meta) {
  const unique = normalizeGroupIds(ids);
  if (!unique.length) throw new Error("Select at least one GroupMe group");
  await secretStore.setConnectorSecret("groupme.groupIds", JSON.stringify(unique));
  // Keep legacy single-id key for older health checks / CLI docs.
  await secretStore.setConnectorSecret("groupme.groupId", unique[0]);
  if (meta != null) {
    const cleaned = (Array.isArray(meta) ? meta : [])
      .map((row) => ({
        id: String(row?.id || "").trim(),
        name: String(row?.name || "").trim().slice(0, 120)
      }))
      .filter((row) => row.id && unique.includes(row.id));
    if (cleaned.length) {
      await secretStore.setConnectorSecret(
        "groupme.groupMeta",
        JSON.stringify(cleaned)
      );
    }
  }
  // Verify keychain round-trip so silent write failures surface immediately.
  const verified = await getGroupIds();
  if (
    verified.length !== unique.length ||
    unique.some((id, index) => verified[index] !== id)
  ) {
    throw new Error("GroupMe group list did not persist to the keychain");
  }
  return unique;
}

async function getGroupMeta() {
  const raw = await secretStore.getConnectorSecret("groupme.groupMeta");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => ({
        id: String(row?.id || "").trim(),
        name: String(row?.name || "").trim()
      }))
      .filter((row) => row.id);
  } catch (_error) {
    return [];
  }
}

async function getStatus() {
  const token = Boolean(await secretStore.getConnectorSecret("groupme.token"));
  const groupIds = await getGroupIds();
  const groups = await getGroupMeta();
  const byId = new Map(groups.map((g) => [g.id, g.name]));
  return {
    token,
    groupId: groupIds[0] || null,
    groupIds,
    groups: groupIds.map((id) => ({
      id,
      name: byId.get(id) || id
    })),
    connected: Boolean(token && groupIds.length)
  };
}

async function saveCredentials(token, groupIds, meta) {
  const accessToken = String(token || "").trim();
  if (!accessToken) throw new Error("GroupMe access token is required");
  const ids = normalizeGroupIds(groupIds);
  if (!ids.length) throw new Error("Select at least one GroupMe group");
  await secretStore.setConnectorSecret("groupme.token", accessToken);
  const savedToken = await secretStore.getConnectorSecret("groupme.token");
  if (!savedToken) throw new Error("GroupMe token did not persist to the keychain");
  const saved = await persistGroupIds(ids, meta);
  return { ok: true, groupId: saved[0], groupIds: saved };
}

async function saveToken(token) {
  const accessToken = String(token || "").trim();
  if (!accessToken) throw new Error("GroupMe access token is required");
  await secretStore.setConnectorSecret("groupme.token", accessToken);
  const saved = await secretStore.getConnectorSecret("groupme.token");
  if (!saved) throw new Error("GroupMe token did not persist to the keychain");
  return { ok: true };
}

async function saveGroupId(groupId) {
  return saveGroupIds(groupId);
}

async function saveGroupIds(groupIds, meta) {
  const token = await secretStore.getConnectorSecret("groupme.token");
  if (!token) {
    throw new Error(
      "No access token in the keychain yet — paste your token in the box above and save again"
    );
  }
  const saved = await persistGroupIds(groupIds, meta);
  return { ok: true, groupId: saved[0], groupIds: saved };
}

async function disconnect() {
  for (const name of [
    "groupme.token",
    "groupme.groupId",
    "groupme.groupIds",
    "groupme.groupMeta"
  ]) {
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
  const groupId = options.groupId;
  if (!groupId) {
    throw new Error("GroupMe group id is required");
  }
  const limit = Number(options.limit) || 20;
  return groupmeFetch(`/groups/${encodeURIComponent(groupId)}/messages`, {
    fetchImpl: options.fetchImpl,
    token: options.token,
    query: { limit }
  });
}

function watermarkKey(groupId) {
  return groupId ? `groupme:${groupId}` : "groupme";
}

function messagesToSignals(messages, watermark, groupId, db) {
  const emitted = [];
  const collectedAt = new Date().toISOString();
  // GroupMe returns newest-first; high-water mark must be the MAX id seen.
  let lastId = watermark && watermark !== "0" ? String(watermark) : "0";
  const gid = groupId ? String(groupId) : "";
  const wm = watermark && watermark !== "0" ? String(watermark) : "";

  (messages || []).forEach((message) => {
    const mid = String(message.id || "");
    if (!mid) return;
    if (wm && mid <= wm) return;
    if (mid > lastId) lastId = mid;

    // System join/leave/pin/delete chatter never belongs in Digest.
    if (life.isGroupMeNoiseMessage(message)) return;

    const receivedAt = new Date(
      (message.created_at || Date.now() / 1000) * 1000
    ).toISOString();
    const sourceRef = gid
      ? `groupme:group/${gid}/msg/${message.id}`
      : `groupme:msg/${message.id}`;
    const chatMsg = {
      id: String(message.id),
      text: message.text || "",
      from: message.name || "groupme",
      receivedAt,
      source: "groupme",
      sourceRef,
      groupId: gid || undefined
    };
    const learnedHints = db
      ? dbApi.resolveDigestLearned(db, chatMsg)
      : { mute: false, junkReading: false, ruleIds: [] };
    const signals = life.extractFromChat(chatMsg, { learnedHints });
    // No "every text → event" fallback — unmatched chat stays out of Today.
    // Links/tasks/events only when life.extractFromChat finds real signal language.
    signals.forEach((item) => {
      const row = { ...item, collectedAt };
      if (gid && row.data && typeof row.data === "object") {
        row.data = { ...row.data, groupId: gid };
      }
      emitted.push(row);
    });
  });

  return { emitted, lastId, collectedAt };
}

function resolveWatermark(db, groupId) {
  const keyed = dbApi.getConnectorWatermark(db, watermarkKey(groupId));
  if (keyed) return keyed;
  // Legacy single-group installs used the bare "groupme" watermark.
  return dbApi.getConnectorWatermark(db, "groupme") || "0";
}

async function syncToDb(db, options = {}) {
  const forceMock = options.forceMock === true;
  let mode = "live";
  const emitted = [];
  const byGroup = {};

  if (forceMock) {
    mode = "mock";
    const watermark = dbApi.getConnectorWatermark(db, "groupme") || "0";
    const messages = [
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
    const mapped = messagesToSignals(messages, watermark, null, db);
    mapped.emitted.forEach((row) => {
      dbApi.upsertSyncItem(db, row);
      emitted.push(row);
    });
    if (mapped.lastId && mapped.lastId !== "0") {
      dbApi.setConnectorWatermark(db, "groupme", mapped.lastId);
    }
    byGroup.mock = mapped.emitted.length;
    return { source: "groupme", mode, emitted, groupIds: [], byGroup };
  }

  const groupIds = normalizeGroupIds(
    options.groupIds || options.groupId || (await getGroupIds())
  );
  if (!groupIds.length) {
    throw new Error("GroupMe group id is not configured in the OS keychain");
  }

  for (const groupId of groupIds) {
    const watermark = resolveWatermark(db, groupId);
    const data = await fetchMessages({
      limit: options.limit || 20,
      fetchImpl: options.fetchImpl,
      groupId
    });
    const messages = data?.response?.messages || [];
    const mapped = messagesToSignals(messages, watermark, groupId, db);
    mapped.emitted.forEach((row) => {
      dbApi.upsertSyncItem(db, row);
      emitted.push(row);
    });
    if (mapped.lastId && mapped.lastId !== "0") {
      dbApi.setConnectorWatermark(db, watermarkKey(groupId), mapped.lastId);
      // Keep legacy key in sync when only one group is configured.
      if (groupIds.length === 1) {
        dbApi.setConnectorWatermark(db, "groupme", mapped.lastId);
      }
    }
    byGroup[groupId] = mapped.emitted.length;
  }

  return { source: "groupme", mode, emitted, groupIds, byGroup };
}

module.exports = {
  normalizeGroupIds,
  getGroupIds,
  getStatus,
  saveCredentials,
  saveToken,
  saveGroupId,
  saveGroupIds,
  disconnect,
  groupmeFetch,
  listGroups,
  fetchMessages,
  messagesToSignals,
  syncToDb
};
