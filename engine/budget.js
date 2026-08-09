(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MoneyBudget = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PERIOD = "week";
  const PAUSE_THRESHOLD = 25;
  const COOLDOWN_THRESHOLD = 100;
  const RATCHET_STREAK_N = 3;
  const RATCHET_MARGIN = 0.1;
  const RATCHET_STEP = 10;
  const LEAK_THRESHOLD = 0.4;
  const ROLLING_PERIODS = 6;
  const DAY_MS = 24 * 60 * 60 * 1000;

  const CONFIG = Object.freeze({
    PERIOD,
    PAUSE_THRESHOLD,
    COOLDOWN_THRESHOLD,
    RATCHET_STREAK_N,
    RATCHET_MARGIN,
    RATCHET_STEP,
    LEAK_THRESHOLD,
    ROLLING_PERIODS
  });

  function roundMoney(value) {
    return Math.round(((Number(value) || 0) + Number.EPSILON) * 100) / 100;
  }

  function parseDate(iso) {
    return new Date(`${iso}T12:00:00Z`);
  }

  function isoDate(date) {
    return date.toISOString().slice(0, 10);
  }

  function addDays(date, days) {
    return new Date(date.getTime() + days * DAY_MS);
  }

  function weekBounds(asOfDate, offset = 0) {
    const date = parseDate(asOfDate);
    const weekday = date.getUTCDay();
    const sinceMonday = weekday === 0 ? 6 : weekday - 1;
    const start = addDays(date, -sinceMonday + offset * 7);
    return {
      start: isoDate(start),
      end: isoDate(addDays(start, 7)),
      label: `${isoDate(start)} / ${isoDate(addDays(start, 6))}`
    };
  }

  function inBounds(date, bounds) {
    return Boolean(date && date >= bounds.start && date < bounds.end);
  }

  function isIncome(tx) {
    return tx?.direction === "in" || tx?.direction === "money-in";
  }

  function isExpense(tx) {
    return tx?.direction === "out" || tx?.direction === "money-out";
  }

  function streamKey(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/\b(debitcard|pos|purchase|withdrawal|ach|checkcard|visa|mastercard)\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function amountToWeek(amount, cadenceLabel, cadenceDays) {
    const value = Number(amount) || 0;
    if (!value) return 0;
    if (cadenceLabel === "weekly" || Number(cadenceDays) === 7) return value;
    if (cadenceLabel === "biweekly") return value / 2;
    if (cadenceLabel === "bimonthly") return value * (7 / 60.875);
    const days = Number(cadenceDays) || 30.4375;
    return value * (7 / days);
  }

  function recurringIdentity(snapshot) {
    const ids = new Set();
    const keys = new Set();
    const rows = snapshot?.recurring || snapshot?.safeToSpend?.expenseStreams || [];
    rows.forEach((row) => {
      (row.transactionIds || []).forEach((id) => ids.add(id));
      if (row.key) keys.add(row.key);
      else if (row.merchant) keys.add(streamKey(row.merchant));
    });
    return { ids, keys };
  }

  function discretionaryTransactions(snapshot, transactions, bounds) {
    const recurring = recurringIdentity(snapshot);
    return (transactions || []).filter((tx) => {
      if (!isExpense(tx) || tx.duplicateOf || !Number.isFinite(Number(tx.amount))) {
        return false;
      }
      if (!inBounds(tx.date, bounds)) return false;
      if (recurring.ids.has(tx.id)) return false;
      return !recurring.keys.has(streamKey(tx.merchant || tx.rawMerchant));
    });
  }

  function periodIncomeFromSnapshot(snapshot) {
    const safe = snapshot?.safeToSpend || {};
    const value =
      safe.weeklyIncome ?? safe.incomeExpected ?? safe.income ?? snapshot?.weeklyIncome;
    return roundMoney(Math.max(0, Number(value) || 0));
  }

  function committedBillsFromSnapshot(snapshot) {
    const due = snapshot?.safeToSpend?.dueThisWeek;
    if (Array.isArray(due) && due.length) {
      return roundMoney(
        due.reduce((sum, row) => sum + Math.max(0, Number(row.amount) || 0), 0)
      );
    }
    return roundMoney(
      (snapshot?.recurring || []).reduce(
        (sum, row) =>
          sum + amountToWeek(row.amount, row.cadenceLabel, row.cadenceDays),
        0
      )
    );
  }

  function initializeSavingsTarget(snapshot, periodIncome) {
    const rate = Math.max(0, Math.min(1, Number(snapshot?.savingsRate) || 0));
    return roundMoney(Math.max(0, Number(periodIncome) || 0) * rate);
  }

  function safeToSpend(periodIncome, committedBills, savingsTarget) {
    return roundMoney(
      Math.max(
        0,
        (Number(periodIncome) || 0) -
          (Number(committedBills) || 0) -
          (Number(savingsTarget) || 0)
      )
    );
  }

  function computeBudget(snapshot, transactions, options = {}) {
    const asOfDate = options.asOfDate || snapshot?.asOfDate;
    if (!asOfDate) throw new Error("computeBudget requires asOfDate");
    const bounds = weekBounds(asOfDate, Number(options.periodOffset) || 0);
    const periodIncome =
      options.periodIncome != null
        ? roundMoney(options.periodIncome)
        : periodIncomeFromSnapshot(snapshot);
    const committedBills =
      options.committedBills != null
        ? roundMoney(options.committedBills)
        : committedBillsFromSnapshot(snapshot);
    const configuredTarget =
      options.savingsTarget ??
      snapshot?.safeToSpend?.savingsTarget ??
      initializeSavingsTarget(snapshot, periodIncome);
    const savingsTarget = roundMoney(Math.max(0, Number(configuredTarget) || 0));
    const amount = safeToSpend(periodIncome, committedBills, savingsTarget);
    const discretionary = discretionaryTransactions(snapshot, transactions, bounds);
    const spent = roundMoney(
      discretionary.reduce((sum, tx) => sum + Number(tx.amount), 0)
    );
    return {
      period: PERIOD,
      periodLabel: bounds.label,
      periodStart: bounds.start,
      periodEnd: bounds.end,
      periodIncome,
      committedBills,
      savingsTarget,
      safeToSpend: amount,
      discretionarySpend: spent,
      remaining: roundMoney(amount - spent),
      observed: (transactions || []).some(
        (tx) => !tx.duplicateOf && inBounds(tx.date, bounds)
      )
    };
  }

  function leftoverForPeriod(budget) {
    return roundMoney(
      Math.max(
        0,
        (Number(budget?.safeToSpend) || 0) -
          (Number(budget?.discretionarySpend) || 0)
      )
    );
  }

  function rolloverPeriod(completedBudget, nextInputs, options = {}) {
    const leftover = leftoverForPeriod(completedBudget);
    const goal = options.goal || "active savings goal";
    const next = safeToSpend(
      nextInputs?.periodIncome,
      nextInputs?.committedBills,
      nextInputs?.savingsTarget
    );
    return {
      leftover,
      // Deliberately no carryover input: prior leftover can only become a sweep.
      nextSafeToSpend: next,
      sweepFlag:
        leftover > 0
          ? {
              id: `budget-sweep:${completedBudget.periodStart || completedBudget.periodLabel}`,
              trigger: "safe-to-spend leftover",
              why: `$${leftover.toFixed(2)} stayed unspent last week`,
              action: `sweep $${leftover.toFixed(2)} to ${goal}`,
              dollarValue: leftover,
              deadline: options.deadline || null,
              confidence: 1
            }
          : null
    };
  }

  function updateRatchet(state, completedBudget, config = CONFIG) {
    const prior = Math.max(0, Number(state?.streak) || 0);
    if (completedBudget?.observed === false) {
      return { streak: 0, status: "insufficient-history", proposal: null };
    }
    const safe = Math.max(0, Number(completedBudget?.safeToSpend) || 0);
    const spent = Math.max(0, Number(completedBudget?.discretionarySpend) || 0);
    if (spent > safe) {
      return { streak: prior, status: "paused", proposal: null };
    }
    const underspent = spent < safe * (1 - config.RATCHET_MARGIN);
    const streak = underspent ? prior + 1 : 0;
    const savingsTarget = Math.max(0, Number(state?.savingsTarget) || 0);
    const proposal =
      underspent && streak >= config.RATCHET_STREAK_N
        ? {
            id: `budget-ratchet:${completedBudget.periodStart || completedBudget.periodLabel}`,
            trigger: "underspend streak",
            why: `${streak} weeks with room left`,
            action: `save $${config.RATCHET_STEP.toFixed(2)} more per week`,
            dollarValue: config.RATCHET_STEP,
            deadline: null,
            confidence: 0.9,
            nextSavingsTarget: roundMoney(savingsTarget + config.RATCHET_STEP)
          }
        : null;
    return { streak, status: proposal ? "proposed" : underspent ? "building" : "steady", proposal };
  }

  function acceptRatchet(savingsTarget, config = CONFIG) {
    return roundMoney(
      Math.max(0, Number(savingsTarget) || 0) + Number(config.RATCHET_STEP)
    );
  }

  function categoryTotals(snapshot, transactions, bounds) {
    const totals = {};
    discretionaryTransactions(snapshot, transactions, bounds).forEach((tx) => {
      const category = tx.category || "uncategorized";
      totals[category] = roundMoney((totals[category] || 0) + Number(tx.amount));
    });
    return totals;
  }

  function categoryDiagnostics(snapshot, transactions, options = {}) {
    const asOfDate = options.asOfDate || snapshot?.asOfDate;
    if (!asOfDate) throw new Error("categoryDiagnostics requires asOfDate");
    const historyPeriods = Math.max(1, Number(options.historyPeriods) || ROLLING_PERIODS);
    const currentBounds = weekBounds(asOfDate);
    const current = categoryTotals(snapshot, transactions, currentBounds);
    const history = [];
    for (let offset = -historyPeriods; offset < 0; offset += 1) {
      history.push(categoryTotals(snapshot, transactions, weekBounds(asOfDate, offset)));
    }
    const categories = new Set(Object.keys(current));
    history.forEach((period) => Object.keys(period).forEach((name) => categories.add(name)));
    const rows = [...categories]
      .map((category) => {
        const samples = history.map((period) => Number(period[category]) || 0);
        const activePeriods = samples.filter((amount) => amount > 0).length;
        const average = roundMoney(
          samples.reduce((sum, amount) => sum + amount, 0) / historyPeriods
        );
        const amount = roundMoney(current[category] || 0);
        const overage = roundMoney(Math.max(0, amount - average));
        const ratio = average > 0 ? amount / average - 1 : 0;
        return {
          category,
          amount,
          rollingAverage: average,
          overage,
          ratio,
          historyPeriods,
          activeHistoryPeriods: activePeriods
        };
      })
      .filter((row) => row.amount > 0)
      .sort((left, right) => right.amount - left.amount || left.category.localeCompare(right.category));

    const biggestLeak = rows
      .filter(
        (row) =>
          row.rollingAverage > 0 &&
          row.ratio >= (options.leakThreshold ?? LEAK_THRESHOLD)
      )
      .sort((left, right) => right.overage - left.overage || right.ratio - left.ratio)[0];
    const leakFlag = biggestLeak
      ? {
          id: `budget-leak:${currentBounds.start}:${biggestLeak.category}`,
          trigger: "category over baseline",
          why: `${biggestLeak.category} $${biggestLeak.amount.toFixed(2)} vs usual $${biggestLeak.rollingAverage.toFixed(2)}`,
          action: "cut here",
          dollarValue: biggestLeak.overage,
          deadline: currentBounds.end,
          confidence: Math.min(
            1,
            roundMoney(0.25 + 0.75 * (biggestLeak.activeHistoryPeriods / historyPeriods))
          )
        }
      : null;

    const declined = new Set(options.declinedCategories || []);
    const envelopeSuggestions = rows
      .filter((row) => !declined.has(row.category))
      .sort(
        (left, right) =>
          right.amount - left.amount || right.ratio - left.ratio
      )
      .slice(0, 3)
      .map((row) => ({
        category: row.category,
        suggestedLimit: roundMoney(Math.max(row.rollingAverage, row.amount - row.overage)),
        currentSpend: row.amount,
        rollingAverage: row.rollingAverage
      }));

    return { period: currentBounds.label, categories: rows, leakFlag, envelopeSuggestions };
  }

  function spendPause(transaction, remaining, options = {}) {
    const amount = Math.max(0, Number(transaction?.amount) || 0);
    if (!isExpense(transaction) || options.committed || amount < PAUSE_THRESHOLD) {
      return { required: false, cooldownOffered: false };
    }
    const after = roundMoney((Number(remaining) || 0) - amount);
    return {
      required: true,
      message: `$${after.toFixed(2)} left this week — still in?`,
      cooldownOffered: amount >= COOLDOWN_THRESHOLD,
      revisitDate:
        amount >= COOLDOWN_THRESHOLD
          ? isoDate(addDays(parseDate(options.asOfDate || transaction.date), 1))
          : null
    };
  }

  return {
    CONFIG,
    PERIOD,
    PAUSE_THRESHOLD,
    COOLDOWN_THRESHOLD,
    RATCHET_STREAK_N,
    RATCHET_MARGIN,
    RATCHET_STEP,
    LEAK_THRESHOLD,
    weekBounds,
    discretionaryTransactions,
    periodIncomeFromSnapshot,
    committedBillsFromSnapshot,
    initializeSavingsTarget,
    safeToSpend,
    computeBudget,
    leftoverForPeriod,
    rolloverPeriod,
    updateRatchet,
    acceptRatchet,
    categoryDiagnostics,
    spendPause
  };
});
