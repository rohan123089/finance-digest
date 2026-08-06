/**
 * mock-shelf.js — offline Shelf (no hub required)
 *
 * Installs when a real native Shelf bridge is absent. Persists to localStorage
 * so downloading shelf.html and opening it (file:// or any browser) works alone.
 * Hub is optional: hub-shelf.js may upgrade this when /api/health is reachable.
 */
(function (root) {
  "use strict";

  if (root.Shelf && root.Shelf.__real && !root.Shelf.__mock) return;
  if (root.Shelf && root.Shelf.__mock && root.Shelf.__standalone) return;

  function shelfError(code, message) {
    const err = new Error(message);
    err.code = code;
    err.shelf = true;
    return err;
  }

  function ok(value) {
    return Promise.resolve(value);
  }

  function fail(code, message) {
    return Promise.reject(shelfError(code, message));
  }

  const STORE_KEY = "shelf-offline-v1";

  const SAMPLE_TRANSACTIONS = [
    { id: "tx-001", date: "2026-06-01", rawMerchant: "ACME PAYROLL 0601", amount: 5200, account: "checking" },
    { id: "tx-002", date: "2026-06-02", rawMerchant: "JUNE RENT", amount: 1650, account: "checking" },
    { id: "tx-003", date: "2026-06-04", rawMerchant: "NETFLIX.COM", amount: 15.49, account: "checking" },
    { id: "tx-004", date: "2026-06-07", rawMerchant: "SPOTIFY USA", amount: 11.99, account: "checking" },
    { id: "tx-005", date: "2026-06-10", rawMerchant: "TRADER JOE'S #431", amount: 82.64, account: "checking" },
    { id: "tx-006", date: "2026-06-14", rawMerchant: "CORNER COFFEE", amount: 6.75, account: "checking" },
    { id: "tx-007", date: "2026-06-18", rawMerchant: "VANGUARD BUY VTSAX", amount: 600, account: "checking" },
    { id: "tx-008", date: "2026-06-23", rawMerchant: "TRANSFER TO SAVINGS", amount: 400, account: "checking" },
    { id: "tx-009", date: "2026-07-01", rawMerchant: "ACME PAYROLL 0701", amount: 5200, account: "checking" },
    { id: "tx-010", date: "2026-07-02", rawMerchant: "JULY RENT", amount: 1650, account: "checking" },
    { id: "tx-011", date: "2026-07-04", rawMerchant: "NETFLIX.COM", amount: 15.49, account: "checking" },
    { id: "tx-012", date: "2026-07-07", rawMerchant: "SPOTIFY USA", amount: 11.99, account: "checking" },
    { id: "tx-013", date: "2026-07-11", rawMerchant: "TRADER JOE'S #431", amount: 91.22, account: "checking" },
    { id: "tx-014", date: "2026-07-16", rawMerchant: "SHELL OIL 5742", amount: 48.31, account: "checking" },
    { id: "tx-015", date: "2026-07-21", rawMerchant: "CVS PHARMACY #188", amount: 23.8, account: "checking" },
    { id: "tx-016", date: "2026-07-24", rawMerchant: "CHIPOTLE OUTSIDE PAYMENT", amount: 86.25, account: "outside-payments" },
    { id: "tx-017", date: "2026-07-28", rawMerchant: "OUTSIDE PAYMENT REIMBURSEMENT", amount: 50, account: "checking" },
    { id: "tx-018", date: "2026-08-03", rawMerchant: "ACME PAYROLL 0803", amount: 5200, account: "checking" },
    { id: "tx-019", date: "2026-08-02", rawMerchant: "AUGUST RENT", amount: 1650, account: "checking" },
    { id: "tx-020", date: "2026-08-04", rawMerchant: "NETFLIX.COM", amount: 15.49, account: "checking" },
    { id: "tx-021", date: "2026-08-05", rawMerchant: "SPOTIFY USA", amount: 11.99, account: "checking" },
    { id: "tx-022", date: "2026-08-05", rawMerchant: "WHOLE FOODS MARKET", amount: 63.17, account: "checking" },
    { id: "tx-023", date: "2026-08-05", rawMerchant: "CHIPOTLE 2219", amount: 14.28, account: "checking" },
    { id: "tx-024", date: "2026-08-05", rawMerchant: "VENMO PAYMENT 8831", amount: 72, account: "checking" },
    { id: "tx-025", date: "2026-08-05", rawMerchant: "LANDMARK CINEMA", amount: 18.5, account: "checking" }
  ];

  const DEFAULT_BILLS = [
    {
      id: "bill:rent",
      title: "Rent",
      amount: 1650,
      dueDay: 1,
      leadDays: 5,
      category: "housing",
      active: true,
      lastPaidFor: null,
      notes: ""
    },
    {
      id: "bill:utilities",
      title: "Utilities",
      amount: 120,
      dueDay: 15,
      leadDays: 3,
      category: "utilities",
      active: true,
      lastPaidFor: null,
      notes: ""
    }
  ];

  const DEFAULT_ACCOUNTS = [
    { id: "checking", label: "Checking", type: "cash", openingBalance: 6200, simplefinAccountId: null },
    { id: "savings", label: "Savings", type: "cash", openingBalance: 12000, simplefinAccountId: null },
    { id: "vanguard", label: "Vanguard", type: "investment", openingBalance: 28000, simplefinAccountId: null },
    { id: "outside-payments", label: "Outside payments", type: "external", openingBalance: 0, simplefinAccountId: null }
  ];

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  function defaultState() {
    return {
      transactions: SAMPLE_TRANSACTIONS.map((row) => ({ ...row })),
      overrides: {},
      settings: {
        asOfDate: todayIso(),
        weeklySavingsTarget: 300,
        monthlyIncome: 5200,
        weeklyIncome: 1200,
        openingBalances: {
          checking: 6200,
          savings: 12000,
          vanguard: 28000,
          "outside-payments": 0
        },
        accountTypes: {
          checking: "cash",
          savings: "cash",
          vanguard: "investment",
          "outside-payments": "external"
        }
      },
      bills: DEFAULT_BILLS.map((b) => ({ ...b })),
      accounts: DEFAULT_ACCOUNTS.map((a) => ({ ...a })),
      watching: [],
      reading: [
        {
          id: "read:demo",
          title: "Offline Shelf works without the hub",
          url: "#offline",
          source: "demo",
          rank: 1
        }
      ],
      junk: [],
      outbox: []
    };
  }

  function loadState() {
    try {
      const raw = root.localStorage?.getItem(STORE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const base = defaultState();
      return {
        ...base,
        ...parsed,
        settings: { ...base.settings, ...(parsed.settings || {}) },
        bills: Array.isArray(parsed.bills) ? parsed.bills : base.bills,
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : base.accounts,
        transactions: Array.isArray(parsed.transactions)
          ? parsed.transactions
          : base.transactions,
        overrides: parsed.overrides || {},
        watching: parsed.watching || [],
        reading: parsed.reading || base.reading,
        junk: parsed.junk || [],
        outbox: parsed.outbox || []
      };
    } catch (_error) {
      return defaultState();
    }
  }

  function saveState() {
    try {
      root.localStorage?.setItem(STORE_KEY, JSON.stringify(state));
    } catch (_error) {
      // private mode / quota — keep in-memory
    }
  }

  let state = loadState();
  const memoryFs = Object.create(null);
  const shareListeners = [];
  const appUrlListeners = [];
  let imageSeq = 0;
  let aiMode = "LOCAL";

  function liveTransactions() {
    const rows = state.transactions.map((row) => ({
      ...row,
      ...(state.overrides[row.id] || {})
    }));
    return root.MoneyRules
      ? root.MoneyRules.normalizeTransactions(rows)
      : rows;
  }

  function buildSnapshot() {
    if (!root.MoneyRules || !root.MoneyModel) {
      throw shelfError("NOT_READY", "Money engine has not loaded");
    }
    const snapshot = root.MoneyModel.computeSnapshot(liveTransactions(), state.settings);
    return {
      kind: "snapshot",
      netWorth: snapshot.netWorth,
      liquid: snapshot.liquid,
      invested: snapshot.invested,
      savingsRatePct: Math.round(snapshot.savingsRate * 1000) / 10,
      recurringMonthly: snapshot.recurringMonthly,
      runwayMonths: Math.round(snapshot.runwayMonths * 10) / 10,
      owed: snapshot.owed,
      expenses: snapshot.expenses,
      expensesThisMonth: snapshot.expensesThisMonth,
      spendingMonth: snapshot.spendingMonth,
      spendingByCategory: snapshot.spendingByCategory,
      recurring: snapshot.recurring,
      balances: snapshot.balances,
      safeToSpend: {
        period: snapshot.safeToSpend.period,
        periodSource: snapshot.safeToSpend.periodSource,
        nextPayday: snapshot.safeToSpend.nextPayday,
        horizonDays: snapshot.safeToSpend.horizonDays,
        amount: snapshot.safeToSpend.remaining,
        income: snapshot.safeToSpend.income,
        weeklyIncome: snapshot.safeToSpend.weeklyIncome,
        committed: snapshot.safeToSpend.committed,
        commitments: snapshot.safeToSpend.commitments,
        savingsTarget: snapshot.safeToSpend.savingsTarget,
        spent: snapshot.safeToSpend.spent,
        remaining: snapshot.safeToSpend.remaining
      },
      flags: []
    };
  }

  function buildDigest() {
    const asOf = state.settings.asOfDate || todayIso();
    const today = [];
    const billsApi = root.LifeBills;
    if (billsApi) {
      billsApi.upcomingReminders(state.bills, asOf).forEach((row) => {
        const id = `bill:${row.bill.id.replace(/^bill:/, "")}:${row.periodKey}`;
        today.push({
          kind: "bill",
          id,
          title: billsApi.reminderTitle(row),
          dueAt: row.dueAt,
          start: row.dueAt,
          domain: "personal",
          amount: row.bill.amount,
          daysUntil: row.daysUntil,
          overdue: row.overdue,
          actions: [
            {
              type: "bill.paid",
              targetRef: {
                itemId: id,
                billId: row.bill.id,
                periodKey: row.periodKey
              }
            },
            {
              type: "dismiss",
              targetRef: {
                itemId: id,
                billId: row.bill.id,
                periodKey: row.periodKey
              }
            }
          ]
        });
      });
    }
    const snap = (() => {
      try {
        return buildSnapshot();
      } catch (_e) {
        return null;
      }
    })();
    if (snap?.owed > 0) {
      today.push({
        kind: "task",
        id: "task:owed",
        title: `Reimburse outside payments · $${Number(snap.owed).toFixed(2)}`,
        actions: [{ type: "ack", targetRef: { itemId: "task:owed", reason: "owed" } }]
      });
    }
    return {
      kind: "digest",
      v: 1,
      generatedAt: new Date().toISOString(),
      asOfDate: asOf,
      today,
      watching: state.watching || [],
      reading: state.reading || [],
      junk: state.junk || []
    };
  }

  function applyOutboxItem(item) {
    if (!item?.type) return;
    if (item.type === "action.transaction.update" && item.data?.id) {
      state.overrides[item.data.id] = { ...item.data };
      return;
    }
    if (item.type === "action.settings.update" && item.data) {
      Object.assign(state.settings, item.data);
      return;
    }
    if (item.type === "action.bills.upsert" && item.data) {
      const bill = {
        id: item.data.id,
        title: item.data.title,
        amount: Number(item.data.amount) || 0,
        dueDay: Number(item.data.dueDay) || 1,
        leadDays: Number(item.data.leadDays != null ? item.data.leadDays : 3),
        category: item.data.category || "",
        active: item.data.active !== false,
        lastPaidFor: item.data.lastPaidFor || null,
        notes: item.data.notes || ""
      };
      const idx = state.bills.findIndex((b) => b.id === bill.id);
      if (idx >= 0) state.bills[idx] = { ...state.bills[idx], ...bill };
      else state.bills.push(bill);
      return;
    }
    if (item.type === "action.bills.delete" && item.data?.id) {
      state.bills = state.bills.filter((b) => b.id !== item.data.id);
      return;
    }
    if (
      (item.type === "action.bill.paid" || item.type === "action.bill.pay") &&
      item.data
    ) {
      const ref = item.data.targetRef || item.data;
      const billId = ref.billId;
      const period = ref.periodKey;
      if (billId) {
        const bill = state.bills.find((b) => b.id === billId);
        if (bill) bill.lastPaidFor = period || bill.lastPaidFor;
      }
      return;
    }
    if (item.type === "action.dismiss" && item.data?.targetRef?.billId) {
      const bill = state.bills.find((b) => b.id === item.data.targetRef.billId);
      if (bill) {
        bill.lastPaidFor =
          item.data.targetRef.periodKey || bill.lastPaidFor;
      }
      return;
    }
    if (
      (item.type === "action.rsvp.no" || item.type === "action.dismiss") &&
      item.data?.targetRef?.itemId
    ) {
      const id = item.data.targetRef.itemId;
      const fromToday = (buildDigest().today || []).find((row) => row.id === id);
      if (fromToday && fromToday.kind === "event") {
        state.watching = state.watching.filter((w) => w.id !== id);
        state.watching.push({
          ...fromToday,
          status: "declined"
        });
      }
    }
  }

  const Shelf = {
    __mock: true,
    __standalone: true,
    __version: 1,

    data: {
      get(kind) {
        if (kind === "transactions") {
          return ok({
            kind: "transactions",
            transactions: liveTransactions(),
            asOfDate: state.settings.asOfDate,
            settings: {
              monthlyIncome: state.settings.monthlyIncome,
              weeklyIncome: state.settings.weeklyIncome,
              weeklySavingsTarget: state.settings.weeklySavingsTarget
            },
            accounts: state.accounts
          });
        }
        if (kind === "digest") return ok(buildDigest());
        if (kind === "snapshot") {
          try {
            return ok(buildSnapshot());
          } catch (error) {
            return Promise.reject(error);
          }
        }
        if (kind === "accounts") {
          return ok({ kind: "accounts", accounts: state.accounts.slice() });
        }
        if (kind === "bills") {
          const asOf = state.settings.asOfDate || todayIso();
          const upcoming = root.LifeBills
            ? root.LifeBills.upcomingReminders(state.bills, asOf, { includeAll: true }).map(
                (row) => ({
                  billId: row.bill.id,
                  title: row.bill.title,
                  amount: row.bill.amount,
                  dueAt: row.dueAt,
                  periodKey: row.periodKey,
                  daysUntil: row.daysUntil,
                  overdue: row.overdue,
                  remind: row.remind,
                  label: root.LifeBills.reminderTitle(row)
                })
              )
            : [];
          return ok({ kind: "bills", bills: state.bills.slice(), upcoming });
        }
        if (kind === "rewards") {
          return Shelf.rewards.get();
        }
        return fail("UNKNOWN_KIND", `Unknown data kind: ${kind}`);
      }
    },

    accounts: {
      list() {
        return ok(state.accounts.slice());
      },
      create(account) {
        if (!account?.id) return fail("BAD_ACCOUNT", "id required");
        const row = {
          id: String(account.id),
          label: account.label || account.id,
          type: account.type || "cash",
          openingBalance: Number(account.openingBalance) || 0,
          simplefinAccountId: null
        };
        state.accounts.push(row);
        state.settings.accountTypes[row.id] = row.type;
        state.settings.openingBalances[row.id] = row.openingBalance;
        saveState();
        return ok({ ok: true, account: row });
      },
      update(id, patch) {
        const row = state.accounts.find((a) => a.id === id);
        if (!row) return fail("NOT_FOUND", "Account not found");
        Object.assign(row, patch || {});
        saveState();
        return ok({ ok: true, account: row });
      }
    },

    bills: {
      list() {
        return Shelf.data.get("bills");
      },
      create(bill) {
        const id =
          bill.id ||
          `bill:${String(bill.title || "bill")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")}`;
        applyOutboxItem({
          type: "action.bills.upsert",
          data: { ...bill, id, active: bill.active !== false }
        });
        saveState();
        return ok({ ok: true, bill: state.bills.find((b) => b.id === id) });
      },
      update(id, patch) {
        const existing = state.bills.find((b) => b.id === id);
        if (!existing) return fail("NOT_FOUND", "Bill not found");
        if (patch?.paid === true || patch?.markPaid === true) {
          const asOf = state.settings.asOfDate || todayIso();
          const next = root.LifeBills
            ? root.LifeBills.nextDueForBill(existing, asOf)
            : { periodKey: asOf.slice(0, 7) };
          existing.lastPaidFor = patch.periodKey || next.periodKey;
          saveState();
          return ok({ ok: true, bill: existing });
        }
        applyOutboxItem({
          type: "action.bills.upsert",
          data: { ...existing, ...patch, id }
        });
        saveState();
        return ok({ ok: true, bill: state.bills.find((b) => b.id === id) });
      },
      remove(id) {
        applyOutboxItem({ type: "action.bills.delete", data: { id } });
        saveState();
        return ok({ ok: true });
      }
    },

    import: {
      text() {
        return fail(
          "OFFLINE",
          "CSV import needs the laptop hub — offline mode uses sample / edited data"
        );
      },
      list() {
        return ok({ kind: "imports", batches: [] });
      },
      undo() {
        return fail("OFFLINE", "Undo import requires the laptop hub");
      }
    },

    rewards: {
      get() {
        return ok({
          kind: "rewards",
          pointers: [],
          activeOffers: [],
          byCategory: [],
          totals: { spend: 0, actualEarn: 0, bestEarn: 0, missedUsd: 0 },
          rules: [],
          offers: []
        });
      },
      optimize() {
        return Shelf.rewards.get();
      },
      refresh() {
        return fail("OFFLINE", "Rewards refresh requires the laptop hub");
      },
      saveOffer() {
        return fail("OFFLINE", "Saving offers requires the laptop hub");
      },
      saveRule() {
        return fail("OFFLINE", "Saving rules requires the laptop hub");
      }
    },

    contacts: {
      list() {
        return ok([{ id: "c1", name: "A. Rivera", month: 8, day: 6 }]);
      }
    },

    sms: {
      query() {
        return ok({ messages: [], latestId: null });
      }
    },

    camera: {
      capture() {
        imageSeq += 1;
        const imageRef = `mock-img-${imageSeq}`;
        memoryFs[`attachments/${imageRef}`] = { type: "image/mock", bytes: null };
        return ok({ imageRef });
      }
    },

    ocr: {
      recognize(imageRef) {
        if (!imageRef) return fail("BAD_REF", "imageRef required");
        return ok({ text: "", blocks: [], imageRef });
      }
    },

    fs: {
      read(path) {
        if (!(path in memoryFs)) return fail("NOT_FOUND", `No such path: ${path}`);
        return ok(memoryFs[path]);
      },
      write(path, data) {
        memoryFs[path] = data;
        return ok({ path, bytes: typeof data === "string" ? data.length : 0 });
      }
    },

    secure: {
      get() {
        return fail("SECURE_DISABLED", "Shelf.secure is disabled");
      },
      set() {
        return fail("SECURE_DISABLED", "Shelf.secure is disabled");
      },
      delete() {
        return fail("SECURE_DISABLED", "Shelf.secure is disabled");
      }
    },

    Net: {
      call() {
        return fail("NET_NATIVE_ONLY", "Net.call requires native Shelf Connect");
      }
    },

    ai: {
      mode() {
        return ok({ mode: aiMode });
      },
      setMode(mode) {
        aiMode = mode || "OFF";
        return ok({ mode: aiMode });
      },
      propose() {
        if (aiMode === "OFF") return ok({ mode: "OFF", proposal: null });
        try {
          const snap = buildSnapshot();
          const flags = [];
          if (snap.owed > 0) {
            flags.push({
              id: "flag-owed",
              trigger: "owed",
              why: "Outside payments balance",
              action: "Collect reimbursement",
              value: snap.owed,
              deadline: null,
              confidence: 0.8
            });
          }
          if ((snap.safeToSpend?.remaining || 0) < 0) {
            flags.push({
              id: "flag-safe",
              trigger: "safeToSpend",
              why: "Safe-to-spend is negative",
              action: "Cut discretionary spend this period",
              value: snap.safeToSpend.remaining,
              deadline: null,
              confidence: 0.75
            });
          }
          return ok({
            mode: "LOCAL",
            proposal: { summary: "Offline local nudges", flags, mutations: [] }
          });
        } catch (error) {
          return Promise.reject(error);
        }
      },
      proposals() {
        return ok({ proposals: [] });
      }
    },

    outbox: {
      push(items) {
        const list = Array.isArray(items) ? items : [items];
        list.forEach((item) => {
          state.outbox.push(item);
          applyOutboxItem(item);
        });
        saveState();
        return ok({ queued: list.length, total: state.outbox.length });
      },
      __peek() {
        return state.outbox.slice();
      }
    },

    notify({ title, body } = {}) {
      return ok({ delivered: false, title: title || "", body: body || "", mock: true });
    },

    onShare(cb) {
      if (typeof cb === "function") shareListeners.push(cb);
      return ok({ listening: true });
    },

    onAppUrl(cb) {
      if (typeof cb === "function") appUrlListeners.push(cb);
      return ok({ listening: true });
    }
  };

  root.Shelf = Shelf;
})(typeof globalThis !== "undefined" ? globalThis : this);
