(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MoneyRules = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Bump when category rules change so the hub re-applies offline labels.
  const CATEGORY_RULES_VERSION = 3;

  // Legacy sample ids + starter registry ids. Prefer DB accountTypes at runtime.
  const ACCOUNT_TYPES = {
    checking: "cash",
    savings: "cash",
    "uwcu-checking": "cash",
    "uwcu-savings": "cash",
    vanguard: "investment",
    "vanguard-brokerage": "investment",
    amex: "liability",
    discover: "liability",
    "outside-payments": "external"
  };

  /**
   * Brand / keyword rules. First match wins.
   * Matching runs on a normalized merchant string (prefixes stripped).
   * Soft word boundaries: refuse alphanumeric before the phrase; after is
   * allowed when the phrase is long enough (handles CAFEDOWNERS glue).
   */
  const CATEGORY_RULES = [
    { contains: "payroll", category: "income" },

    // Groceries
    { contains: "trader joe", category: "groceries" },
    { contains: "whole foods", category: "groceries" },
    { contains: "pete's fresh", category: "groceries" },
    { contains: "petes fresh", category: "groceries" },
    { contains: "pikeplacemark", category: "groceries" },
    { contains: "pike place", category: "groceries" },
    { contains: "365 market", category: "groceries" },
    { contains: "safeway", category: "groceries" },
    { contains: "kroger", category: "groceries" },
    { contains: "costco", category: "groceries" },
    { contains: "aldi", category: "groceries" },

    // Dining / cafes / chains
    { contains: "chipotle", category: "dining" },
    { contains: "qdoba", category: "dining" },
    { contains: "starbucks", category: "dining" },
    { contains: "culver", category: "dining" },
    { contains: "sbarro", category: "dining" },
    { contains: "potbelly", category: "dining" },
    { contains: "mcdonald", category: "dining" },
    { contains: "manchu wok", category: "dining" },
    { contains: "ben & jerry", category: "dining" },
    { contains: "ben and jerry", category: "dining" },
    { contains: "doordash", category: "dining" },
    { contains: "ubereats", category: "dining" },
    { contains: "uber eats", category: "dining" },
    { contains: "grubhub", category: "dining" },
    { contains: "coffee", category: "dining" },
    { contains: "cafe", category: "dining", loose: true },
    { contains: "crêpe", category: "dining", loose: true },
    { contains: "crepe", category: "dining", loose: true },
    { contains: "taqueria", category: "dining" },
    { contains: "taco", category: "dining", loose: true },
    { contains: "burger", category: "dining", loose: true },
    { contains: "pizza", category: "dining" },
    { contains: "sushi", category: "dining" },
    { contains: "bakery", category: "dining" },
    { contains: "bistro", category: "dining" },
    { contains: "diner", category: "dining" },
    { contains: "kitchen", category: "dining" },
    { contains: "grill", category: "dining" },
    { contains: "patiss", category: "dining" },
    { contains: "gelat", category: "dining", loose: true },
    { contains: "cantine", category: "dining" },
    { contains: "canteen", category: "dining" },
    { contains: "deli", category: "dining" },
    { contains: "seafood", category: "dining" },
    { contains: "seafoo", category: "dining", loose: true },
    { contains: "tamales", category: "dining" },
    { contains: "crumpet", category: "dining" },
    { contains: "thai", category: "dining" },
    { contains: "ramen", category: "dining" },
    { contains: "noodle", category: "dining" },
    { contains: "bagel", category: "dining" },
    { contains: "donut", category: "dining" },
    { contains: "doughnut", category: "dining" },
    { contains: "ice cream", category: "dining" },
    { contains: "smoothie", category: "dining" },
    { contains: "brew", category: "dining" },
    { contains: "wine", category: "dining" },
    { contains: "bar ", category: "dining" },
    { contains: "lounge", category: "dining" },
    { contains: "restaurant", category: "dining" },

    // Transportation / transit / fuel / rides (before generic grocery "qfc")
    { contains: "shell", category: "transportation" },
    { contains: "exxonmobil", category: "transportation" },
    { contains: "exxon", category: "transportation", loose: true },
    { contains: "mobil", category: "transportation", loose: true },
    { contains: "bp#", category: "transportation", loose: true },
    { contains: "bp ", category: "transportation" },
    { contains: "chevron", category: "transportation" },
    { contains: "qfc fuel", category: "transportation" },
    { contains: "qfc", category: "groceries" },
    { contains: "uber", category: "transportation" },
    { contains: "lyft", category: "transportation" },
    { contains: "freenow", category: "transportation" },
    { contains: "orca", category: "transportation" },
    { contains: "ventra", category: "transportation" },
    { contains: "nyct", category: "transportation" },
    { contains: "lirr", category: "transportation" },
    { contains: "njt rail", category: "transportation" },
    { contains: "clipper", category: "transportation" },
    { contains: "wsferries", category: "transportation" },
    { contains: "ferry", category: "transportation" },
    { contains: "spot hero", category: "transportation" },
    { contains: "spothero", category: "transportation" },
    { contains: "parking", category: "transportation" },
    { contains: "turo", category: "transportation" },
    { contains: "discount-tire", category: "transportation" },
    { contains: "discount tire", category: "transportation" },
    { contains: "aaa ", category: "transportation" },
    { contains: "roadside", category: "transportation" },
    { contains: "flughafen", category: "travel" },
    { contains: "airport", category: "travel" },

    // Travel (lodging / flights / booking)
    { contains: "airbnb", category: "travel" },
    { contains: "hotel", category: "travel" },
    { contains: "marriott", category: "travel" },
    { contains: "hilton", category: "travel" },
    { contains: "hyatt", category: "travel" },
    { contains: "united airlines", category: "travel" },
    { contains: "american airlines", category: "travel" },
    { contains: "delta air", category: "travel" },
    { contains: "southwest air", category: "travel" },
    { contains: "jetblue", category: "travel" },
    { contains: "alaska air", category: "travel" },
    { contains: "lufthansa", category: "travel" },
    { contains: "deutsche luft", category: "travel" },
    { contains: "edreams", category: "travel" },
    { contains: "expedia", category: "travel" },
    { contains: "booking.com", category: "travel" },
    { contains: "kayak", category: "travel" },

    // Housing / utilities
    { contains: "rent", category: "housing" },
    { contains: "electric", category: "utilities" },
    { contains: "water", category: "utilities" },
    { contains: "comcast", category: "utilities" },
    { contains: "xfinity", category: "utilities" },
    { contains: "verizon", category: "utilities" },
    { contains: "at&t", category: "utilities" },
    { contains: "t-mobile", category: "utilities" },

    // Subscriptions / software
    { contains: "netflix", category: "subscriptions" },
    { contains: "spotify", category: "subscriptions" },
    { contains: "hulu", category: "subscriptions" },
    { contains: "disney+", category: "subscriptions" },
    { contains: "youtube", category: "subscriptions" },
    { contains: "nytimes", category: "subscriptions" },
    { contains: "ny times", category: "subscriptions" },
    { contains: "openai", category: "subscriptions" },
    { contains: "chatgpt", category: "subscriptions" },
    { contains: "anthropic", category: "subscriptions" },
    { contains: "claude", category: "subscriptions" },
    { contains: "cursor", category: "subscriptions" },
    { contains: "github", category: "subscriptions" },
    { contains: "adobe", category: "subscriptions" },
    { contains: "apple.com/bill", category: "subscriptions" },
    { contains: "google*youtube", category: "subscriptions" },

    // Health
    { contains: "cvs", category: "health" },
    { contains: "walgreens", category: "health" },
    { contains: "pharmacy", category: "health" },
    { contains: "apothecary", category: "health" },
    { contains: "rite aid", category: "health" },

    // Shopping
    { contains: "target", category: "shopping" },
    { contains: "walmart", category: "shopping" },
    { contains: "amazon", category: "shopping" },
    { contains: "amz*", category: "shopping", loose: true },
    { contains: "michaels", category: "shopping" },
    { contains: "gamestop", category: "shopping" },
    { contains: "fabletics", category: "shopping" },
    { contains: "micro center", category: "shopping" },
    { contains: "best buy", category: "shopping" },
    { contains: "bookshop", category: "shopping" },
    { contains: "worn again", category: "shopping" },
    { contains: "empower*", category: "shopping", loose: true },

    // Entertainment
    { contains: "cinemark", category: "entertainment" },
    { contains: "cinema", category: "entertainment" },
    { contains: "amc ", category: "entertainment" },
    { contains: "regal", category: "entertainment" },
    { contains: "wrigley", category: "entertainment" },
    { contains: "allstate aren", category: "entertainment", loose: true },
    { contains: "allstate arena", category: "entertainment" },
    { contains: "ticketmaster", category: "entertainment" },
    { contains: "american players", category: "entertainment" },
    { contains: "museum", category: "entertainment" },
    { contains: "zoo", category: "entertainment" },
    { contains: "plitvice", category: "entertainment" },

    // Fees (keep visible in diagnosis)
    { contains: "foreign transaction fee", category: "fees" },
    { contains: "late fee", category: "fees" },
    { contains: "interest charge", category: "fees" }
  ];

  // Regex heuristics after keyword miss — still fully offline.
  const CATEGORY_PATTERNS = [
    { category: "dining", pattern: /\btst\*/i },
    { category: "dining", pattern: /\bcafe\b/i },
    { category: "dining", pattern: /cafe[a-z]/i },
    { category: "dining", pattern: /\b(restaurant|eatery|brasserie|trattoria|osteria)\b/i },
    { category: "dining", pattern: /\b(coffee|espresso|roastery|tea house)\b/i },
    { category: "transportation", pattern: /\b(metro|transit|mta|cta|bart|caltrain)\b/i },
    { category: "transportation", pattern: /\b(gas|fuel|petrol)\b/i },
    { category: "travel", pattern: /\b(airlines?|airways|airport)\b/i },
    { category: "travel", pattern: /\b(hotel|motel|inn|hostel|lodging)\b/i },
    { category: "entertainment", pattern: /\b(theatre|theater|concert|festival)\b/i },
    { category: "subscriptions", pattern: /\b(subscription|membership)\b/i },
    { category: "fees", pattern: /\b(foreign\s+transaction|service\s+fee|annual\s+fee)\b/i }
  ];

  const TYPING_RULES = [
    { contains: "payroll", direction: "in", merchant: "Employer Payroll" },
    { contains: "dir dep", direction: "in", merchant: "Direct Deposit" },
    { contains: "direct dep", direction: "in", merchant: "Direct Deposit" },
    // UWCU ACH wording (hyphen). Plain "VENMO PAYMENT" on cards stays review.
    { contains: "venmo -cashout", direction: "in", merchant: "Venmo Cashout" },
    {
      contains: "venmo -payment",
      direction: "out",
      merchant: "Venmo Payment"
    },
    {
      contains: "tfr to sv",
      direction: "transfer",
      merchant: "Savings Transfer",
      transferAccount: "uwcu-savings"
    },
    {
      contains: "tfr to ck",
      direction: "transfer",
      merchant: "Checking Transfer",
      transferAccount: "uwcu-checking"
    },
    {
      contains: "transfer to savings",
      direction: "transfer",
      merchant: "Savings Transfer",
      transferAccount: "savings"
    },
    {
      contains: "transfer from savings",
      direction: "transfer",
      merchant: "Savings Transfer",
      transferAccount: "savings"
    },
    {
      contains: "transfer to checking",
      direction: "transfer",
      merchant: "Checking Transfer",
      transferAccount: "checking"
    },
    {
      contains: "amex epayment",
      direction: "transfer",
      merchant: "Amex Payment",
      transferAccount: "amex"
    },
    {
      contains: "american express",
      direction: "transfer",
      merchant: "Amex Payment",
      transferAccount: "amex",
      requires: /\b(epayment|e-?payment|ach|pmt|payment|online|web)\b/i
    },
    {
      contains: "amex",
      direction: "transfer",
      merchant: "Amex Payment",
      transferAccount: "amex",
      requires: /\b(epayment|e-?payment|ach|pmt|payment)\b/i
    },
    {
      contains: "discover",
      direction: "transfer",
      merchant: "Discover Payment",
      transferAccount: "discover",
      requires: /\b(epayment|e-?payment|ach|pmt|payment)\b/i
    },
    {
      contains: "payment received - thank you",
      direction: "transfer",
      merchant: "Card Payment",
      transferAccount: ""
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

  /** Strip wallet/POS prefixes so brand rules see the real merchant. */
  function normalizeMerchantForCategory(merchant) {
    return String(merchant || "")
      .toLowerCase()
      .replace(/^gglpay\s+/i, "")
      .replace(/^google\s*pay\s+/i, "")
      .replace(/^sq\s*\*?\s*/i, "")
      .replace(/^tst\*\s*/i, "")
      .replace(/^sp\s+/i, "")
      .replace(/^amz\*/i, "")
      .replace(/^ctlp\*/i, "")
      .replace(/^fsp\*/i, "")
      .replace(/[^a-z0-9&'+.*# ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function phraseMatches(haystack, phrase, loose) {
    const start = haystack.indexOf(phrase);
    if (start === -1) return false;
    const before = haystack[start - 1] || " ";
    const after = haystack[start + phrase.length] || " ";
    if (loose) {
      // Allow glued Amex truncations (7THSTREETBURGER, CAFEDOWNERS) for
      // phrases long enough to avoid false hits like "rent" inside "parent".
      if (/[a-z0-9]/.test(before) && phrase.length < 5) return false;
      return true;
    }
    if (/[a-z0-9]/.test(before)) return false;
    if (/[a-z0-9]/.test(after) && phrase.length < 6) return false;
    return true;
  }

  function findSubstringRule(value, rules) {
    const normalized = String(value || "").toLowerCase();
    return rules.find((rule) => {
      const phrase = rule.contains.toLowerCase();
      const start = normalized.indexOf(phrase);
      if (start === -1) return false;
      const before = normalized[start - 1] || "";
      const after = normalized[start + phrase.length] || "";
      if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) return false;
      if (rule.requires && !rule.requires.test(String(value || ""))) return false;
      return true;
    });
  }

  function categoryFor(merchant) {
    const raw = String(merchant || "");
    const norm = normalizeMerchantForCategory(raw);

    for (const rule of CATEGORY_RULES) {
      const phrase = rule.contains.toLowerCase();
      if (phraseMatches(norm, phrase, Boolean(rule.loose))) {
        return rule.category;
      }
      // Also try original string for odd punctuation the normalizer dropped.
      if (phraseMatches(raw.toLowerCase(), phrase, Boolean(rule.loose))) {
        return rule.category;
      }
    }

    for (const rule of CATEGORY_PATTERNS) {
      if (rule.pattern.test(raw) || rule.pattern.test(norm)) {
        return rule.category;
      }
    }

    return "uncategorized";
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
    const merchantLower = String(raw.rawMerchant || "").toLowerCase();
    const debitLike =
      /\bdebitcard\b/.test(merchantLower) ||
      /\bpurchase\s+visa\b/.test(merchantLower) ||
      /\batm\b/.test(merchantLower);
    const ambiguous =
      !debitLike &&
      AMBIGUOUS_MERCHANTS.some((name) => merchantLower.includes(name));
    const accountType = accountTypes[raw.account];
    if (!accountType) throw new Error(`Unknown account: ${raw.account}`);
    if (!VALID_ACCOUNT_TYPES.has(accountType)) {
      throw new Error(`Invalid account type for ${raw.account}: ${accountType}`);
    }

    let direction = typingRule?.direction ? typingRule.direction : "out";
    if (ambiguous && !typingRule?.direction) direction = "";

    // Signed bank/CSV exports win over ambiguous merchant defaults.
    // Venmo/Zelle still need review, but amount sign is usually correct.
    if ((!typingRule || !typingRule.direction) && raw.directionHint) {
      const hint = String(raw.directionHint);
      if (hint === "in" || hint === "out" || hint === "transfer") direction = hint;
    }

    // Debit-card Visa Direct → Venmo is still a card purchase (money out).
    if ((!typingRule || !typingRule.direction) && !direction && debitLike) {
      direction = /return/.test(merchantLower) ? "in" : "out";
    }

    const merchant = typingRule?.merchant || cleanMerchant(raw.rawMerchant);
    const savingsHint =
      accountTypes.savings
        ? "savings"
        : accountTypes["uwcu-savings"]
          ? "uwcu-savings"
          : "";
    const checkingHint = accountTypes.checking
      ? "checking"
      : accountTypes["uwcu-checking"]
        ? "uwcu-checking"
        : "";

    let transferAccount = typingRule?.transferAccount || "";
    if (transferAccount === "savings" && !accountTypes.savings && savingsHint) {
      transferAccount = savingsHint;
    }
    if (transferAccount === "checking" && !accountTypes.checking && checkingHint) {
      transferAccount = checkingHint;
    }
    if (transferAccount && !accountTypes[transferAccount]) {
      transferAccount = "";
    }

    // Card payment rows often land on the card account already — leave target blank
    // for review rather than inventing a cash account.
    if (
      typingRule &&
      typingRule.merchant === "Card Payment" &&
      !transferAccount
    ) {
      // keep transfer with empty target → needsReview
    }

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
        ambiguous ||
        !direction ||
        (direction !== "out" &&
          direction !== "in" &&
          direction !== "transfer") ||
        (direction === "transfer" &&
          !transferAccount &&
          typingRule?.merchant === "Card Payment"),
      transferAccount,
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
    CATEGORY_PATTERNS,
    CATEGORY_RULES_VERSION,
    TYPING_RULES,
    AMBIGUOUS_MERCHANTS,
    categoryFor,
    cleanMerchant,
    normalizeMerchantForCategory,
    normalizeTransaction,
    normalizeTransactions
  };
});
