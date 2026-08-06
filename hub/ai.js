"use strict";

const crypto = require("node:crypto");
const dbApi = require("./db.js");
const secretStore = require("./secret-store.js");
const Net = require("./net.js");

const MODES = new Set(["OFF", "LOCAL", "CLOUD"]);

function getAiMode(db) {
  return String(dbApi.getMeta(db, "aiMode", "OFF")).toUpperCase();
}

function setAiMode(db, mode) {
  const normalized = String(mode || "OFF").toUpperCase();
  if (!MODES.has(normalized)) {
    throw new Error(`Invalid AI mode ${mode}; expected OFF|LOCAL|CLOUD`);
  }
  dbApi.setMeta(db, "aiMode", normalized);
  return normalized;
}

/**
 * Contract-shaped redacted snapshot only. No balances, expenses, merchants,
 * account ids, or raw transactions — this is the sole AI input.
 */
function snapshotForAi(db) {
  const full = dbApi.redactSnapshot(dbApi.computeLiveSnapshot(db));
  const redacted = {
    netWorth: full.netWorth,
    liquid: full.liquid,
    invested: full.invested,
    savingsRatePct: full.savingsRatePct,
    recurringMonthly: full.recurringMonthly,
    runwayMonths: full.runwayMonths,
    owed: full.owed,
    safeToSpend: {
      period: full.safeToSpend.period,
      amount: full.safeToSpend.amount,
      spent: full.safeToSpend.spent,
      remaining: full.safeToSpend.remaining
    },
    flags: []
  };
  assertSafeForAi(redacted);
  return redacted;
}

function assertSafeForAi(redacted) {
  const serialized = JSON.stringify(redacted);
  if ("transactions" in redacted) {
    throw new Error("Refusing AI call: redacted snapshot leaked transactions");
  }
  if ("balances" in redacted || "expenses" in redacted || "spendingByCategory" in redacted) {
    throw new Error("Refusing AI call: redacted snapshot leaked account detail");
  }
  if (/rawMerchant|accountNumber|token|password/i.test(serialized)) {
    throw new Error("Refusing AI call: redacted snapshot looks secret-bearing");
  }
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
      action: "Reimburse outside payments balance",
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
  assertSafeForAi(redacted);
  const apiKey = await secretStore.getConnectorSecret("ai.cloudKey");
  if (!apiKey) {
    const local = localHeuristics(redacted);
    return {
      ...local,
      summary: `CLOUD without key; local rules (${local.flags.length} nudges)`,
      mutations: []
    };
  }

  try {
    const completion = await Net.call("ai", { redacted });
    const content = completion?.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (_error) {
      throw new Error("CLOUD AI returned non-JSON content");
    }
    const flags = Array.isArray(parsed.flags) ? parsed.flags : [];
    return {
      summary: String(parsed.summary || `CLOUD model returned ${flags.length} nudge(s)`),
      flags,
      // Hard rule: discard any model-suggested mutations.
      mutations: []
    };
  } catch (error) {
    const local = localHeuristics(redacted);
    return {
      ...local,
      summary: `CLOUD failed (${error.message}); local rules (${local.flags.length} nudges)`,
      mutations: []
    };
  }
}

async function propose(db) {
  const mode = getAiMode(db);
  if (mode === "OFF") {
    return {
      mode,
      proposal: null,
      message: "AI is OFF",
      mutatesRecords: false
    };
  }

  const beforeTx = dbApi.listTransactions(db).length;
  const redacted = snapshotForAi(db);
  const body =
    mode === "CLOUD" ? await cloudHeuristics(redacted) : localHeuristics(redacted);

  if (!Array.isArray(body.mutations) || body.mutations.length !== 0) {
    throw new Error("Refusing AI proposal that includes mutations");
  }

  const proposal = {
    id: `ai-${crypto.randomBytes(4).toString("hex")}`,
    mode,
    promptSummary: "redacted-snapshot-only",
    body,
    createdAt: new Date().toISOString()
  };
  dbApi.saveAiProposal(db, proposal);

  const afterTx = dbApi.listTransactions(db).length;
  if (afterTx !== beforeTx) {
    throw new Error("AI propose mutated transaction rows");
  }

  return {
    mode,
    input: redacted,
    proposal: {
      id: proposal.id,
      createdAt: proposal.createdAt,
      ...body
    },
    mutatesRecords: false
  };
}

module.exports = {
  MODES,
  getAiMode,
  setAiMode,
  propose,
  localHeuristics,
  snapshotForAi,
  assertSafeForAi
};
