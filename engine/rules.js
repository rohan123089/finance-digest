(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MoneyRules = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Legacy sample ids + starter registry ids. Prefer DB accountTypes at runtime.
  const ACCOUNT_TYPES = {
    checking: "cash",
    savings: "cash",
    "uwcu-checking": "cash",
    "uwcu-savings": "cash",
    vanguard: "investment",
    amex: "liability",
    discover: "liability",
    "outside-payments": "external"
  };

  // First match wins. Edit this table to change categorization.
  const CATEGORY_RULES = [
    { contains: "payroll", category: "income" },
    { contains: "trader joe", category: "groceries" },
    { contains: "whole foods", category: "groceries" },
    { contains: "shell", category: "transportation" },
    { contains: "uber", category: "transportation" },
    { contains: "netflix", category: "subscriptions" },
    { contains: "spotify", category: "subscriptions" },
    { contains: "rent", category: "housing" },
    { contains: "electric", category: "utilities" },
    { contains: "water", category: "utilities" },
    { contains: "chipotle", category: "dining" },
    { contains: "coffee", category: "dining" },
    { contains: "cvs", category: "health" },
    { contains: "bookshop", category: "shopping" },
    { contains: "cinema", category: "entertainment" }
  ];

  const TYPING_RULES = [
    { contains: "payroll", direction: "in", merchant: "Employer Payroll" },
    {
      contains: "transfer to savings",
      direction: "transfer",
      merchant: "Savings Transfer",
      transferAccount: "savings"
    },
    {
      contains: "vanguard buy",
      direction: "transfer",
      merchant: "Vanguard",
      transferAccount: "vanguard"
    },
    {
      contains: "outside payment reimbursement",
      direction: "transfer",
      merchant: "Outside Payments Reimbursement",
      transferAccount: "outside-payments"
    },
    {
      contains: "parents reimbursement",
      direction: "transfer",
      merchant: "Outside Payments Reimbursement",
      transferAccount: "outside-payments"
    }
  ];

  const AMBIGUOUS_MERCHANTS = ["venmo", "paypal", "cash app", "zelle"];

  const VALID_ACCOUNT_TYPES = new Set([
    "cash",
    "investment",
    "liability",
    "external"
  ]);

  function cleanMerchant(rawMerchant) {
    return String(rawMerchant || "")
      .replace(/\s+#?\d{3,}$/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function findSubstringRule(value, rules) {
    const normalized = String(value || "").toLowerCase();
    return rules.find((rule) => {
      const phrase = rule.contains.toLowerCase();
      const start = normalized.indexOf(phrase);
      if (start === -1) return false;
      const before = normalized[start - 1] || "";
      const after = normalized[start + phrase.length] || "";
      return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
    });
  }

  function categoryFor(merchant) {
    const match = findSubstringRule(merchant, CATEGORY_RULES);
    return match ? match.category : "uncategorized";
  }

  function resolveAccountTypes(override) {
    if (override && typeof override === "object" && Object.keys(override).length) {
      return override;
    }
    return ACCOUNT_TYPES;
  }

  function normalizeTransaction(raw, accountTypesOverride) {
    const accountTypes = resolveAccountTypes(accountTypesOverride);
    const typingRule = findSubstringRule(raw.rawMerchant, TYPING_RULES);
    const ambiguous = AMBIGUOUS_MERCHANTS.some((name) =>
      String(raw.rawMerchant || "").toLowerCase().includes(name)
    );
    const accountType = accountTypes[raw.account];
    if (!accountType) throw new Error(`Unknown account: ${raw.account}`);
    if (!VALID_ACCOUNT_TYPES.has(accountType)) {
      throw new Error(`Invalid account type for ${raw.account}: ${accountType}`);
    }

    let direction = typingRule ? typingRule.direction : "out";
    if (ambiguous && !typingRule) direction = "";

    // Prefer an explicit direction hint from import/SimpleFIN when not ambiguous.
    if (!typingRule && !ambiguous && raw.directionHint) {
      const hint = String(raw.directionHint);
      if (hint === "in" || hint === "out" || hint === "transfer") direction = hint;
    }

    const merchant = typingRule?.merchant || cleanMerchant(raw.rawMerchant);
    const savingsHint =
      accountTypes.savings
        ? "savings"
        : accountTypes["uwcu-savings"]
          ? "uwcu-savings"
          : "";

    return {
      id: String(raw.id),
      account: raw.account,
      accountType,
      direction,
      category: direction && direction !== "transfer" ? categoryFor(merchant) : "",
      merchant,
      amount: Math.abs(Number(raw.amount)),
      date: raw.date,
      needsReview:
        ambiguous || (!typingRule && direction !== "out" && direction !== "in"),
      transferAccount: typingRule?.transferAccount || "",
      suggestedTransferAccount: ambiguous ? savingsHint : ""
    };
  }

  function normalizeTransactions(rows, accountTypesOverride) {
    return rows.map((row) => normalizeTransaction(row, accountTypesOverride));
  }

  return {
    ACCOUNT_TYPES,
    VALID_ACCOUNT_TYPES,
    CATEGORY_RULES,
    TYPING_RULES,
    AMBIGUOUS_MERCHANTS,
    categoryFor,
    cleanMerchant,
    normalizeTransaction,
    normalizeTransactions
  };
});
