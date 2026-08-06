(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MoneyModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_CONFIG = {
    asOfDate: "2026-08-05",
    monthlyIncome: 5200,
    weeklyIncome: null,
    weeklySavingsTarget: 300,
    openingBalances: {
      checking: 6200,
      savings: 12000,
      "uwcu-checking": 0,
      "uwcu-savings": 0,
      vanguard: 28000,
      amex: 0,
      discover: 0,
      "outside-payments": 0
    },
    accountTypes: {
      checking: "cash",
      savings: "cash",
      "uwcu-checking": "cash",
      "uwcu-savings": "cash",
      vanguard: "investment",
      amex: "liability",
      discover: "liability",
      "outside-payments": "external"
    }
  };

  const DAY_MS = 24 * 60 * 60 * 1000;

  function roundMoney(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  function parseDate(date) {
    return new Date(`${date}T12:00:00Z`);
  }

  function merchantKey(merchant) {
    return String(merchant || "").trim().toLowerCase();
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function amountsAreSimilar(left, right) {
    return Math.abs(left - right) <= Math.max(2, Math.max(left, right) * 0.05);
  }

  function detectRecurring(transactions) {
    const groups = new Map();
    transactions
      .filter((tx) => tx.direction === "out" && tx.category)
      .forEach((tx) => {
        const key = merchantKey(tx.merchant);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(tx);
      });

    const recurring = [];
    groups.forEach((items, key) => {
      const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date));
      const matching = [];
      for (let index = 1; index < sorted.length; index += 1) {
        const days =
          (parseDate(sorted[index].date) - parseDate(sorted[index - 1].date)) / DAY_MS;
        if (
          days >= 25 &&
          days <= 35 &&
          amountsAreSimilar(sorted[index].amount, sorted[index - 1].amount)
        ) {
          matching.push(sorted[index - 1], sorted[index]);
        }
      }
      const unique = [...new Map(matching.map((item) => [item.id, item])).values()];
      if (unique.length >= 2) {
        recurring.push({
          merchant: unique[0].merchant,
          key,
          amount: roundMoney(median(unique.map((item) => item.amount))),
          occurrences: unique.length,
          transactionIds: unique.map((item) => item.id)
        });
      }
    });
    return recurring.sort((a, b) => b.amount - a.amount);
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

  function accountDeltaForActivity(accountType, direction, amount) {
    if (accountType === "cash" || accountType === "investment") {
      return direction === "in" ? amount : -amount;
    }
    if (accountType === "liability" || accountType === "external") {
      return direction === "out" ? amount : -amount;
    }
    return 0;
  }

  function sourceTransferDelta(accountType, amount) {
    return accountType === "liability" || accountType === "external" ? amount : -amount;
  }

  function targetTransferDelta(accountType, amount) {
    return accountType === "liability" || accountType === "external" ? -amount : amount;
  }

  function computeSnapshot(transactions, suppliedConfig) {
    const config = {
      ...DEFAULT_CONFIG,
      ...suppliedConfig,
      openingBalances: {
        ...DEFAULT_CONFIG.openingBalances,
        ...(suppliedConfig?.openingBalances || {})
      },
      accountTypes: {
        ...DEFAULT_CONFIG.accountTypes,
        ...(suppliedConfig?.accountTypes || {})
      }
    };
    const balances = { ...config.openingBalances };
    const spendingByCategory = {};
    let income = 0;
    let expenses = 0;
    const asOf = parseDate(config.asOfDate);
    const effectiveTransactions = transactions.filter(
      (tx) => parseDate(tx.date) <= asOf
    );

    effectiveTransactions.forEach((tx) => {
      if (!tx.direction || !Number.isFinite(tx.amount)) return;
      if (!(tx.account in balances)) balances[tx.account] = 0;

      if (tx.direction === "transfer") {
        const target = tx.transferAccount || tx.suggestedTransferAccount;
        if (!target || !config.accountTypes[target] || target === tx.account) return;
        if (!(target in balances)) balances[target] = 0;
        balances[tx.account] += sourceTransferDelta(tx.accountType, tx.amount);
        balances[target] += targetTransferDelta(config.accountTypes[target], tx.amount);
        return;
      }

      balances[tx.account] += accountDeltaForActivity(
        tx.accountType,
        tx.direction,
        tx.amount
      );
      if (tx.direction === "in") income += tx.amount;
      if (tx.direction === "out") {
        expenses += tx.amount;
        const category = tx.category || "uncategorized";
        spendingByCategory[category] =
          (spendingByCategory[category] || 0) + tx.amount;
      }
    });

    const totals = Object.entries(balances).reduce(
      (result, [account, balance]) => {
        const type = config.accountTypes[account];
        if (type === "cash") result.liquid += balance;
        if (type === "investment") result.invested += balance;
        if (type === "liability" || type === "external") result.liabilities += balance;
        if (type === "external") result.owed += balance;
        return result;
      },
      { liquid: 0, invested: 0, liabilities: 0, owed: 0 }
    );

    const recurring = detectRecurring(effectiveTransactions);
    const recurringMonthly = recurring.reduce((sum, item) => sum + item.amount, 0);
    const recurringKeys = new Set(recurring.map((item) => item.key));
    const { start, end } = weekBounds(config.asOfDate);
    const variableAlreadySpentThisWeek = effectiveTransactions
      .filter(
        (tx) =>
          tx.direction === "out" &&
          isInRange(tx.date, start, end) &&
          !recurringKeys.has(merchantKey(tx.merchant))
      )
      .reduce((sum, tx) => sum + tx.amount, 0);
    const thisWeekCommitted = recurringMonthly / 4.345;
    const weeklyIncome = config.weeklyIncome ?? config.monthlyIncome / 4.345;
    const safeToSpend =
      weeklyIncome -
      thisWeekCommitted -
      config.weeklySavingsTarget -
      variableAlreadySpentThisWeek;
    const monthsCovered = new Set(
      effectiveTransactions
        .filter((tx) => tx.direction === "out")
        .map((tx) => tx.date.slice(0, 7))
    ).size;
    const avgMonthlyExpenses = monthsCovered ? expenses / monthsCovered : 0;

    Object.keys(balances).forEach((key) => {
      balances[key] = roundMoney(balances[key]);
    });
    Object.keys(spendingByCategory).forEach((key) => {
      spendingByCategory[key] = roundMoney(spendingByCategory[key]);
    });

    return {
      balances,
      netWorth: roundMoney(totals.liquid + totals.invested - totals.liabilities),
      liquid: roundMoney(totals.liquid),
      invested: roundMoney(totals.invested),
      liabilities: roundMoney(totals.liabilities),
      owed: roundMoney(totals.owed),
      income: roundMoney(income),
      expenses: roundMoney(expenses),
      savingsRate: income ? (income - expenses) / income : 0,
      spendingByCategory,
      recurring,
      recurringMonthly: roundMoney(recurringMonthly),
      avgMonthlyExpenses: roundMoney(avgMonthlyExpenses),
      runwayMonths: avgMonthlyExpenses ? totals.liquid / avgMonthlyExpenses : 0,
      safeToSpend: {
        period: `${start.toISOString().slice(0, 10)} / ${new Date(
          end.getTime() - DAY_MS
        )
          .toISOString()
          .slice(0, 10)}`,
        weeklyIncome: roundMoney(weeklyIncome),
        committed: roundMoney(thisWeekCommitted),
        savingsTarget: roundMoney(config.weeklySavingsTarget),
        spent: roundMoney(variableAlreadySpentThisWeek),
        remaining: roundMoney(safeToSpend)
      }
    };
  }

  return {
    DEFAULT_CONFIG,
    computeSnapshot,
    detectRecurring,
    weekBounds
  };
});
