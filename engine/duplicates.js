"use strict";

/**
 * Duplicate + internal-transfer helpers.
 * - Same statement uploaded twice → fingerprint / soft match skip
 * - Money out of A and into B → link as one transfer (don't count income+expense)
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MoneyDuplicates = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DAY_MS = 86400000;

  function normalizeMerchantKey(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[—–~\-*_|]+/g, " ")
      .replace(/\b\d{3,}[- ]?\d*\b/g, " ")
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function roundCents(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function fingerprint(accountId, date, amount, merchant) {
    return [
      String(accountId || ""),
      String(date || ""),
      String(roundCents(amount)),
      normalizeMerchantKey(merchant)
    ].join("|");
  }

  function parseDate(iso) {
    const t = Date.parse(`${iso}T12:00:00Z`);
    return Number.isNaN(t) ? null : t;
  }

  function daysBetween(a, b) {
    const da = parseDate(a);
    const db = parseDate(b);
    if (da == null || db == null) return Infinity;
    return Math.abs(da - db) / DAY_MS;
  }

  function looksLikeInternalMove(merchant) {
    const m = String(merchant || "").toLowerCase();
    return (
      /\btransfer\b/.test(m) ||
      /\bweb branch\b/.test(m) ||
      /\bmobile deposit\b/.test(m) ||
      /\be-?payment\b/.test(m) ||
      /\bach\s*pmt\b/.test(m) ||
      /\bach\s*payment\b/.test(m) ||
      (/\bpayment\b/.test(m) &&
        /\b(amex|american express|discover|vanguard)\b/.test(m)) ||
      /\b(autopay|online payment|card payment)\b/.test(m) ||
      (/\bzelle\b/.test(m) && /\b(uwcu|credit union|platinum)\b/.test(m))
    );
  }

  /** Card statement credit: payment received / thank you / autopay. */
  function looksLikeCardPaymentCredit(merchant) {
    const m = String(merchant || "").toLowerCase();
    return (
      /\b(payment\s+received|autopay|thank\s+you|online\s+payment|mobile\s+payment|ach\s*payment|ach\s*pmt)\b/.test(
        m
      ) || /\bpayment\b/.test(m)
    );
  }

  function inferTransferTarget(merchant, accountTypes) {
    const m = String(merchant || "").toLowerCase();
    const types = accountTypes || {};
    if (/\bsavings\b/.test(m) && types["uwcu-savings"]) return "uwcu-savings";
    if (/\bsavings\b/.test(m) && types.savings) return "savings";
    if (/\bchecking\b/.test(m) && types["uwcu-checking"]) return "uwcu-checking";
    if (/\bchecking\b/.test(m) && types.checking) return "checking";
    if (/\b(amex|american express)\b/.test(m) && types.amex) return "amex";
    if (/\bdiscover\b/.test(m) && types.discover) return "discover";
    if (/\bvanguard\b/.test(m) && types.vanguard) return "vanguard";
    return "";
  }

  /**
   * Cash-account merchants that are clearly paying a tracked card.
   */
  function inferCardPaymentTarget(merchant, accountTypes) {
    const target = inferTransferTarget(merchant, accountTypes);
    if (!target) return "";
    const type = accountTypes[target];
    if (type !== "liability") return "";
    if (!looksLikeInternalMove(merchant)) return "";
    return target;
  }

  /**
   * Find opposite-leg pairs: same amount, different accounts, within maxDays.
   * Prefers rows that look like internal moves.
   */
  function findTransferPairs(transactions, options = {}) {
    const maxDays = options.maxDays != null ? options.maxDays : 5;
    const accountTypes = options.accountTypes || {};
    const open = (transactions || []).filter(
      (tx) =>
        tx &&
        !tx.duplicateOf &&
        tx.direction &&
        tx.direction !== "transfer" &&
        Number.isFinite(tx.amount) &&
        tx.amount > 0
    );

    const outs = open.filter((tx) => tx.direction === "out");
    const inns = open.filter((tx) => tx.direction === "in");
    const used = new Set();
    const pairs = [];

    outs.forEach((out) => {
      if (used.has(out.id)) return;
      let best = null;
      let bestScore = -1;
      inns.forEach((inn) => {
        if (used.has(inn.id)) return;
        if (inn.account === out.account) return;
        if (roundCents(inn.amount) !== roundCents(out.amount)) return;
        const days = daysBetween(out.date, inn.date);
        if (days > maxDays) return;

        let score = 10 - days;
        if (looksLikeInternalMove(out.merchant) || looksLikeInternalMove(inn.merchant)) {
          score += 5;
        }
        const hinted =
          inferTransferTarget(out.merchant, accountTypes) === inn.account ||
          inferTransferTarget(inn.merchant, accountTypes) === out.account;
        if (hinted) score += 8;

        const outType = accountTypes[out.account] || out.accountType;
        const inType = accountTypes[inn.account] || inn.accountType;
        // Paying your own card: bank debit that names the card + card payment credit
        if (
          outType === "cash" &&
          inType === "liability" &&
          (looksLikeInternalMove(out.merchant) || hinted)
        ) {
          score += 10;
          if (looksLikeCardPaymentCredit(inn.merchant)) score += 3;
        } else if (
          outType === "cash" &&
          (inType === "cash" || inType === "liability" || inType === "investment")
        ) {
          score += 2;
        }
        if (score > bestScore) {
          bestScore = score;
          best = inn;
        }
      });
      // Require transfer-ish language or a hinted target — avoid linking two
      // unrelated same-dollar cash flows on the same day.
      if (best && bestScore >= 15) {
        used.add(out.id);
        used.add(best.id);
        pairs.push({
          sourceId: out.id,
          targetId: best.id,
          amount: out.amount,
          transferAccount: best.account,
          score: bestScore
        });
      }
    });

    // One side already typed as transfer (e.g. "Amex Payment" / "Transfer to Savings") —
    // hide the opposite statement leg so it isn't counted twice.
    const transfers = (transactions || []).filter(
      (tx) =>
        tx &&
        !tx.duplicateOf &&
        !used.has(tx.id) &&
        tx.direction === "transfer" &&
        tx.transferAccount &&
        Number.isFinite(tx.amount) &&
        tx.amount > 0
    );
    transfers.forEach((src) => {
      if (used.has(src.id)) return;
      let best = null;
      let bestScore = -1;
      open.forEach((leg) => {
        if (used.has(leg.id) || used.has(src.id)) return;
        if (leg.id === src.id) return;
        if (leg.account !== src.transferAccount) return;
        if (roundCents(leg.amount) !== roundCents(src.amount)) return;
        const days = daysBetween(src.date, leg.date);
        if (days > maxDays) return;
        let score = 12 - days;
        if (looksLikeInternalMove(leg.merchant) || looksLikeInternalMove(src.merchant)) {
          score += 5;
        }
        const legType = accountTypes[leg.account] || leg.accountType;
        if (legType === "liability" && looksLikeCardPaymentCredit(leg.merchant)) {
          score += 8;
        }
        if (score > bestScore) {
          bestScore = score;
          best = leg;
        }
      });
      if (best && bestScore >= 12) {
        used.add(src.id);
        used.add(best.id);
        pairs.push({
          sourceId: src.id,
          targetId: best.id,
          amount: src.amount,
          transferAccount: src.transferAccount,
          score: bestScore,
          sourceAlreadyTransfer: true
        });
      }
    });

    return pairs;
  }

  return {
    normalizeMerchantKey,
    fingerprint,
    findTransferPairs,
    inferTransferTarget,
    inferCardPaymentTarget,
    looksLikeInternalMove,
    looksLikeCardPaymentCredit,
    daysBetween,
    roundCents
  };
});
