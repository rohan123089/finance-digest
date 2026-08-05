"use strict";

/**
 * Connectors run on the hub only. Secrets stay in env / hub process memory.
 * Without credentials they run in mock mode and still emit deterministic signals.
 */

const dbApi = require("../db.js");

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function runGroupMe(db, options = {}) {
  const token = options.token || process.env.GROUPME_TOKEN;
  const watermark = dbApi.getConnectorWatermark(db, "groupme") || "0";
  let messages;

  if (!token || options.forceMock) {
    messages = [
      {
        id: "998877",
        text: "Dinner Friday 7pm at Luigi's",
        created_at: Math.floor(Date.now() / 1000)
      }
    ];
  } else {
    const groupId = options.groupId || process.env.GROUPME_GROUP_ID;
    if (!groupId) throw new Error("GROUPME_GROUP_ID required when token is set");
    const data = await fetchJson(
      `https://api.groupme.com/v3/groups/${groupId}/messages?limit=20&token=${encodeURIComponent(token)}`
    );
    messages = data?.response?.messages || [];
  }

  const emitted = [];
  messages.forEach((message) => {
    if (String(message.id) <= String(watermark) && watermark !== "0") return;
    const item = {
      id: `gm:${message.id}`,
      type: "signal.event",
      source: "groupme",
      at: new Date((message.created_at || 0) * 1000).toISOString(),
      collectedAt: new Date().toISOString(),
      data: {
        title: String(message.text || "GroupMe event").slice(0, 120),
        start: new Date((message.created_at || Date.now() / 1000) * 1000).toISOString(),
        sourceRef: `groupme:msg/${message.id}`
      }
    };
    dbApi.upsertSyncItem(db, item);
    emitted.push(item);
    dbApi.setConnectorWatermark(db, "groupme", String(message.id));
  });

  return { source: "groupme", mode: token && !options.forceMock ? "live" : "mock", emitted };
}

async function runEmail(db, options = {}) {
  const clientId = options.clientId || process.env.EMAIL_OAUTH_CLIENT_ID;
  const watermark = dbApi.getConnectorWatermark(db, "email") || "";
  let links;

  if (!clientId || options.forceMock) {
    links = [
      {
        id: "mail-1001",
        url: "https://example.com/piece",
        sharedBy: "newsletter",
        receivedAt: new Date().toISOString()
      }
    ];
  } else {
    // Live OAuth path is scaffolded: token exchange remains hub-side only.
    throw new Error(
      "Live email OAuth is configured but not fully wired; use mock mode or complete token exchange"
    );
  }

  const emitted = [];
  links.forEach((link) => {
    if (watermark && link.id <= watermark) return;
    const item = {
      id: `sms:${link.id}`,
      type: "signal.link",
      source: "email",
      at: link.receivedAt,
      collectedAt: new Date().toISOString(),
      data: {
        url: link.url,
        sharedBy: link.sharedBy,
        context: null
      }
    };
    dbApi.upsertSyncItem(db, item);
    emitted.push(item);
    dbApi.setConnectorWatermark(db, "email", link.id);
  });

  return { source: "email", mode: clientId && !options.forceMock ? "live" : "mock", emitted };
}

async function runBank(db, options = {}) {
  const token = options.token || process.env.BANK_READONLY_TOKEN;
  const watermark = dbApi.getConnectorWatermark(db, "bank") || "";
  let rows;

  if (!token || options.forceMock) {
    rows = [
      {
        id: "bank-tx-9001",
        date: "2026-08-05",
        rawMerchant: "BOOKSHOP DOWNTOWN",
        amount: 22.5,
        account: "checking"
      }
    ];
  } else {
    throw new Error(
      "Live read-only bank path is configured but not fully wired; use mock mode"
    );
  }

  const emitted = [];
  rows.forEach((row) => {
    if (watermark && row.id <= watermark) return;
    dbApi.insertRawTransaction(db, row);
    emitted.push(row);
    dbApi.setConnectorWatermark(db, "bank", row.id);
  });

  return { source: "bank", mode: token && !options.forceMock ? "live" : "mock", emitted };
}

async function runAll(db, options = {}) {
  const groupme = await runGroupMe(db, options);
  const email = await runEmail(db, options);
  const bank = await runBank(db, options);
  return { groupme, email, bank };
}

module.exports = {
  runGroupMe,
  runEmail,
  runBank,
  runAll
};
