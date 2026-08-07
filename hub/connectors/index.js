"use strict";

/**
 * Hub-only connectors. Secrets live in the OS keychain and are used via Net.call.
 * HTML / Shelf never see tokens.
 *
 * Mock data is opt-in only (`forceMock: true`) for tests. Production paths
 * default to live-or-skip and must never write fake transactions into the DB.
 */

const dbApi = require("../db.js");
const Net = require("../net.js");
const life = require("../../engine/life.js");
const simplefin = require("./simplefin.js");
const rewardsWeb = require("./rewards-web.js");
const canvas = require("./canvas.js");

async function runGroupMe(db, options = {}) {
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
    const data = await Net.call("groupme", { limit: 20 });
    messages = data?.response?.messages || [];
    mode = "live";
  }

  const emitted = [];
  const collectedAt = new Date().toISOString();
  messages.forEach((message) => {
    if (String(message.id) <= String(watermark) && watermark !== "0") return;
    const receivedAt = new Date((message.created_at || Date.now() / 1000) * 1000).toISOString();
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
      const row = { ...item, collectedAt };
      if (row.id.startsWith("life:")) {
        // keep life ids; also alias gm: for watermark continuity in tests
      }
      dbApi.upsertSyncItem(db, row);
      emitted.push(row);
    });
    dbApi.setConnectorWatermark(db, "groupme", String(message.id));
  });

  return { source: "groupme", mode, emitted };
}

async function runSms(db, options = {}) {
  const forceMock = options.forceMock === true;
  const watermark = dbApi.getConnectorWatermark(db, "sms") || "";
  let messages;
  let mode = "live";

  if (forceMock) {
    mode = "mock";
    messages = [
      {
        id: "sms-5001",
        text: "Movie Saturday 8pm? Can dismiss if busy — just wanted you to know.",
        from: "Jordan",
        receivedAt: new Date().toISOString()
      },
      {
        id: "sms-5002",
        text: "Don't forget: rent due by Aug 1",
        from: "Landlord",
        receivedAt: new Date().toISOString()
      },
      {
        id: "sms-5003",
        text: "Check this out https://example.com/sms-piece",
        from: "Sam",
        receivedAt: new Date().toISOString()
      }
    ];
  } else if (typeof options.messages === "function") {
    messages = await options.messages();
    mode = "live";
  } else {
    // Live SMS arrives via phone Shelf outbox (signal.sms), not hub pull.
    return {
      source: "sms",
      mode: "device",
      emitted: [],
      note: "SMS is collected on Shelf and pushed in sync/up outbox"
    };
  }

  const emitted = [];
  const collectedAt = new Date().toISOString();
  messages.forEach((message) => {
    if (watermark && String(message.id) <= String(watermark)) return;
    const signals = life.extractFromChat({
      id: String(message.id),
      text: message.text || "",
      from: message.from || "sms",
      receivedAt: message.receivedAt || collectedAt,
      source: "sms",
      sourceRef: `sms:${message.id}`,
      url: message.url
    });
    signals.forEach((item) => {
      const row = { ...item, collectedAt };
      dbApi.upsertSyncItem(db, row);
      emitted.push(row);
    });
    dbApi.setConnectorWatermark(db, "sms", String(message.id));
  });

  return { source: "sms", mode, emitted };
}

function mockLifeMessages() {
  const now = new Date().toISOString();
  return [
    {
      id: "mail-1001",
      subject: "Weekend reading from Acme Digest",
      snippet: "Here's a piece we liked: https://example.com/piece",
      from: "newsletter@acme.example",
      sharedBy: "newsletter",
      url: "https://example.com/piece",
      receivedAt: now,
      source: "email"
    },
    {
      id: "mail-2002",
      subject: "CS 240 assignment 4",
      snippet: "Please submit Assignment 4 on Canvas. Due by 2026-08-12.",
      from: "prof@state.edu",
      receivedAt: now,
      source: "email"
    },
    {
      id: "mail-3003",
      subject: "Client kickoff meeting",
      snippet: "Teams meeting tomorrow at 10:00. Action required: review the brief.",
      from: "pm@work.example",
      receivedAt: now,
      source: "email"
    },
    {
      id: "mail-5005",
      subject: "Your UWCU e-Statement is ready",
      snippet:
        "Your University of Wisconsin Credit Union monthly statement is available. Download the PDF e-statement, then import into Money.",
      from: "estatements@uwcu.org",
      receivedAt: now,
      source: "email"
    }
  ];
}

