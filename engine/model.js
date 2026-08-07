(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MoneyModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Live hub snapshots must supply openings/types from the account registry.
  // Demo openings live only in tests / mock-shelf — never silently merge here.
  const DEFAULT_CONFIG = {
    asOfDate: null,
    weeklySavingsTarget: 300,
    bills: [],
    openingBalances: {},
    accountTypes: {}
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
      .replace(new RegExp(`\\b(${MONTH_NAMES})\\b`, "g"), " ")
      .replace(/\b(20)?\d{2}\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim() || raw;
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

  function cadenceFromGaps(gaps) {
    if (!gaps.length) return null;
    const mid = median(gaps);
    if (mid >= 5 && mid <= 9) return { days: Math.round(mid), label: "weekly" };
    if (mid >= 12 && mid <= 17) return { days: Math.round(mid), label: "biweekly" };
    if (mid >= 25 && mid <= 36) return { days: Math.round(mid), label: "monthly" };
    if (mid >= 55 && mid <= 75) return { days: Math.round(mid), label: "bimonthly" };
    return null;
  }

  function detectRecurringStreams(transactions, direction) {
    const groups = new Map();
    transactions
      .filter((tx) => tx.direction === direction && Number.isFinite(tx.amount))
      .forEach((tx) => {
        if (direction === "out" && !tx.category) return;
        const key = streamKey(tx.merchant, direction);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(tx);
      });

    const streams = [];
    groups.forEach((items, key) => {
      const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date));
      const matching = [];
      const gaps = [];
      for (let index = 1; index < sorted.length; index += 1) {
        const days = daysBetween(sorted[index - 1].date, sorted[index].date);
        if (amountsAreSimilar(sorted[index].amount, sorted[index - 1].amount)) {
          const cadence = cadenceFromGaps([days]);
          if (cadence) {
            matching.push(sorted[index - 1], sorted[index]);
            gaps.push(days);
          }
        }
      }
      const unique = [...new Map(matching.map((item) => [item.id, item])).values()];
      const cadence = cadenceFromGaps(gaps);
      if (unique.length >= 2 && cadence) {
        const last = unique[unique.length - 1];
        streams.push({
          merchant: unique[0].merchant,
          key,
          direction,
          amount: roundMoney(median(unique.map((item) => item.amount))),
          cadenceDays: cadence.days,
          cadenceLabel: cadence.label,
          lastDate: last.date,
          occurrences: unique.length,
          transactionIds: unique.map((item) => item.id)
        });
      }
    });
    return streams.sort((a, b) => b.amount - a.amount);
  }

  function detectRecurring(transactions) {
    return detectRecurringStreams(transactions, "out").map((stream) => ({
      merchant: stream.merchant,
      key: stream.key,
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
    return {
      liquid: type === "cash" ? balance : 0,
      invested: type === "investment" ? balance : 0,
      liabilities: type === "liability" || type === "external" ? balance : 0,
      owed: type === "external" ? balance : 0,
      split: null
    };
  }

  function sourceTransferDelta(accountType, amount) {
    return accountType === "liability" || accountType === "external" ? amount : -amount;
  }

  function targetTransferDelta(accountType, amount) {
    return accountType === "liability" || accountType === "external" ? -amount : amount;
  }

  function computeSafeToSpend(effectiveTransactions, config) {
    const incomeStreams = detectRecurringStreams(effectiveTransactions, "in");
    const expenseStreams = detectRecurringStreams(effectiveTransactions, "out");
    const { start, end, source, nextPayday } = payPeriodBounds(
      incomeStreams,
      config.asOfDate
    );
    const asOf = parseDate(config.asOfDate);
    const horizonEnd = end < asOf ? addDays(asOf, 7) : end;
    const periodStart = start;
    const periodEnd = horizonEnd;

    const incomeReceived = effectiveTransactions
      .filter((tx) => tx.direction === "in" && isInRange(tx.date, periodStart, addDays(asOf, 1)))
      .reduce((sum, tx) => sum + tx.amount, 0);

    const incomeExpected = incomeStreams.reduce((sum, stream) => {
      return (
        sum +
        occurrencesInPeriod(stream, addDays(asOf, 1), periodEnd).length * stream.amount
      );
    }, 0);

    const periodIncome = incomeReceived + incomeExpected;

    const recurringKeys = new Set(expenseStreams.map((stream) => stream.key));
    const commitmentRows = [];

    expenseStreams.forEach((stream) => {
      occurrencesInPeriod(stream, periodStart, periodEnd).forEach((date) => {
        commitmentRows.push({
          title: stream.merchant,
          amount: stream.amount,
          date,
          source: "recurring"
        });
      });
    });

    billDueDatesInPeriod(config.bills, periodStart, periodEnd).forEach((due) => {
      // Skip bills that already match a detected recurring stream by amount+near date.
      const duplicate = commitmentRows.some(
        (row) =>
          amountsAreSimilar(row.amount, due.amount) &&
          Math.abs(daysBetween(row.date, due.date)) <= 3
      );
      if (!duplicate) commitmentRows.push(due);
    });

    const committed = commitmentRows.reduce((sum, row) => sum + row.amount, 0);

    const variableAlreadySpent = effectiveTransactions
      .filter(
        (tx) =>
          tx.direction === "out" &&
          isInRange(tx.date, periodStart, addDays(asOf, 1)) &&
          !recurringKeys.has(streamKey(tx.merchant, "out"))
      )
      .reduce((sum, tx) => sum + tx.amount, 0);

    const horizonDays = Math.max(
      1,
      Math.round((periodEnd.getTime() - periodStart.getTime()) / DAY_MS)
    );
    const savingsTarget =
      (Number(config.weeklySavingsTarget) || 0) * (horizonDays / 7);

    const remaining =
      periodIncome - committed - savingsTarget - variableAlreadySpent;

    return {
      period: `${toDateString(periodStart)} / ${toDateString(addDays(periodEnd, -1))}`,
      periodSource: source,
      nextPayday,
      horizonDays,
      income: roundMoney(periodIncome),
      incomeReceived: roundMoney(incomeReceived),
      incomeExpected: roundMoney(incomeExpected),
      // Back-compat for older shelf/phone payloads.
      weeklyIncome: roundMoney(periodIncome),
      committed: roundMoney(committed),
      commitments: commitmentRows
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((row) => ({
          ...row,
          amount: roundMoney(row.amount)
        })),
      savingsTarget: roundMoney(savingsTarget),
      spent: roundMoney(variableAlreadySpent),
      remaining: roundMoney(remaining),
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
      bills: suppliedConfig?.bills || DEFAULT_CONFIG.bills,
      asOfDate: suppliedConfig?.asOfDate || DEFAULT_CONFIG.asOfDate || todayIso(),
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

    const holdingBreakdown = {};
    const totals = Object.entries(balances).reduce(
      (result, [account, balance]) => {
        const type = config.accountTypes[account];
        const allocated = allocateAccountTotals(
          account,
          balance,
          type,
          config.accountHoldings
        );
        result.liquid += allocated.liquid;
        result.invested += allocated.invested;
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

    const safe = computeSafeToSpend(effectiveTransactions, config);
    const recurring = safe.expenseStreams.map((stream) => ({
      merchant: stream.merchant,
      key: stream.key,
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
      balances,
      holdingBreakdown,
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
        period: safe.period,
        periodSource: safe.periodSource,
        nextPayday: safe.nextPayday,
        horizonDays: safe.horizonDays,
        income: safe.income,
        incomeReceived: safe.incomeReceived,
        incomeExpected: safe.incomeExpected,
        weeklyIncome: safe.weeklyIncome,
        committed: safe.committed,
        commitments: safe.commitments,
        savingsTarget: safe.savingsTarget,
        spent: safe.spent,
        remaining: safe.remaining
      }
    };
  }

  return {
    DEFAULT_CONFIG,
    SAMPLE_FIXTURE,
    computeSnapshot,
    detectRecurring,
    detectRecurringStreams,
    payPeriodBounds,
    weekBounds,
    accountActivityDelta,
    openingFromRemoteBalance,
    isCashLikeHolding,
    normalizeHoldings,
    splitBalanceByHoldings,
    todayIso
  };
});
