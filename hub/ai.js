"use strict";

const crypto = require("node:crypto");
const dbApi = require("./db.js");

const MODES = new Set(["OFF", "LOCAL", "CLOUD"]);

function getAiMode(db) {
  return String(dbApi.getMeta(db, "aiMode", process.env.HUB_AI_MODE || "OFF")).toUpperCase();
}

function setAiMode(db, mode) {
  const normalized = String(mode || "OFF").toUpperCase();
  if (!MODES.has(normalized)) {
    throw new Error(`Invalid AI mode ${mode}; expected OFF|LOCAL|CLOUD`);
  }
  dbApi.setMeta(db, "aiMode", normalized);
  return normalized;
}

function localHeuristics(redacted) {
  const flags = [];
  if (redacted.safeToSpend.remaining < 0) {
    flags.push({
      id: "flag-safe-negative",
      trigger: "safeToSpend",
      why: "Weekly safe-to-spend is negative",
      action: "Pause variable spending until next paycheck",
      value: redacted.safeToSpend.remaining,
      deadline: null,
      confidence: 0.9
    });
  }
  if (redacted.owed > 0) {
    flags.push({
      id: "flag-owed",
      trigger: "owed",
      why: "External card balance is outstanding",
      action: "Reimburse parents'-card balance",
      value: redacted.owed,
      deadline: null,
      confidence: 0.85
    });
  }
  if (redacted.savingsRatePct < 20) {
    flags.push({
      id: "flag-savings",
      trigger: "savingsRate",
      why: "Savings rate under 20%",
      action: "Raise weekly savings target",
      value: redacted.savingsRatePct,
      deadline: null,
      confidence: 0.7
    });
  }
  return {
    summary: `Local rules produced ${flags.length} nudge(s)`,
    flags,
    mutations: []
  };
}

async function cloudHeuristics(redacted) {
  // Cloud path is gated and must never receive raw transactions.
  // Without an API key, fall back to the same deterministic local rules.
  if (!process.env.HUB_AI_CLOUD_KEY) {
    const local = localHeuristics(redacted);
    return {
      ...local,
      summary: `Cloud mode without key; used local rules (${local.flags.length} nudges)`
    };
  }
  // Placeholder for a future provider call that receives ONLY redacted.
  return localHeuristics(redacted);
}

async function propose(db) {
  const mode = getAiMode(db);
  if (mode === "OFF") {
    return {
      mode,
      proposal: null,
      message: "AI is OFF"
    };
  }

  const redacted = dbApi.redactSnapshot(dbApi.computeLiveSnapshot(db));
  // Hard guarantee: never attach raw transactions to the AI payload.
  if ("transactions" in redacted) {
    throw new Error("Refusing AI call: redacted snapshot leaked transactions");
  }

  const body =
    mode === "CLOUD" ? await cloudHeuristics(redacted) : localHeuristics(redacted);

  const proposal = {
    id: `ai-${crypto.randomBytes(4).toString("hex")}`,
    mode,
    promptSummary: "redacted-snapshot-only",
    body,
    createdAt: new Date().toISOString()
  };
  dbApi.saveAiProposal(db, proposal);

  return {
    mode,
    input: redacted,
    proposal: {
      id: proposal.id,
      createdAt: proposal.createdAt,
      ...body
    },
    // Explicit: AI never mutates records; user must commit separately.
    mutatesRecords: false
  };
}

module.exports = {
  MODES,
  getAiMode,
  setAiMode,
  propose,
  localHeuristics
};
