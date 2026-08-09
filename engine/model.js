(function (root, factory) {
  const budget =
    typeof module === "object" && module.exports
      ? require("./budget.js")
      : root.MoneyBudget;
  const api = factory(budget);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MoneyModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Budget) {
  "use strict";

  // Bump when snapshot math / recurring rules change so clients invalidate caches.
  const ENGINE_VERSION = 8;

  // Live hub snapshots must supply openings/types from the account registry.
  // Demo openings live only in tests / mock-shelf — never silently merge here.
  const DEFAULT_CONFIG = {
    asOfDate: null,
    weeklySavingsTarget: 300,
    checkingReserve: 1000,
    bills: [],
    openingBalances: {},
    accountTypes: {},
    accountLabels: {},
    accounts: [],
    incomeStreamOverrides: {},
    reportedBalances: {}
  };

  /** Offline/sample fixture only — not applied unless a caller passes it in. */
  const SAMPLE_FIXTURE = {
    asOfDate: "2026-08-05",
    openingBalances: {
      checking: 6200,
      savings: 12000,
      vanguard: 28000,
      amex: 0,
      discover: 0,
      "outside-payments": 0
    },
    accountTypes: {
      checking: "cash",
      savings: "cash",
      vanguard: "investment",
      amex: "liability",
      discover: "liability",
      "outside-payments": "external"
    }
  };

  const DAY_MS = 24 * 60 * 60 * 1000;
  const MONTH_NAMES =
    "january|february|march|april|may|june|july|august|september|october|november|december|" +
    "jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";

  function roundMoney(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  function parseDate(date) {
    return new Date(`${date}T12:00:00Z`);
  }

  function toDateString(date) {
    return date.toISOString().slice(0, 10);
  }

  function addDays(date, days) {
    return new Date(date.getTime() + days * DAY_MS);
  }

  function daysBetween(left, right) {
    return Math.round((parseDate(right) - parseDate(left)) / DAY_MS);
  }

  function merchantKey(merchant) {
    return String(merchant || "").trim().toLowerCase();
  }

  function streamKey(merchant, direction) {
    const raw = merchantKey(merchant);
    if (direction === "in") return raw;
    return raw
      // Strip bank/POS wrappers so "DEBITCARD … GOOGLE STORAGE" groups cleanly.
      .replace(/\b(debitcard|pos|purchase|withdrawal|ach|checkcard|visa|mastercard)\b/g, " ")
      .replace(/\b\d{4}\b/g, " ") // card last4 / store codes often 4 digits
      .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, " ") // embedded mm/dd/yy
      .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, " ") // times
      .replace(new RegExp(`\\b(${MONTH_NAMES})\\b`, "g"), " ")
      .replace(/\b(20)?\d{2}\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || raw;
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function amountsAreSimilar(left, right, slack = 0.03) {
    const floor = slack >= 0.1 ? 5 : 1;
    return Math.abs(left - right) <= Math.max(floor, Math.max(left, right) * slack);
  }

  function cadenceFromGaps(gaps) {
    if (!gaps.length) return null;
    const mid = median(gaps);
    if (mid >= 6 && mid <= 8) return { days: Math.round(mid), label: "weekly" };
    if (mid >= 13 && mid <= 16) return { days: Math.round(mid), label: "biweekly" };
    // Slightly wide monthly band — rent/ACH often posts a few days late.
    if (mid >= 26 && mid <= 38) return { days: Math.round(mid), label: "monthly" };
    if (mid >= 55 && mid <= 70) return { days: Math.round(mid), label: "bimonthly" };
    return null;
  }

  function gapsAreConsistent(gaps, cadence) {
    if (!cadence || !gaps.length) return false;
    // Allow a little drift: each gap must still classify as the same label.
    return gaps.every((gap) => cadenceFromGaps([gap])?.label === cadence.label);
  }

  function looksLikeBillMerchant(merchant) {
    const text = String(merchant || "").toLowerCase();
    return (
      /\bach\b/.test(text) ||
      /\b(comcast|xfinity|comed|utilities?|insurance|rent|lease|spotify|netflix|hulu|nyt|nytimes|openai|anthropic|chatgpt|cursor|subscription|membership|premium|versaille)\b/.test(
        text
      )
    );
  }

  const RECURRING_NOISE_CATEGORIES = new Set([
    "dining",
    "entertainment",
    "fees",
    "shopping",
    "groceries"
  ]);

  const BILL_CATEGORIES = new Set([
    "housing",
    "utilities",
    "subscriptions",
    "health",
    "income"
  ]);

  function looksLikeP2pMerchant(merchant) {
    return /\b(zelle|venmo|paypal|cash\s*app|cashapp)\b/i.test(String(merchant || ""));
  }

  function incomeFreshnessLimitDays(cadenceLabel, cadenceDays) {
    if (cadenceLabel === "weekly") return 21;
    if (cadenceLabel === "biweekly") return 45;
    if (cadenceLabel === "monthly") return 75;
    if (cadenceLabel === "bimonthly") return 120;
    const days = Number(cadenceDays) || 30;
    return Math.max(45, Math.round(days * 2.5));
  }

  function nextExpectedFromStream(stream, asOfDate) {
    const cadence = Number(stream.cadenceDays) || 0;
    if (!cadence || !stream.lastDate) return null;
    let cursor = parseDate(stream.lastDate);
    const asOf = parseDate(asOfDate);
    let guard = 0;
    while (cursor <= asOf && guard < 36) {
      cursor = addDays(cursor, cadence);
      guard += 1;
    }
    if (cursor <= asOf) return null;
    return toDateString(cursor);
  }

  function normalizeIncomeOverrides(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    Object.entries(raw).forEach(([key, value]) => {
      const normalizedKey = String(key || "")
        .trim()
        .toLowerCase();
      if (!normalizedKey) return;
      if (value == null) return;
      if (typeof value === "string") {
        out[normalizedKey] = { status: value };
        return;
      }
      if (value && typeof value === "object" && value.status) {
        out[normalizedKey] = { status: String(value.status) };
      }
    });
    return out;
  }

  /**
   * Income streams: same merchant + same day deposits are one event (so
   * $1500+$1900 Zelle counts as $3400), then cadence runs on day totals.
   */
  function detectIncomeStreams(transactions, options = {}) {
    const asOfDate = options.asOfDate || todayIso();
    const overrides = normalizeIncomeOverrides(options.incomeStreamOverrides);
    const groups = new Map();
    transactions
      .filter((tx) => tx.direction === "in" && Number.isFinite(tx.amount))
      .forEach((tx) => {
        const key = streamKey(tx.merchant, "in");
        if (!key || key.length < 4) return;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(tx);
      });

    const streams = [];
    groups.forEach((items, key) => {
      const dayMap = new Map();
      items.forEach((tx) => {
        const day = dayMap.get(tx.date) || {
          date: tx.date,
          amount: 0,
          txs: [],
          merchant: tx.merchant,
          category: tx.category || ""
        };
        day.amount = roundMoney(day.amount + tx.amount);
        day.txs.push(tx);
        if (tx.category) day.category = tx.category;
        dayMap.set(tx.date, day);
      });
      const days = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
      if (days.length < 2) return;

      const amountSlack = 0.15;
      const used = new Set();
      for (let seedIndex = 0; seedIndex < days.length; seedIndex += 1) {
        const seed = days[seedIndex];
        if (used.has(seed.date)) continue;
        const cluster = days.filter((day) =>
          amountsAreSimilar(day.amount, seed.amount, amountSlack)
        );
        if (cluster.length < 2) continue;

        const gaps = [];
        for (let index = 1; index < cluster.length; index += 1) {
          gaps.push(daysBetween(cluster[index - 1].date, cluster[index].date));
        }
        const labeled = gaps
          .map((gap) => ({ gap, label: cadenceFromGaps([gap])?.label || null }))
          .filter((row) => row.label);
        if (labeled.length < 1) continue;
        const labelCounts = labeled.reduce((map, row) => {
          map[row.label] = (map[row.label] || 0) + 1;
          return map;
        }, {});
        const dominantLabel = Object.entries(labelCounts).sort(
          (left, right) => right[1] - left[1]
        )[0][0];
        const dominantGaps = labeled
          .filter((row) => row.label === dominantLabel)
          .map((row) => row.gap);
        if (dominantGaps.length < Math.ceil(gaps.length * 0.5)) continue;
        const cadence = cadenceFromGaps(dominantGaps);
        if (!cadence || cadence.label !== dominantLabel) continue;
        if (!gapsAreConsistent(dominantGaps, cadence)) continue;

        cluster.forEach((day) => used.add(day.date));
        const last = cluster[cluster.length - 1];
        const amount = roundMoney(median(cluster.map((day) => day.amount)));
        const age = daysBetween(last.date, asOfDate);
        const freshLimit = incomeFreshnessLimitDays(cadence.label, cadence.days);
        const override = overrides[key];
        let status = "observed";
        let confidence = "medium";
        let active = true;
        if (override?.status === "ignored") {
          status = "ignored";
          confidence = "none";
          active = false;
        } else if (override?.status === "confirmed") {
          status = "confirmed";
          confidence = "high";
          active = age <= Math.max(freshLimit * 2, freshLimit + 60);
        } else if (age > freshLimit) {
          status = "stale";
          confidence = "low";
          active = false;
        } else if (looksLikeP2pMerchant(key) || looksLikeP2pMerchant(last.merchant)) {
          status = "observed";
          confidence = "medium";
          // P2P needs explicit confirm before it drives the cash horizon.
          active = true;
        }

        const nextExpected = nextExpectedFromStream(
          { lastDate: last.date, cadenceDays: cadence.days },
          asOfDate
        );
        streams.push({
          merchant: cluster[0].merchant,
          key,
          direction: "in",
          category: last.category || "",
          amount,
          cadenceDays: cadence.days,
          cadenceLabel: cadence.label,
          lastDate: last.date,
          occurrences: cluster.length,
          transactionIds: cluster.flatMap((day) => day.txs.map((tx) => tx.id)),
          status,
          confidence,
          active,
          nextExpected,
          projects: false,
          drivesHorizon: status === "confirmed" && Boolean(nextExpected)
        });
      }
    });

    const byKey = new Map();
    streams.forEach((stream) => {
      const prior = byKey.get(stream.key);
      if (
        !prior ||
        (stream.status === "confirmed" && prior.status !== "confirmed") ||
        (stream.status === prior.status &&
          (stream.occurrences > prior.occurrences ||
            (stream.occurrences === prior.occurrences &&
              stream.lastDate > prior.lastDate)))
      ) {
        byKey.set(stream.key, stream);
      }
    });
    return [...byKey.values()].sort((a, b) => b.amount - a.amount);
  }

  /**
   * Detect recurring income/expense streams.
   * Tuned to ignore coincidental cafe/POS visits from long bank CSV history:
   * cluster by similar amount, require consistent cadence, enough hits, and
   * preferably bill-like merchants (or a recent last charge).
   * Blank / uncategorized outs still group — monthly bill-sized streams qualify.
   */
  function detectRecurringStreams(transactions, direction, options = {}) {
    if (direction === "in") {
      return detectIncomeStreams(transactions, options);
    }
    const asOfDate = options.asOfDate || null;
    const maxAgeDays = Number.isFinite(options.maxAgeDays) ? options.maxAgeDays : 150;
    const groups = new Map();
    transactions
      .filter((tx) => tx.direction === direction && Number.isFinite(tx.amount))
      .forEach((tx) => {
        const key = streamKey(tx.merchant, direction);
        if (!key || key.length < 4) return;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(tx);
      });

    const streams = [];
    groups.forEach((items, key) => {
      const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date));
      const billLikeSeed =
        looksLikeBillMerchant(sorted[0].merchant) || looksLikeBillMerchant(key);
      const amountSlack = billLikeSeed ? 0.15 : 0.03;

      // Greedy amount clusters — pick peers of each seed amount.
      const used = new Set();
      for (let seedIndex = 0; seedIndex < sorted.length; seedIndex += 1) {
        const seed = sorted[seedIndex];
        if (used.has(seed.id)) continue;
        const cluster = sorted.filter((tx) =>
          amountsAreSimilar(tx.amount, seed.amount, amountSlack)
        );
        if (cluster.length < 2) continue;

        const gaps = [];
        for (let index = 1; index < cluster.length; index += 1) {
          gaps.push(daysBetween(cluster[index - 1].date, cluster[index].date));
        }
        // Keep only cadence-shaped consecutive gaps; drop holiday/skip outliers
        // by requiring a majority of gaps to share one cadence label.
        const labeled = gaps
          .map((gap) => ({ gap, label: cadenceFromGaps([gap])?.label || null }))
          .filter((row) => row.label);
        if (labeled.length < 1) continue;
        const labelCounts = labeled.reduce((map, row) => {
          map[row.label] = (map[row.label] || 0) + 1;
          return map;
        }, {});
        const dominantLabel = Object.entries(labelCounts).sort(
          (left, right) => right[1] - left[1]
        )[0][0];
        const dominantGaps = labeled
          .filter((row) => row.label === dominantLabel)
          .map((row) => row.gap);
        if (dominantGaps.length < (direction === "in" ? 1 : 1)) continue;
        // Need at least half of inter-arrival gaps to agree (rent can slip once).
        if (dominantGaps.length < Math.ceil(gaps.length * 0.5)) continue;

        const cadence = cadenceFromGaps(dominantGaps);
        if (!cadence || cadence.label !== dominantLabel) continue;
        if (!gapsAreConsistent(dominantGaps, cadence)) continue;

        const unique = cluster;
        unique.forEach((tx) => used.add(tx.id));
        const last = unique[unique.length - 1];
        const category = last.category || "";
        const amount = roundMoney(median(unique.map((item) => item.amount)));
        const monthlyCadence =
          cadence.label === "monthly" || cadence.label === "bimonthly";
        const uncategorizedBillSized =
          direction === "out" &&
          (!category || category === "uncategorized") &&
          monthlyCadence &&
          amount >= 40;
        const billLike =
          billLikeSeed ||
          BILL_CATEGORIES.has(category) ||
          uncategorizedBillSized;

        const noisy =
          direction === "out" &&
          !billLike &&
          RECURRING_NOISE_CATEGORIES.has(category || "uncategorized");

        const minHits = billLike
          ? monthlyCadence
            ? 2
            : 3
          : noisy
            ? 4
            : 3;

        if (unique.length < minHits) continue;

        // Bill-like streams may be slightly older; discretionary must be recent.
        if (asOfDate && direction === "out") {
          const age = daysBetween(last.date, asOfDate);
          const ageLimit = billLike ? Math.max(maxAgeDays, 180) : maxAgeDays;
          if (age > ageLimit) continue;
        }

        if (direction === "out" && amount < 5 && !billLike) continue;

        streams.push({
          merchant: unique[0].merchant,
          key,
          direction,
          category: category || "",
          amount,
          cadenceDays: cadence.days,
          cadenceLabel: cadence.label,
          lastDate: last.date,
          occurrences: unique.length,
          transactionIds: unique.map((item) => item.id)
        });
      }
    });

    // One stream per merchant key — keep the strongest recent cluster.
    const byKey = new Map();
    streams.forEach((stream) => {
      const prior = byKey.get(stream.key);
      if (
        !prior ||
        stream.occurrences > prior.occurrences ||
        (stream.occurrences === prior.occurrences && stream.lastDate > prior.lastDate)
      ) {
        byKey.set(stream.key, stream);
      }
    });
    return [...byKey.values()].sort((a, b) => b.amount - a.amount);
  }

  function detectRecurring(transactions, options = {}) {
    return detectRecurringStreams(transactions, "out", options).map((stream) => ({
      merchant: stream.merchant,
      key: stream.key,
      category: stream.category || "",
      amount: stream.amount,
      occurrences: stream.occurrences,
      transactionIds: stream.transactionIds,
      cadenceDays: stream.cadenceDays,
      cadenceLabel: stream.cadenceLabel,
      lastDate: stream.lastDate
    }));
  }

  function weekBounds(asOfDate) {
    const date = parseDate(asOfDate);
    const day = date.getUTCDay();
    const daysSinceMonday = day === 0 ? 6 : day - 1;
    const start = new Date(date.getTime() - daysSinceMonday * DAY_MS);
    const end = new Date(start.getTime() + 7 * DAY_MS);
    return { start, end };
  }

  function isInRange(date, start, end) {
    const value = parseDate(date);
    return value >= start && value < end;
  }

  /**
   * Pay period = last payday → next payday.
   * Falls back to the calendar week when income cadence is unknown.
   */
  function payPeriodBounds(incomeStreams, asOfDate) {
    const asOf = parseDate(asOfDate);
    const primary = incomeStreams[0];
    if (!primary) {
      const week = weekBounds(asOfDate);
      return {
        start: week.start,
        end: week.end,
        source: "calendar-week",
        nextPayday: toDateString(addDays(week.end, -1))
      };
    }

    let cursor = parseDate(primary.lastDate);
    const cadence = primary.cadenceDays;
    while (addDays(cursor, cadence) <= asOf) {
      cursor = addDays(cursor, cadence);
    }
    // cursor is the most recent payday on or before asOf (or last observed if
    // lastDate is still ahead — clamp to lastDate when asOf is before it).
    if (cursor > asOf) {
      cursor = parseDate(primary.lastDate);
      while (cursor > asOf && cadence > 0) {
        cursor = addDays(cursor, -cadence);
      }
    }
    const end = addDays(cursor, cadence);
    return {
      start: cursor,
      end,
      source: "income-cadence",
      nextPayday: toDateString(end)
    };
  }

  /**
   * Project stream due dates that fall in [start, end).
   * Walks backward/forward from lastDate so overlapping cycles are included
   * even when the last charge was just before the pay period started.
   */
  function occurrencesInPeriod(stream, start, end) {
    const cadence = stream.cadenceDays;
    if (!cadence) return [];
    let cursor = parseDate(stream.lastDate);
    while (cursor > start) cursor = addDays(cursor, -cadence);
    while (cursor < start) cursor = addDays(cursor, cadence);

    const dates = [];
    while (cursor < end) {
      dates.push(toDateString(cursor));
      cursor = addDays(cursor, cadence);
    }
    return dates;
  }

  function billDueDatesInPeriod(bills, start, end) {
    const list = Array.isArray(bills) ? bills : [];
    const dues = [];
    list.forEach((bill) => {
      if (!bill || bill.active === false) return;
      const amount = Number(bill.amount) || 0;
      if (amount <= 0) return;
      const dueDay = Math.max(1, Math.min(31, Number(bill.dueDay) || 1));

      let year = start.getUTCFullYear();
      let month = start.getUTCMonth();
      // Cover the months that the period can touch.
      for (let offset = -1; offset <= 2; offset += 1) {
        let m = month + offset;
        let y = year;
        while (m < 0) {
          m += 12;
          y -= 1;
        }
        while (m > 11) {
          m -= 12;
          y += 1;
        }
        const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        const day = Math.min(dueDay, last);
        const due = new Date(Date.UTC(y, m, day, 12, 0, 0));
        const periodKey = `${y}-${String(m + 1).padStart(2, "0")}`;
        if (bill.lastPaidFor === periodKey) continue;
        if (due >= start && due < end) {
          dues.push({
            title: bill.title,
            amount: roundMoney(amount),
            date: toDateString(due),
            source: "bill"
          });
        }
      }
    });
    return dues;
  }

  function accountDeltaForActivity(accountType, direction, amount) {
    if (accountType === "cash" || accountType === "investment") {
      return direction === "in" ? amount : -amount;
    }
    if (accountType === "liability" || accountType === "external") {
      return direction === "out" ? amount : -amount;
    }
    return 0;
  }

  function isCashLikeHolding(holding) {
    const symbol = String(holding?.symbol || "").trim().toUpperCase();
    const description = String(holding?.description || "").toLowerCase();
    if (!symbol && !description) return false;
    if (
      symbol === "VMFXX" ||
      symbol === "USD" ||
      symbol === "CASH" ||
      symbol === "SPAXX" ||
      symbol === "FDRXX"
    ) {
      return true;
    }
    return /money\s*market|settlement\s*fund|sweep|cash\s*reserves|\bcash\b/.test(
      description
    );
  }

  function normalizeHoldings(rawHoldings) {
    if (!Array.isArray(rawHoldings)) return [];
    return rawHoldings
      .map((holding) => ({
        id: holding.id || null,
        symbol: String(holding.symbol || "").trim(),
        description: String(holding.description || "").trim(),
        marketValue: roundMoney(Number(holding.market_value ?? holding.marketValue) || 0),
        shares: Number(holding.shares) || 0,
        currency: holding.currency || "USD"
      }))
      .filter((holding) => holding.marketValue !== 0 || holding.shares !== 0);
  }

  /**
   * Split an account balance into cash-like vs invested using SimpleFIN holdings.
   * Scales to the live account balance when holdings sum drifts slightly.
   */
  function splitBalanceByHoldings(balance, holdings) {
    const list = normalizeHoldings(holdings);
    if (!list.length) {
      return { cash: 0, invested: roundMoney(balance), holdings: [] };
    }
    let cash = 0;
    let invested = 0;
    const classified = list.map((holding) => {
      const cashLike = isCashLikeHolding(holding);
      if (cashLike) cash += holding.marketValue;
      else invested += holding.marketValue;
      return { ...holding, cashLike };
    });
    const sum = cash + invested;
    if (sum > 0 && Number.isFinite(balance) && Math.abs(sum - balance) > 0.05) {
      const scale = balance / sum;
      cash = roundMoney(cash * scale);
      invested = roundMoney(balance - cash);
    } else {
      cash = roundMoney(cash);
      invested = roundMoney(invested);
    }
    return { cash, invested, holdings: classified };
  }

  function allocateAccountTotals(accountId, balance, type, holdingsByAccount) {
    const holdings = holdingsByAccount?.[accountId];
    if (
      (type === "investment" || type === "cash") &&
      Array.isArray(holdings) &&
      holdings.length
    ) {
      const split = splitBalanceByHoldings(balance, holdings);
      return {
        liquid: split.cash,
        invested: split.invested,
        liabilities: 0,
        owed: 0,
        split
      };
    }
    // Credit-card ledger can go negative when bank payment transfers are
    // double-counted; don't let that inflate net worth. External "owed"
    // reimbursements may legitimately go negative after repayments.
    const rawLiability =
      type === "liability" || type === "external" ? Number(balance) || 0 : 0;
    const liabilities =
      type === "liability" ? Math.max(0, rawLiability) : rawLiability;
    return {
      liquid: type === "cash" ? balance : 0,
      invested: type === "investment" ? balance : 0,
      liabilities,
      owed: type === "external" ? rawLiability : 0,
      split: null
    };
  }

  function sourceTransferDelta(accountType, amount) {
    return accountType === "liability" || accountType === "external" ? amount : -amount;
  }

  function targetTransferDelta(accountType, amount) {
    return accountType === "liability" || accountType === "external" ? -amount : amount;
  }

  function amountToWeekly(amount, cadenceLabel, cadenceDays) {
    const value = Number(amount) || 0;
    if (!value) return 0;
    if (cadenceLabel === "weekly" || cadenceDays === 7) return value;
    if (
      cadenceLabel === "biweekly" ||
      (cadenceDays >= 12 && cadenceDays <= 16)
    ) {
      return value * (7 / 14);
    }
    if (cadenceLabel === "bimonthly") return value * (7 / 60.875);
    const days =
      Number(cadenceDays) > 16 ? Number(cadenceDays) : 30.4375;
    return value * (7 / days);
  }

  function pickCheckingAccountId(config) {
    const types = config.accountTypes || {};
    const labels = config.accountLabels || {};
    const cashIds = Object.keys(types).filter((id) => types[id] === "cash");
    if (!cashIds.length) return null;
    const byName = cashIds.find((id) => {
      const label = String(labels[id] || "");
      return /check/i.test(id) || /check/i.test(label);
    });
    if (byName) return byName;
    const nonSavings = cashIds.filter((id) => {
      const label = String(labels[id] || "");
      return !/sav|money\s*market|\bmm\b|vanguard/i.test(id) &&
        !/sav|money\s*market|\bmm\b/i.test(label);
    });
    return nonSavings[0] || cashIds[0];
  }

  function pickSavingsAccountIds(config) {
    const types = config.accountTypes || {};
    const labels = config.accountLabels || {};
    return Object.keys(types).filter((id) => {
      if (types[id] !== "cash") return false;
      const label = String(labels[id] || "");
      return /sav/i.test(id) || /sav/i.test(label);
    });
  }

  function obligationAlreadyPaid(transactions, title, amount, dueDate, asOfDate) {
    const due = parseDate(dueDate);
    const windowStart = addDays(due, -10);
    const windowEnd = addDays(due, 5);
    const asOf = parseDate(asOfDate);
    const end = windowEnd < asOf ? windowEnd : addDays(asOf, 1);
    const needle = streamKey(title, "out");
    return transactions.some((tx) => {
      if (tx.direction !== "out" || tx.duplicateOf) return false;
      if (!Number.isFinite(tx.amount)) return false;
      const at = parseDate(tx.date);
      if (at < windowStart || at >= end) return false;
      if (!amountsAreSimilar(tx.amount, amount, 0.1)) return false;
      const key = streamKey(tx.merchant, "out");
      if (!needle) return true;
      if (key.includes(needle) || needle.includes(key)) return true;
      // Rent / housing title vs Versailles ACH etc.
      if (/\brent\b/.test(needle) && /versailles|oakbr|housing|\brent\b/.test(key)) {
        return true;
      }
      return false;
    });
  }

  function savingsTransferredInRange(transactions, config, start, end) {
    const checkingId = pickCheckingAccountId(config);
    const savingsIds = new Set(pickSavingsAccountIds(config));
    if (!checkingId || !savingsIds.size) return 0;
    return transactions
      .filter((tx) => {
        if (tx.duplicateOf) return false;
        if (!isInRange(tx.date, start, end)) return false;
        if (tx.direction === "transfer") {
          const target = tx.transferAccount || tx.suggestedTransferAccount;
          return tx.account === checkingId && savingsIds.has(target);
        }
        // Some imports label savings moves as out + category.
        if (
          tx.direction === "out" &&
          tx.account === checkingId &&
          /transfer to savings|savings transfer/i.test(tx.merchant || "")
        ) {
          return true;
        }
        return false;
      })
      .reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);
  }

  function cardObligationsThrough(config, horizonEndIso, asOfDate) {
    const accounts = Array.isArray(config.accounts) ? config.accounts : [];
    const asOf = asOfDate || config.asOfDate;
    return accounts
      .filter(
        (account) =>
          account &&
          account.type === "liability" &&
          account.id !== "outside-payments"
      )
      .map((account) => {
        const dueDay = Number(account.dueDay) || 27;
        let nextDue = dateWithDay(asOf, dueDay, 0);
        if (nextDue <= parseDate(asOf)) {
          nextDue = dateWithDay(asOf, dueDay, 1);
        }
        const nextDueIso = toDateString(nextDue);
        if (nextDueIso > horizonEndIso) return null;
        const balance =
          account.reportedBalance != null
            ? Number(account.reportedBalance)
            : Number(config.reportedBalances?.[account.id]);
        const amount = Number.isFinite(balance) ? Math.max(0, balance) : 0;
        if (amount <= 0) return null;
        return {
          title: `${account.label || account.id} card payment`,
          amount: roundMoney(amount),
          date: nextDueIso,
          source: "card",
          cadenceLabel: "once",
          fullAmount: roundMoney(amount)
        };
      })
      .filter(Boolean);
  }

  function computeSafeToSpend(effectiveTransactions, config, balances, balanceSources) {
    const overrides = normalizeIncomeOverrides(config.incomeStreamOverrides);
    const incomeStreams = detectRecurringStreams(effectiveTransactions, "in", {
      asOfDate: config.asOfDate,
      incomeStreamOverrides: overrides
    });
    const expenseStreams = detectRecurringStreams(effectiveTransactions, "out", {
      asOfDate: config.asOfDate,
      maxAgeDays: 120
    });

    const week = weekBounds(config.asOfDate);
    const asOf = parseDate(config.asOfDate);
    const periodStart = week.start;
    const periodEnd = week.end;

    const confirmed = incomeStreams.filter((stream) => stream.drivesHorizon);
    const activeExpected = incomeStreams.filter(
      (stream) =>
        stream.active &&
        (stream.status === "confirmed" || stream.status === "observed")
    );
    const nextPayday =
      confirmed
        .map((stream) => stream.nextExpected)
        .filter(Boolean)
        .sort()[0] || null;

    let horizonEnd;
    let horizonSource;
    if (nextPayday) {
      horizonEnd = parseDate(nextPayday);
      horizonSource = "confirmed-income";
    } else {
      horizonEnd = addDays(asOf, 28);
      horizonSource = "default-4-weeks";
    }
    const horizonEndIso = toDateString(horizonEnd);
    const allocationDays = Math.max(1, daysBetween(config.asOfDate, horizonEndIso));
    const allocationWeeks = Math.max(1, roundMoney(allocationDays / 7));

    const checkingAccountId = pickCheckingAccountId(config);
    const checkingBalance = checkingAccountId
      ? Number(balances?.[checkingAccountId]) || 0
      : 0;
    const balanceSource = checkingAccountId
      ? balanceSources?.[checkingAccountId] || "ledger"
      : "none";
    const reserve = Math.max(0, Number(config.checkingReserve) || 0);
    const availableAfterReserve = roundMoney(checkingBalance - reserve);

    const commitmentRows = [];
    // Recurring expense occurrences unpaid through the cash horizon.
    expenseStreams.forEach((stream) => {
      occurrencesInPeriod(stream, addDays(asOf, 1), addDays(horizonEnd, 1)).forEach(
        (date) => {
          if (
            obligationAlreadyPaid(
              effectiveTransactions,
              stream.merchant,
              stream.amount,
              date,
              config.asOfDate
            )
          ) {
            return;
          }
          commitmentRows.push({
            title: stream.merchant,
            amount: stream.amount,
            date,
            source: "recurring",
            cadenceLabel: stream.cadenceLabel || "monthly",
            fullAmount: stream.amount
          });
        }
      );
    });

    billDueDatesInPeriod(
      config.bills,
      addDays(asOf, 1),
      addDays(horizonEnd, 1)
    ).forEach((due) => {
      const duplicate = commitmentRows.some((row) => {
        if (amountsAreSimilar(row.amount, due.amount, 0.1)) return true;
        const billTitle = String(due.title || "").toLowerCase();
        const streamTitle = String(row.title || "").toLowerCase();
        if (
          /\brent\b/.test(billTitle) &&
          (/versailles|oakbr|\brent\b|housing/.test(streamTitle) ||
            amountsAreSimilar(row.amount, due.amount, 0.15))
        ) {
          return true;
        }
        return false;
      });
      if (duplicate) return;
      if (
        obligationAlreadyPaid(
          effectiveTransactions,
          due.title,
          due.amount,
          due.date,
          config.asOfDate
        )
      ) {
        return;
      }
      commitmentRows.push({
        title: due.title,
        amount: due.amount,
        date: due.date,
        source: "bill",
        cadenceLabel: "monthly",
        fullAmount: due.amount
      });
    });

    cardObligationsThrough(config, horizonEndIso, config.asOfDate).forEach((row) => {
      const duplicate = commitmentRows.some(
        (existing) =>
          existing.source === "card" &&
          existing.title === row.title &&
          amountsAreSimilar(existing.amount, row.amount, 0.05)
      );
      if (!duplicate) commitmentRows.push(row);
    });

    const dueThisWeek = [];
    expenseStreams.forEach((stream) => {
      occurrencesInPeriod(stream, periodStart, periodEnd).forEach((date) => {
        dueThisWeek.push({
          title: stream.merchant,
          amount: stream.amount,
          date,
          source: "due-this-week"
        });
      });
    });
    billDueDatesInPeriod(config.bills, periodStart, periodEnd).forEach((due) => {
      const duplicate = dueThisWeek.some(
        (row) =>
          amountsAreSimilar(row.amount, due.amount) &&
          Math.abs(daysBetween(row.date, due.date)) <= 3
      );
      if (!duplicate) {
        dueThisWeek.push({ ...due, source: "due-this-week" });
      }
    });

    const unpaidObligations = commitmentRows.reduce(
      (sum, row) => sum + row.amount,
      0
    );
    const recurringKeys = new Set(expenseStreams.map((stream) => stream.key));
    const variableAlreadySpent = effectiveTransactions
      .filter(
        (tx) =>
          tx.direction === "out" &&
          isInRange(tx.date, periodStart, addDays(asOf, 1)) &&
          !recurringKeys.has(streamKey(tx.merchant, "out"))
      )
      .reduce((sum, tx) => sum + tx.amount, 0);

    const weeklySavingsTarget = Number(config.weeklySavingsTarget) || 0;
    const savingsNeeded = roundMoney(weeklySavingsTarget * allocationWeeks);
    const savingsAlready = roundMoney(
      savingsTransferredInRange(
        effectiveTransactions,
        config,
        periodStart,
        addDays(asOf, 1)
      )
    );
    const savingsRemaining = roundMoney(Math.max(0, savingsNeeded - savingsAlready));

    // Expected rhythm is informational only — never funds safe-to-spend.
    const weeklyIncome = activeExpected.reduce(
      (sum, stream) =>
        sum + amountToWeekly(stream.amount, stream.cadenceLabel, stream.cadenceDays),
      0
    );

    const streamTxIds = new Set(
      incomeStreams.flatMap((stream) => stream.transactionIds || [])
    );
    const irregularIncome = effectiveTransactions
      .filter((tx) => {
        if (tx.direction !== "in" || !Number.isFinite(tx.amount)) return false;
        if (tx.amount < 100) return false;
        if (streamTxIds.has(tx.id)) return false;
        const age = daysBetween(tx.date, config.asOfDate);
        return age >= 0 && age <= 90;
      })
      .sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount)
      .slice(0, 8)
      .map((tx) => ({
        merchant: tx.merchant,
        key: streamKey(tx.merchant, "in"),
        amount: roundMoney(tx.amount),
        lastDate: tx.date,
        status: "irregular",
        confidence: "low",
        active: false,
        nextExpected: null,
        cadenceLabel: null,
        cadenceDays: null,
        occurrences: 1
      }));

    const incomeOutlook = [
      ...incomeStreams.map((stream) => ({
        merchant: stream.merchant,
        key: stream.key,
        amount: roundMoney(stream.amount),
        cadenceLabel: stream.cadenceLabel,
        cadenceDays: stream.cadenceDays,
        lastDate: stream.lastDate,
        nextExpected: stream.nextExpected,
        occurrences: stream.occurrences,
        status: stream.status,
        confidence: stream.confidence,
        active: stream.active,
        weeklyShare: roundMoney(
          amountToWeekly(stream.amount, stream.cadenceLabel, stream.cadenceDays)
        ),
        drivesHorizon: Boolean(stream.drivesHorizon)
      })),
      ...irregularIncome
    ];

    const pool = roundMoney(
      availableAfterReserve - unpaidObligations - savingsRemaining
    );
    // Checking already reflects spending — do not subtract spent again.
    const remaining = roundMoney(pool / allocationWeeks);

    const assumptions = [];
    if (horizonSource === "default-4-weeks") {
      assumptions.push(
        "No confirmed income date — allocating checking cash over 4 weeks"
      );
    } else {
      assumptions.push(
        `Allocating through confirmed income on ${nextPayday}`
      );
    }
    if (balanceSource === "ledger") {
      assumptions.push(
        "Checking balance is ledger-derived (lower confidence than a live statement balance)"
      );
    } else if (balanceSource === "none") {
      assumptions.push("No checking account found for cash-backed safe-to-spend");
    }
    assumptions.push(
      "Only known unpaid bills/cards are reserved — missing obligations are not assumed"
    );
    assumptions.push(
      "Expected income is shown separately and does not increase safe-to-spend until it posts"
    );

    const pay = payPeriodBounds(
      confirmed.length ? confirmed : activeExpected,
      config.asOfDate
    );

    return {
      period: `${toDateString(periodStart)} / ${toDateString(addDays(periodEnd, -1))}`,
      periodSource: "calendar-week",
      fundingMode: "cash-backed",
      nextPayday: nextPayday || pay.nextPayday,
      horizonDays: allocationDays,
      allocationWeeks,
      horizonSource,
      income: roundMoney(weeklyIncome),
      incomeReceived: roundMoney(
        effectiveTransactions
          .filter(
            (tx) =>
              tx.direction === "in" &&
              isInRange(tx.date, periodStart, addDays(asOf, 1))
          )
          .reduce((sum, tx) => sum + tx.amount, 0)
      ),
      incomeExpected: roundMoney(weeklyIncome),
      weeklyIncome: roundMoney(weeklyIncome),
      committed: roundMoney(unpaidObligations),
      commitments: commitmentRows
        .sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount)
        .map((row) => ({
          title: row.title,
          amount: roundMoney(row.amount),
          date: row.date,
          source: row.source,
          cadenceLabel: row.cadenceLabel,
          fullAmount:
            row.fullAmount != null ? roundMoney(row.fullAmount) : undefined
        })),
      dueThisWeek: dueThisWeek
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((row) => ({
          ...row,
          amount: roundMoney(row.amount)
        })),
      savingsTarget: roundMoney(weeklySavingsTarget),
      savingsNeeded,
      savingsAlready,
      savingsRemaining,
      spent: roundMoney(variableAlreadySpent),
      remaining,
      breakdown: {
        checkingAccountId,
        checkingBalance: roundMoney(checkingBalance),
        balanceSource,
        reserve: roundMoney(reserve),
        availableAfterReserve,
        unpaidObligations: roundMoney(unpaidObligations),
        savingsNeeded,
        savingsAlready,
        savingsRemaining,
        pool,
        allocationWeeks,
        allocationDays,
        horizonEnd: horizonEndIso,
        horizonSource
      },
      incomeOutlook,
      assumptions,
      incomeStreams,
      expenseStreams
    };
  }

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Net balance delta from transactions for one account (opening excluded).
   * Used to reconcile SimpleFIN's reported balance → openingBalance.
   */
  function accountActivityDelta(transactions, accountId, accountType, accountTypes) {
    let delta = 0;
    (transactions || []).forEach((tx) => {
      if (tx.duplicateOf) return;
      if (!tx.direction || !Number.isFinite(tx.amount)) return;
      if (tx.direction === "transfer") {
        const target = tx.transferAccount || tx.suggestedTransferAccount;
        if (tx.account === accountId) {
          delta += sourceTransferDelta(accountType || tx.accountType, tx.amount);
        }
        if (target === accountId) {
          delta += targetTransferDelta(
            accountTypes?.[accountId] || accountType,
            tx.amount
          );
        }
        return;
      }
      if (tx.account !== accountId) return;
      delta += accountDeltaForActivity(
        accountType || tx.accountType,
        tx.direction,
        tx.amount
      );
    });
    return roundMoney(delta);
  }

  function openingFromRemoteBalance(remoteBalance, activityDelta) {
    return roundMoney(Number(remoteBalance) - Number(activityDelta || 0));
  }

  function computeSnapshot(transactions, suppliedConfig) {
    const config = {
      ...DEFAULT_CONFIG,
      ...suppliedConfig,
      openingBalances: { ...(suppliedConfig?.openingBalances || {}) },
      accountTypes: { ...(suppliedConfig?.accountTypes || {}) },
      reportedBalances: { ...(suppliedConfig?.reportedBalances || {}) },
      accountLabels: { ...(suppliedConfig?.accountLabels || {}) },
      incomeStreamOverrides: normalizeIncomeOverrides(
        suppliedConfig?.incomeStreamOverrides
      ),
      accounts: Array.isArray(suppliedConfig?.accounts)
        ? suppliedConfig.accounts
        : DEFAULT_CONFIG.accounts,
      bills: suppliedConfig?.bills || DEFAULT_CONFIG.bills,
      asOfDate: suppliedConfig?.asOfDate || DEFAULT_CONFIG.asOfDate || todayIso(),
      checkingReserve:
        suppliedConfig?.checkingReserve != null
          ? Number(suppliedConfig.checkingReserve)
          : DEFAULT_CONFIG.checkingReserve,
      accountHoldings: { ...(suppliedConfig?.accountHoldings || {}) }
    };
    // Only registered accounts — never invent checking/savings/vanguard ghosts.
    const balances = {};
    Object.keys(config.accountTypes).forEach((accountId) => {
      balances[accountId] = Number(config.openingBalances[accountId]) || 0;
    });
    const spendingByCategory = {};
    const spendingByCategoryAll = {};
    let income = 0;
    let expenses = 0;
    let expensesThisMonth = 0;
    let incomeThisMonth = 0;
    const asOf = parseDate(config.asOfDate);
    const monthKey = config.asOfDate.slice(0, 7);
    const effectiveTransactions = transactions.filter(
      (tx) => parseDate(tx.date) <= asOf
    );

    effectiveTransactions.forEach((tx) => {
      if (!tx.direction || !Number.isFinite(tx.amount)) return;
      // Opposite leg of an internal transfer — already applied via the source transfer.
      if (tx.duplicateOf) return;
      const knownAccount = tx.account in config.accountTypes;
      const inMonth = tx.date.slice(0, 7) === monthKey;

      if (tx.direction === "transfer") {
        const target = tx.transferAccount || tx.suggestedTransferAccount;
        if (!target || !config.accountTypes[target] || target === tx.account) return;
        if (!knownAccount) return;
        balances[tx.account] += sourceTransferDelta(tx.accountType, tx.amount);
        balances[target] += targetTransferDelta(config.accountTypes[target], tx.amount);
        return;
      }

      if (knownAccount) {
        balances[tx.account] += accountDeltaForActivity(
          tx.accountType,
          tx.direction,
          tx.amount
        );
      }
      if (tx.direction === "in") {
        income += tx.amount;
        if (inMonth) incomeThisMonth += tx.amount;
      }
      if (tx.direction === "out") {
        expenses += tx.amount;
        const category = tx.category || "uncategorized";
        spendingByCategoryAll[category] =
          (spendingByCategoryAll[category] || 0) + tx.amount;
        if (inMonth) {
          expensesThisMonth += tx.amount;
          spendingByCategory[category] =
            (spendingByCategory[category] || 0) + tx.amount;
        }
      }
    });

    // Live feeds (SimpleFIN) or manual "current balance" win over ledger walk.
    // Prevents UWCU→Amex payment transfers from warping the Amex balance.
    const balanceSources = {};
    Object.keys(balances).forEach((accountId) => {
      balanceSources[accountId] = "ledger";
    });
    Object.entries(config.reportedBalances || {}).forEach(([accountId, value]) => {
      if (accountId in balances && Number.isFinite(Number(value))) {
        balances[accountId] = Number(value);
        balanceSources[accountId] = "live";
      }
    });

    const holdingBreakdown = {};
    const balanceWarnings = [];
    const totals = Object.entries(balances).reduce(
      (result, [account, balance]) => {
        const type = config.accountTypes[account];
        const allocated = allocateAccountTotals(
          account,
          balance,
          type,
          config.accountHoldings
        );
        let liquidAdd = allocated.liquid;
        let investedAdd = allocated.invested;
        // Incomplete bank CSV history with opening $0 can reconstruct large
        // negative cash and destroy net worth. Until a live/manual balance is
        // set, don't let ledger-only cash go negative in totals.
        if (
          type === "cash" &&
          balanceSources[account] === "ledger" &&
          liquidAdd < 0
        ) {
          balanceWarnings.push({
            accountId: account,
            issue: "stale_ledger_negative",
            ledgerBalance: roundMoney(balance),
            message:
              "Ledger balance is negative without a live/manual balance — excluded from liquid until you set the current balance"
          });
          liquidAdd = 0;
        }
        result.liquid += liquidAdd;
        result.invested += investedAdd;
        result.liabilities += allocated.liabilities;
        result.owed += allocated.owed;
        if (allocated.split) {
          holdingBreakdown[account] = {
            cash: allocated.split.cash,
            invested: allocated.split.invested,
            holdings: allocated.split.holdings
          };
        }
        return result;
      },
      { liquid: 0, invested: 0, liabilities: 0, owed: 0 }
    );

    const safe = computeSafeToSpend(
      effectiveTransactions,
      config,
      balances,
      balanceSources
    );
    const recurring = safe.expenseStreams.map((stream) => ({
      merchant: stream.merchant,
      key: stream.key,
      category: stream.category || "",
      amount: stream.amount,
      occurrences: stream.occurrences,
      transactionIds: stream.transactionIds,
      cadenceDays: stream.cadenceDays,
      cadenceLabel: stream.cadenceLabel,
      lastDate: stream.lastDate
    }));
    const recurringMonthly = recurring.reduce((sum, item) => {
      if (item.cadenceLabel === "weekly") return sum + item.amount * 4.345;
      if (item.cadenceLabel === "biweekly") return sum + item.amount * (365 / 14 / 12);
      if (item.cadenceLabel === "bimonthly") return sum + item.amount / 2;
      return sum + item.amount;
    }, 0);

    const monthsCovered = new Set(
      effectiveTransactions
        .filter((tx) => tx.direction === "out")
        .map((tx) => tx.date.slice(0, 7))
    ).size;
    const avgMonthlyExpenses = monthsCovered ? expenses / monthsCovered : 0;

    // Budget is deliberately separate from the cash-horizon safety rail above:
    // weekly spendable is always income - committed bills - savings first.
    const weeklyBudget = Budget.computeBudget(
      {
        asOfDate: config.asOfDate,
        recurring,
        safeToSpend: safe
      },
      effectiveTransactions,
      {
        periodIncome: safe.weeklyIncome,
        committedBills: Budget.committedBillsFromSnapshot({
          recurring,
          safeToSpend: safe
        }),
        savingsTarget: config.weeklySavingsTarget
      }
    );
    const categoryDiagnostics = Budget.categoryDiagnostics(
      { asOfDate: config.asOfDate, recurring },
      effectiveTransactions
    );
    const priorBudget = Budget.computeBudget(
      {
        asOfDate: config.asOfDate,
        recurring,
        safeToSpend: safe
      },
      effectiveTransactions,
      {
        periodOffset: -1,
        periodIncome: safe.weeklyIncome,
        committedBills: Budget.committedBillsFromSnapshot({ recurring }),
        savingsTarget: config.weeklySavingsTarget
      }
    );
    const rollover = Budget.rolloverPeriod(priorBudget, {
      periodIncome: weeklyBudget.periodIncome,
      committedBills: weeklyBudget.committedBills,
      savingsTarget: weeklyBudget.savingsTarget
    });
    let ratchet = {
      streak: 0,
      savingsTarget: weeklyBudget.savingsTarget
    };
    for (let offset = -Budget.RATCHET_STREAK_N; offset < 0; offset += 1) {
      const completed = Budget.computeBudget(
        { asOfDate: config.asOfDate, recurring, safeToSpend: safe },
        effectiveTransactions,
        {
          periodOffset: offset,
          periodIncome: safe.weeklyIncome,
          committedBills: Budget.committedBillsFromSnapshot({ recurring }),
          savingsTarget: weeklyBudget.savingsTarget
        }
      );
      ratchet = {
        ...ratchet,
        ...Budget.updateRatchet(ratchet, completed)
      };
    }
    const budgetFlags = [
      rollover.sweepFlag,
      ratchet.proposal,
      categoryDiagnostics.leakFlag
    ].filter(Boolean);

    Object.keys(balances).forEach((key) => {
      balances[key] = roundMoney(balances[key]);
    });
    Object.keys(spendingByCategory).forEach((key) => {
      spendingByCategory[key] = roundMoney(spendingByCategory[key]);
    });
    Object.keys(spendingByCategoryAll).forEach((key) => {
      spendingByCategoryAll[key] = roundMoney(spendingByCategoryAll[key]);
    });

    return {
      asOfDate: config.asOfDate,
      balances,
      holdingBreakdown,
      balanceSources,
      balanceWarnings,
      netWorth: roundMoney(totals.liquid + totals.invested - totals.liabilities),
      liquid: roundMoney(totals.liquid),
      invested: roundMoney(totals.invested),
      liabilities: roundMoney(totals.liabilities),
      owed: roundMoney(totals.owed),
      income: roundMoney(income),
      incomeThisMonth: roundMoney(incomeThisMonth),
      expenses: roundMoney(expenses),
      expensesThisMonth: roundMoney(expensesThisMonth),
      spendingMonth: monthKey,
      savingsRate: income ? (income - expenses) / income : 0,
      spendingByCategory,
      spendingByCategoryAll,
      recurring,
      recurringMonthly: roundMoney(recurringMonthly),
      avgMonthlyExpenses: roundMoney(avgMonthlyExpenses),
      runwayMonths: avgMonthlyExpenses ? totals.liquid / avgMonthlyExpenses : 0,
      safeToSpend: {
        period: weeklyBudget.periodLabel,
        periodSource: safe.periodSource,
        fundingMode: "income-minus-commitments",
        nextPayday: safe.nextPayday,
        horizonDays: safe.horizonDays,
        allocationWeeks: safe.allocationWeeks,
        horizonSource: safe.horizonSource,
        amount: weeklyBudget.safeToSpend,
        income: weeklyBudget.periodIncome,
        incomeReceived: safe.incomeReceived,
        incomeExpected: safe.incomeExpected,
        weeklyIncome: safe.weeklyIncome,
        committed: weeklyBudget.committedBills,
        commitments: safe.commitments,
        dueThisWeek: safe.dueThisWeek,
        savingsTarget: weeklyBudget.savingsTarget,
        savingsNeeded: safe.savingsNeeded,
        savingsAlready: safe.savingsAlready,
        savingsRemaining: safe.savingsRemaining,
        spent: weeklyBudget.discretionarySpend,
        remaining: weeklyBudget.remaining,
        cashBackedRemaining: safe.remaining,
        breakdown: {
          ...safe.breakdown,
          periodIncome: weeklyBudget.periodIncome,
          committedBills: weeklyBudget.committedBills,
          savingsTarget: weeklyBudget.savingsTarget,
          safeToSpend: weeklyBudget.safeToSpend,
          discretionarySpend: weeklyBudget.discretionarySpend,
          cashBackedRemaining: safe.remaining
        },
        incomeOutlook: safe.incomeOutlook,
        assumptions: [
          "Savings is subtracted before spendable is shown",
          "Unspent weekly safe-to-spend never carries into a later week",
          ...safe.assumptions
        ],
        ratchet
      },
      categoryDiagnostics,
      flags: budgetFlags
    };
  }

  function clampDay(year, monthIndex, day) {
    const last = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    return Math.min(Math.max(1, Number(day) || 1), last);
  }

  function dateWithDay(asOfDate, day, monthOffset) {
    const base = parseDate(asOfDate);
    const year = base.getUTCFullYear();
    const month = base.getUTCMonth() + (monthOffset || 0);
    const d = new Date(Date.UTC(year, month, 1));
    d.setUTCDate(clampDay(d.getUTCFullYear(), d.getUTCMonth(), day));
    return d;
  }

  /**
   * Card statement / due helpers for budgeting around payday vs statement close.
   * Liability balances are positive = amount owed.
   */
  function buildCardSchedule(transactions, accounts, snapshot, asOfDate) {
    const asOf = asOfDate || todayIso();
    const cards = (accounts || []).filter(
      (account) => account.type === "liability" && account.id !== "outside-payments"
    );
    return cards.map((account) => {
      const statementDay = Number(account.statementDay) || 2;
      const dueDay = Number(account.dueDay) || 27;
      let lastStatement = dateWithDay(asOf, statementDay, 0);
      if (lastStatement > parseDate(asOf)) {
        lastStatement = dateWithDay(asOf, statementDay, -1);
      }
      let nextDue = dateWithDay(asOf, dueDay, 0);
      if (nextDue <= lastStatement) {
        nextDue = dateWithDay(toDateString(lastStatement), dueDay, 1);
      }
      if (nextDue <= parseDate(asOf)) {
        nextDue = dateWithDay(asOf, dueDay, 1);
      }
      const lastStatementIso = toDateString(lastStatement);
      const nextDueIso = toDateString(nextDue);
      const cycleSpend = (transactions || [])
        .filter(
          (tx) =>
            tx.account === account.id &&
            tx.direction === "out" &&
            tx.date >= lastStatementIso &&
            tx.date <= asOf
        )
        .reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);
      const rawBalance = Number(snapshot?.balances?.[account.id]);
      const balance = Number.isFinite(rawBalance) ? Math.abs(rawBalance) : 0;
      const daysToDue = daysBetween(asOf, nextDueIso);
      const payday = snapshot?.safeToSpend?.nextPayday || null;
      let payTiming = "set statement/due days";
      if (payday) {
        if (payday <= nextDueIso) {
          payTiming = `Pay from paycheck on ${payday} (before due ${nextDueIso})`;
        } else {
          payTiming = `Due ${nextDueIso} is before next payday ${payday} — use liquid cash`;
        }
      } else {
        payTiming = `Due in ${daysToDue}d (${nextDueIso})`;
      }
      return {
        accountId: account.id,
        label: account.label || account.id,
        balance: roundMoney(balance),
        reportedAt: account.reportedAt || null,
        statementDay,
        dueDay,
        lastStatement: lastStatementIso,
        nextDue: nextDueIso,
        daysToDue,
        cycleSpend: roundMoney(cycleSpend),
        paySuggestion: roundMoney(balance),
        payTiming,
        source: account.reportedBalance != null ? "live" : "ledger"
      };
    });
  }

  return {
    DEFAULT_CONFIG,
    SAMPLE_FIXTURE,
    ENGINE_VERSION,
    computeSnapshot,
    detectRecurring,
    detectRecurringStreams,
    detectIncomeStreams,
    buildCardSchedule,
    payPeriodBounds,
    weekBounds,
    accountActivityDelta,
    openingFromRemoteBalance,
    isCashLikeHolding,
    normalizeHoldings,
    splitBalanceByHoldings,
    normalizeIncomeOverrides,
    todayIso
  };
});
