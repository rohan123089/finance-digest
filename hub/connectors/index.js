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
const groupme = require("./groupme.js");
const gcal = require("./gcal.js");
const syllabusFiles = require("./syllabus-files.js");
const outlook = require("./outlook.js");
const syllabus = require("../../engine/syllabus.js");

function lifeOptions(db, message, extra = {}) {
  const learnedHints = dbApi.resolveDigestLearned(db, message);
  return { ...extra, learnedHints };
}

async function runGroupMe(db, options = {}) {
  return groupme.syncToDb(db, {
    forceMock: options.forceMock === true,
    fetchImpl: options.fetchImpl,
    limit: options.limit
  });
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
    const chatMsg = {
      id: String(message.id),
      text: message.text || "",
      from: message.from || "sms",
      receivedAt: message.receivedAt || collectedAt,
      source: "sms",
      sourceRef: `sms:${message.id}`,
      url: message.url
    };
    const signals = life.extractFromChat(chatMsg, lifeOptions(db, chatMsg));
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
  let messages;
  let mode = "live";
  let accounts = [];

  if (forceMock) {
    mode = "mock";
    messages = mockLifeMessages();
  } else {
    const data = await Net.call("email", {
      maxResults: options.maxResults || 25,
      slot: options.slot,
      query: options.query
    });
    messages = Array.isArray(data.messages) ? data.messages : [];
    accounts = Array.isArray(data.accounts) ? data.accounts : [];
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
        accountSlot: link.accountSlot,
        mailbox: link.mailbox,
        source: "email"
      }));
    }
  }

  const emitted = [];
  const collectedAt = new Date().toISOString();
  const newestBySlot = new Map();

  function isTimeWatermark(value) {
    return /^\d{4}-\d{2}-\d{2}T/.test(String(value || ""));
  }

  messages.forEach((message) => {
    const slot = Number(message.accountSlot) || 1;
    const wmKey = `email:${slot}`;
    const watermark =
      dbApi.getConnectorWatermark(db, wmKey) ||
      (slot === 1 ? dbApi.getConnectorWatermark(db, "email") || "" : "");
    const receivedAt = message.receivedAt || collectedAt;
    // Prefer ISO receivedAt watermarks. Legacy lexical gmail-id watermarks were
    // not chronological and could silence an inbox after the first successful pull.
    if (isTimeWatermark(watermark) && receivedAt <= watermark) return;

    const text = `${message.subject || ""}\n${message.snippet || ""}`;
    const urls = text.match(/https?:\/\/[^\s<>"')]+/gi) || [];
    const firstUrl = message.url || (urls[0] ? urls[0].replace(/[.,;:]+$/, "") : null);

    const mailMsg = {
      ...message,
      source: "email",
      sourceRef: `email:${message.id}`,
      url: firstUrl || message.url
    };
    const signals = life.extractFromMessage(mailMsg, lifeOptions(db, mailMsg));
    if (!signals.length && firstUrl) {
      const hints = lifeOptions(db, mailMsg).learnedHints || {};
      if (!hints.mute && !hints.junkReading) {
        signals.push({
          id: `email:${message.id}`,
          type: "signal.link",
          source: "email",
          at: receivedAt,
          data: {
            url: firstUrl,
            title: message.subject || firstUrl,
            sharedBy: message.sharedBy || message.mailbox || "email",
            context: null,
            domain: hints.domain || life.inferDomain(text, message.from || ""),
            mailbox: message.mailbox || null
          }
        });
      }
    }
    signals.forEach((item) => {
      const row = { ...item, collectedAt };
      dbApi.upsertSyncItem(db, row);
      emitted.push(row);
    });

    const bodyText = message.body || message.snippet || "";
    if (syllabus.looksLikeSyllabusEmail(message.subject, bodyText)) {
      const attachmentText = Array.isArray(message.attachmentTexts)
        ? message.attachmentTexts.join("\n")
        : "";
      const syllabusText = [message.subject, bodyText, attachmentText]
        .filter(Boolean)
        .join("\n");
      try {
        syllabusFiles.ingestSyllabusText(db, syllabusText, {
          courseName: String(message.subject || "Course").slice(0, 80),
          sourceId: `syllabus:gmail:${message.id}`,
          source: "email",
          rawRef: `email:${message.id}`
        });
      } catch (_error) {
        // Syllabus parse failures must not block life signals.
      }
    }

    const prevNewest = newestBySlot.get(slot) || "";
    if (!prevNewest || receivedAt > prevNewest) {
      newestBySlot.set(slot, receivedAt);
    }
  });

  newestBySlot.forEach((at, slot) => {
    const wmKey = `email:${slot}`;
    const existing =
      dbApi.getConnectorWatermark(db, wmKey) ||
      (slot === 1 ? dbApi.getConnectorWatermark(db, "email") || "" : "");
    if (!isTimeWatermark(existing) || at > existing) {
      dbApi.setConnectorWatermark(db, wmKey, at);
      if (slot === 1) dbApi.setConnectorWatermark(db, "email", at);
    }
  });

  return { source: "email", mode, emitted, accounts };
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

async function runGcal(db, options = {}) {
  const forceMock = options.forceMock === true;
  try {
    return await gcal.syncToDb(db, {
      forceMock,
      fetchImpl: options.fetchImpl
    });
  } catch (error) {
    if (forceMock) throw error;
    return {
      source: "gcal",
      mode: "skipped",
      error: error.message || String(error),
      emitted: [],
      byAccount: {}
    };
  }
}

async function runSyllabusFiles(db, options = {}) {
  try {
    return await syllabusFiles.syncToDb(db, options);
  } catch (error) {
    if (options.forceMock === true) throw error;
    return {
      source: "syllabus-files",
      mode: "skipped",
      error: error.message || String(error),
      emitted: []
    };
  }
}

async function runOutlook(db, options = {}) {
  const forceMock = options.forceMock === true;
  try {
    return await outlook.syncToDb(db, {
      forceMock,
      fetchImpl: options.fetchImpl
    });
  } catch (error) {
    if (forceMock) throw error;
    return {
      source: "outlook",
      mode: "skipped",
      error: error.message || String(error),
      emitted: []
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

  const groupmeResult = await soft("groupme", () => runGroupMe(db, { forceMock }));
  const sms = await soft("sms", () => runSms(db, { forceMock }));
  const email = await soft("email", () => runEmail(db, { forceMock }));
  const bank = await soft("bank", () => runBank(db, { forceMock }));
  const gcalResult = await runGcal(db, { ...options, forceMock });
  const canvasResult = await runCanvas(db, { ...options, forceMock });
  const simplefinResult = await runSimpleFin(db, { ...options, forceMock });
  const rewards = await runRewards(db, { ...options, forceMock });
  const syllabusResult = await soft("syllabus-files", () =>
    runSyllabusFiles(db, options)
  );
  const outlookResult = await soft("outlook", () =>
    runOutlook(db, { ...options, forceMock })
  );
  return {
    groupme: groupmeResult,
    sms,
    email,
    bank,
    canvas: canvasResult,
    gcal: gcalResult,
    simplefin: simplefinResult,
    rewards,
    syllabusFiles: syllabusResult,
    outlook: outlookResult
  };
}

module.exports = {
  runGroupMe,
  runSms,
  runEmail,
  runBank,
  runCanvas,
  runGcal,
  runSimpleFin,
  runRewards,
  runSyllabusFiles,
  runOutlook,
  runAll
};
