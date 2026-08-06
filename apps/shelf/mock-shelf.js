/**
 * mock-shelf.js — browser shim for window.Shelf
 *
 * Installs only when a real Shelf bridge is absent. Shape matches the real
 * Android WebView contract so app HTML stays identical in both environments.
 * No fetch, no network, no credentials — sample data is embedded.
 */
(function (root) {
  "use strict";

  if (root.Shelf && root.Shelf.__real) return;
  if (root.Shelf && root.Shelf.__mock) return;

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

  // Sample covers: income, ordinary expenses, checking→savings, Vanguard buy
  // (transfer), ambiguous Venmo (needsReview), outside-payments external expense,
  // reimbursement transfer, and recurring Netflix/Spotify.
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

  const memoryFs = Object.create(null);
  const outbox = [];
  const transactionOverrides = Object.create(null);
  const mockSettings = {
    asOfDate: "2026-08-05",
    monthlyIncome: 5200,
    weeklyIncome: 5200 / 4.345,
    weeklySavingsTarget: 300
  };
  // Stands in for the transactions the encrypted digest/snapshot would carry
  // down to the device. Set to null to exercise the "no synced data" path.
  const syncedSnapshot = { transactions: SAMPLE_TRANSACTIONS };
  const shareListeners = [];
  const appUrlListeners = [];
  let imageSeq = 0;

  const Shelf = {
    __mock: true,
    __version: 1,

    data: {
      get(kind, opts) {
        void opts;
        if (kind === "transactions") {
          // Device contract: transactions are only whatever the encrypted
          // digest/snapshot supplied. With no synced snapshot the value is null.
          if (!syncedSnapshot) return ok(null);
          const transactions = (root.MoneyRules
            ? root.MoneyRules.normalizeTransactions(syncedSnapshot.transactions)
            : syncedSnapshot.transactions
          ).map((row) => ({ ...row, ...(transactionOverrides[row.id] || {}) }));
          return ok({
            kind: "transactions",
            transactions,
            asOfDate: mockSettings.asOfDate,
            settings: {
              monthlyIncome: mockSettings.monthlyIncome,
              weeklyIncome: mockSettings.weeklyIncome,
              weeklySavingsTarget: mockSettings.weeklySavingsTarget
            }
          });
        }
        if (kind === "digest") {
          return ok({ kind: "digest", today: [], reading: [], junk: [] });
        }
        if (kind === "snapshot") {
          if (!syncedSnapshot) return ok(null);
          if (!root.MoneyRules || !root.MoneyModel) {
            return fail("NOT_READY", "Money engine has not loaded");
          }
          const snapshot = root.MoneyModel.computeSnapshot(
            root.MoneyRules.normalizeTransactions(syncedSnapshot.transactions).map((row) => ({
              ...row,
              ...(transactionOverrides[row.id] || {})
            })),
            mockSettings
          );
          return ok({
            kind: "snapshot",
            netWorth: snapshot.netWorth,
            liquid: snapshot.liquid,
            invested: snapshot.invested,
            savingsRatePct: Math.round(snapshot.savingsRate * 1000) / 10,
            recurringMonthly: snapshot.recurringMonthly,
            runwayMonths: Math.round(snapshot.runwayMonths * 10) / 10,
            owed: snapshot.owed,
            expenses: snapshot.expenses,
            spendingByCategory: snapshot.spendingByCategory,
            recurring: snapshot.recurring,
            balances: snapshot.balances,
            safeToSpend: {
              period: snapshot.safeToSpend.period,
              amount: snapshot.safeToSpend.remaining,
              weeklyIncome: snapshot.safeToSpend.weeklyIncome,
              committed: snapshot.safeToSpend.committed,
              savingsTarget: snapshot.safeToSpend.savingsTarget,
              spent: snapshot.safeToSpend.spent,
              remaining: snapshot.safeToSpend.remaining
            },
            flags: []
          });
        }
        if (kind === "accounts") {
          return ok({
            kind: "accounts",
            accounts: [
              { id: "checking", label: "Checking", type: "cash", openingBalance: 6200, simplefinAccountId: null },
              { id: "savings", label: "Savings", type: "cash", openingBalance: 12000, simplefinAccountId: null },
              { id: "vanguard", label: "Vanguard", type: "investment", openingBalance: 28000, simplefinAccountId: null },
              { id: "outside-payments", label: "Outside payments", type: "external", openingBalance: 0, simplefinAccountId: null }
            ]
          });
        }
        return fail("UNKNOWN_KIND", `Unknown data kind: ${kind}`);
      }
    },

    accounts: {
      list() {
        return Shelf.data.get("accounts").then((payload) => payload.accounts || []);
      },
      create() {
        return fail("HUB_ONLY", "Creating accounts requires the laptop hub");
      },
      update() {
        return fail("HUB_ONLY", "Updating accounts requires the laptop hub");
      }
    },

    import: {
      text() {
        return fail("HUB_ONLY", "Import requires the laptop hub");
      }
    },

    contacts: {
      list() {
        return ok([
          { id: "c1", name: "A. Rivera", month: 8, day: 6 }
        ]);
      }
    },

    sms: {
      query({ sinceId } = {}) {
        void sinceId;
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
        return ok({
          text: "",
          blocks: [],
          imageRef
        });
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

    // secure.* rejects on purpose: returning tokens would expose them to the
    // WebView. Configure tokens in Connect and reach them via Net.call.
    secure: {
      get() {
        return fail("SECURE_DISABLED", "Shelf.secure is disabled; configure tokens in Connect and use Net.call");
      },
      set() {
        return fail("SECURE_DISABLED", "Shelf.secure is disabled; configure tokens in Connect and use Net.call");
      },
      delete() {
        return fail("SECURE_DISABLED", "Shelf.secure is disabled; configure tokens in Connect and use Net.call");
      }
    },

    // Desktop mock has no Connect store. Real phone Shelf implements Net.call.
    Net: {
      call() {
        return fail("NET_NATIVE_ONLY", "Net.call requires the native Shelf Connect store");
      }
    },

    ai: {
      mode() {
        return ok({ mode: "OFF" });
      },
      setMode() {
        return fail("AI_HUB_ONLY", "AI mode changes require the laptop hub");
      },
      propose() {
        return fail("AI_HUB_ONLY", "AI propose requires the laptop hub");
      },
      proposals() {
        return ok({ proposals: [] });
      }
    },

    outbox: {
      push(items) {
        const list = Array.isArray(items) ? items : [items];
        list.forEach((item) => {
          outbox.push(item);
          if (item?.type === "action.transaction.update" && item.data?.id) {
            transactionOverrides[item.data.id] = { ...item.data };
          }
          if (item?.type === "action.settings.update" && item.data) {
            Object.assign(mockSettings, item.data);
          }
        });
        return ok({ queued: list.length, total: outbox.length });
      },
      /** Mock-only helper for tests; real Shelf has no peek. */
      __peek() {
        return outbox.slice();
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
