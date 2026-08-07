"use strict";

/**
 * Deterministic credit-card rewards optimizer.
 * Treats rate_pct as cash-equivalent (1% = $0.01 per dollar). Advisory only.
 */

const CARD_ACCOUNTS = new Set(["amex", "discover"]);

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function daysAgoIso(days, asOf = new Date()) {
  const d = new Date(asOf);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function inDateRange(date, start, end) {
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
}

function offerActiveOn(offer, asOfDate) {
  if (!offer.active) return false;
  return inDateRange(asOfDate, offer.startsOn, offer.endsOn);
}

function ruleActiveOn(rule, asOfDate) {
  return inDateRange(asOfDate, rule.validFrom, rule.validTo);
}

/**
 * Pick best earn rate for an account + transaction among rules and offers.
 * Returns { ratePct, capUsd, sourceId, kind: 'offer'|'rule' }
 */
function bestRateForAccount(accountId, tx, rules, offers, asOfDate, capUsed) {
  const category = tx.category || "uncategorized";
  const merchant = String(tx.merchant || tx.rawMerchant || "").toLowerCase();
  let best = null;

  offers
    .filter((o) => o.accountId === accountId && offerActiveOn(o, asOfDate))
    .forEach((offer) => {
      const catOk =
        !offer.category ||
        offer.category === category ||
        offer.category === "*";
      const merchOk =
        !offer.merchantContains ||
        merchant.includes(String(offer.merchantContains).toLowerCase());
      if (!catOk || !merchOk) return;
      const candidate = {
        ratePct: offer.ratePct,
        capUsd: null,
        sourceId: offer.id,
        kind: "offer",
        label: offer.title
      };
      if (!best || candidate.ratePct > best.ratePct) best = candidate;
    });

  const accountRules = rules
    .filter((r) => r.accountId === accountId && ruleActiveOn(r, asOfDate))
    .sort((a, b) => b.priority - a.priority);

  const specific = accountRules.find((r) => r.category === category);
  const fallback = accountRules.find((r) => r.category === "*");
  const rule = specific || fallback;
  if (rule) {
    const used = capUsed.get(rule.id) || 0;
    const remaining =
      rule.capUsd == null ? Infinity : Math.max(0, rule.capUsd - used);
    const candidate = {
      ratePct: rule.ratePct,
      capUsd: rule.capUsd,
      remainingCap: remaining === Infinity ? null : remaining,
      sourceId: rule.id,
      kind: "rule",
      label: `${accountId} ${rule.category}`
    };
    if (!best || candidate.ratePct > best.ratePct) best = candidate;
  }

  return best || { ratePct: 0, capUsd: null, sourceId: null, kind: "none", label: "none" };
}

function earnOnAmount(amount, rateInfo, capUsed) {
  let eligible = amount;
  if (rateInfo.kind === "rule" && rateInfo.capUsd != null) {
    const used = capUsed.get(rateInfo.sourceId) || 0;
    const remaining = Math.max(0, rateInfo.capUsd - used);
    eligible = Math.min(amount, remaining);
    capUsed.set(rateInfo.sourceId, used + eligible);
  }
  return roundMoney((eligible * rateInfo.ratePct) / 100);
}

function optimize(transactions, rules, offers, options = {}) {
  const asOfDate = options.asOfDate || new Date().toISOString().slice(0, 10);
  const windowDays = Number(options.windowDays) || 90;
  const since = daysAgoIso(windowDays, new Date(`${asOfDate}T12:00:00Z`));
  const cards = options.cards || ["amex", "discover"];

  const txs = (transactions || []).filter(
    (tx) =>
      tx.direction === "out" &&
      tx.date &&
      tx.date >= since &&
      tx.date <= asOfDate &&
      Number.isFinite(tx.amount)
  );

  const byCategory = new Map();
  const actualCapUsed = new Map();
  const bestCapUsed = new Map();

  txs.forEach((tx) => {
    const category = tx.category || "uncategorized";
    if (!byCategory.has(category)) {
      byCategory.set(category, {
        category,
        spend: 0,
        actualEarn: 0,
        bestEarn: 0,
        bestCard: null,
        missedUsd: 0,
        onCards: 0
      });
    }
    const row = byCategory.get(category);
    row.spend = roundMoney(row.spend + tx.amount);

    let actual = 0;
    if (CARD_ACCOUNTS.has(tx.account)) {
      row.onCards = roundMoney(row.onCards + tx.amount);
      const rate = bestRateForAccount(
        tx.account,
        tx,
        rules,
        offers,
        asOfDate,
        actualCapUsed
      );
      actual = earnOnAmount(tx.amount, rate, actualCapUsed);
    }
    row.actualEarn = roundMoney(row.actualEarn + actual);

    let bestEarn = 0;
    let bestCard = null;
    let winningProbe = null;
    cards.forEach((card) => {
      const probeCaps = new Map(bestCapUsed);
      const rate = bestRateForAccount(card, tx, rules, offers, asOfDate, probeCaps);
      const earned = earnOnAmount(tx.amount, { ...rate }, probeCaps);
      if (earned > bestEarn) {
        bestEarn = earned;
        bestCard = card;
        winningProbe = probeCaps;
      }
    });
    if (winningProbe) {
      winningProbe.forEach((value, key) => bestCapUsed.set(key, value));
    }
    row.bestEarn = roundMoney(row.bestEarn + bestEarn);
    if (bestCard) row.bestCard = bestCard;
  });

  const rows = [...byCategory.values()].map((row) => {
    row.missedUsd = roundMoney(Math.max(0, row.bestEarn - row.actualEarn));
    return row;
  });
  rows.sort((a, b) => b.missedUsd - a.missedUsd || b.spend - a.spend);

  const pointers = rows
    .filter((row) => row.missedUsd >= 1 && row.bestCard)
    .slice(0, 8)
    .map((row) => {
      const actualPct =
        row.spend > 0 ? roundMoney((row.actualEarn / row.spend) * 100) : 0;
      return {
        id: `pointer:${row.category}`,
        category: row.category,
        text:
          `${row.category}: $${row.spend.toFixed(2)} spent` +
          (row.onCards
            ? ` ($${row.onCards.toFixed(2)} on cards @ ~${actualPct}% effective)`
            : " (mostly not on Amex/Discover)") +
          ` → ${row.bestCard} looks better (~$${row.bestEarn.toFixed(2)} vs $${row.actualEarn.toFixed(2)}; ~$${row.missedUsd.toFixed(2)} left on table)`,
        missedUsd: row.missedUsd,
        bestCard: row.bestCard
      };
    });

  const activeOffers = (offers || []).filter((o) => offerActiveOn(o, asOfDate));

  const totals = rows.reduce(
    (acc, row) => {
      acc.spend += row.spend;
      acc.actualEarn += row.actualEarn;
      acc.bestEarn += row.bestEarn;
      acc.missedUsd += row.missedUsd;
      return acc;
    },
    { spend: 0, actualEarn: 0, bestEarn: 0, missedUsd: 0 }
  );
  Object.keys(totals).forEach((k) => {
    totals[k] = roundMoney(totals[k]);
  });

  return {
    kind: "rewards",
    asOfDate,
    since,
    windowDays,
    assumption: "rate_pct treated as cash-equivalent; advisory only",
    byCategory: rows,
    pointers,
    activeOffers,
    totals
  };
}

module.exports = {
  CARD_ACCOUNTS,
  optimize,
  bestRateForAccount,
  offerActiveOn,
  earnOnAmount,
  daysAgoIso
};