async function runEmail(db, options = {}) {
  const forceMock = options.forceMock === true;
  const watermark = dbApi.getConnectorWatermark(db, "email") || "";
  let messages;
  let mode = "live";

  if (forceMock) {
    mode = "mock";
    messages = mockLifeMessages();
  } else {
    const data = await Net.call("email", { maxResults: 15 });
    messages = Array.isArray(data.messages) ? data.messages : [];
    // Back-compat: older Net.call shape returned links only.
    if (!messages.length && Array.isArray(data.links)) {
      messages = data.links.map((link) => ({
        id: link.id,
        subject: link.title || "",
        snippet: link.url || "",
        from: link.sharedBy || "email",
        sharedBy: link.sharedBy,
        url: link.url,
        receivedAt: link.receivedAt,
        source: "email"
      }));
    }
  }

  const emitted = [];
  const collectedAt = new Date().toISOString();
  messages.forEach((message) => {
    if (watermark && String(message.id) <= String(watermark)) return;
    const signals = life.extractFromMessage(
      { ...message, source: "email", sourceRef: `email:${message.id}` },
      {}
    );
    if (!signals.length && message.url) {
      signals.push({
        id: `email:${message.id}`,
        type: "signal.link",
        source: "email",
        at: message.receivedAt || collectedAt,
        data: {
          url: message.url,
          sharedBy: message.sharedBy || "email",
          context: null,
          domain: "personal"
        }
      });
    }
    signals.forEach((item) => {
      const row = { ...item, collectedAt };
      dbApi.upsertSyncItem(db, row);
      emitted.push(row);
    });
    dbApi.setConnectorWatermark(db, "email", String(message.id));
  });

  return { source: "email", mode, emitted };
}

async function runBank(db, options = {}) {
  const forceMock = options.forceMock === true;
  const watermark = dbApi.getConnectorWatermark(db, "bank") || "";
  let rows;
  let mode = "live";

  if (forceMock) {
    mode = "mock";
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
    const data = await Net.call("bank");
    rows = Array.isArray(data.transactions) ? data.transactions : [];
  }

  const emitted = [];
  rows.forEach((row) => {
    if (!row?.id || !row?.rawMerchant) return;
    if (watermark && String(row.id) <= String(watermark)) return;
    dbApi.insertRawTransaction(db, {
      id: String(row.id),
      date: row.date || new Date().toISOString().slice(0, 10),
      rawMerchant: row.rawMerchant,
      amount: Number(row.amount) || 0,
      account: row.account || "checking"
    });
    emitted.push(row);
    dbApi.setConnectorWatermark(db, "bank", String(row.id));
  });

  return { source: "bank", mode, emitted };
}

async function runSimpleFin(db, options = {}) {
  const forceMock = options.forceMock === true;
  try {
    return await simplefin.syncToDb(db, {
      forceMock,
      fetchImpl: options.fetchImpl,
      // Default on: opening balances track SimpleFIN so invested/cash aren't $0.
      updateOpeningBalance: options.updateOpeningBalance !== false
    });
  } catch (error) {
    if (forceMock) throw error;
    // Live SimpleFIN is optional until claimed; do not fail the whole connector run.
    return {
      source: "simplefin",
      mode: "skipped",
      error: error.message || String(error),
      remote: [],
      unmapped: [],
      emitted: [],
      inserted: 0
    };
  }
}

async function runRewards(db, options = {}) {
  const forceMock = options.forceMock === true;
  try {
    return await rewardsWeb.syncRewards(db, {
      forceMock,
      fetchImpl: options.fetchImpl
    });
  } catch (error) {
    if (forceMock) throw error;
    return {
      source: "rewards",
      mode: "skipped",
      error: error.message || String(error),
      amexStatus: "seed_only",
      upserted: 0,
      offers: []
    };
  }
}

async function runCanvas(db, options = {}) {
  const forceMock = options.forceMock === true;
  try {
    return await canvas.syncToDb(db, {
      forceMock,
      fetchImpl: options.fetchImpl
    });
  } catch (error) {
    if (forceMock) throw error;
    return {
      source: "canvas",
      mode: "skipped",
      error: error.message || String(error),
      emitted: [],
      counts: { todo: 0, upcoming: 0, missing: 0, signals: 0 }
    };
  }
}

async function runAll(db, options = {}) {
  const forceMock = options.forceMock === true;

  async function soft(name, fn) {
    try {
      return await fn();
    } catch (error) {
      if (forceMock) throw error;
      return {
        source: name,
        mode: "skipped",
        error: error.message || String(error),
        emitted: []
      };
    }
  }

  const groupme = await soft("groupme", () => runGroupMe(db, { forceMock }));
  const sms = await soft("sms", () => runSms(db, { forceMock }));
  const email = await soft("email", () => runEmail(db, { forceMock }));
  const bank = await soft("bank", () => runBank(db, { forceMock }));
  const canvasResult = await runCanvas(db, { ...options, forceMock });
  const simplefinResult = await runSimpleFin(db, { ...options, forceMock });
  const rewards = await runRewards(db, { ...options, forceMock });
  return {
    groupme,
    sms,
    email,
    bank,
    canvas: canvasResult,
    simplefin: simplefinResult,
    rewards
  };
}

module.exports = {
  runGroupMe,
  runSms,
  runEmail,
  runBank,
  runCanvas,
  runSimpleFin,
  runRewards,
  runAll
};
