"use strict";

/**
 * Best-effort public rewards fetch. Discover quarterly categories first.
 * Fail closed — never wipe manual rows. Mock mode for tests/offline.
 */

const dbApi = require("../db.js");

const DISCOVER_URLS = [
  "https://www.discover.com/credit-cards/cash-back-bonus/",
  "https://www.discover.com/credit-cards/cashback-bonus/"
];

const CATEGORY_ALIASES = [
  { category: "groceries", match: /grocery|groceries|supermarket|walmart/i },
  { category: "dining", match: /restaurant|dining|food\s*&\s*drink|takeout/i },
  {
    category: "transportation",
    match: /gas|fuel|transit|uber|lyft|parking|ev charging/i
  },
  { category: "shopping", match: /amazon|paypal|wholesale|online shopping|retail/i },
  { category: "entertainment", match: /streaming|entertainment|movies/i },
  { category: "health", match: /pharmacy|drug\s*store/i },
  { category: "utilities", match: /utility|utilities|phone|internet/i }
];

function mapCategoryLabel(label) {
  const text = String(label || "");
  for (const alias of CATEGORY_ALIASES) {
    if (alias.match.test(text)) return alias.category;
  }
  return "shopping";
}

function quarterBounds(asOf = new Date()) {
  const year = asOf.getUTCFullYear();
  const q = Math.floor(asOf.getUTCMonth() / 3);
  const startMonth = q * 3;
  const startsOn = new Date(Date.UTC(year, startMonth, 1))
    .toISOString()
    .slice(0, 10);
  const endsOn = new Date(Date.UTC(year, startMonth + 3, 0))
    .toISOString()
    .slice(0, 10);
  return { startsOn, endsOn, quarter: q + 1, year };
}

function mockDiscoverOffers(asOf = new Date()) {
  const { startsOn, endsOn, quarter, year } = quarterBounds(asOf);
  return [
    {
      id: `offer:discover:web:groceries:${year}Q${quarter}`,
      accountId: "discover",
      title: "Discover 5% Cashback Bonus — Groceries",
      category: "groceries",
      merchantContains: "",
      ratePct: 5,
      startsOn,
      endsOn,
      source: "web",
      url: DISCOVER_URLS[0],
      active: true
    },
    {
      id: `offer:discover:web:transportation:${year}Q${quarter}`,
      accountId: "discover",
      title: "Discover 5% Cashback Bonus — Gas",
      category: "transportation",
      merchantContains: "",
      ratePct: 5,
      startsOn,
      endsOn,
      source: "web",
      url: DISCOVER_URLS[0],
      active: true
    }
  ];
}

function parseDiscoverHtml(html, asOf = new Date()) {
  const { startsOn, endsOn, quarter, year } = quarterBounds(asOf);
  const text = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

  const found = [];
  const seen = new Set();
  CATEGORY_ALIASES.forEach((alias) => {
    if (alias.match.test(text) && /5\s*%|five percent|cashback bonus/i.test(text)) {
      if (seen.has(alias.category)) return;
      seen.add(alias.category);
      found.push({
        id: `offer:discover:web:${alias.category}:${year}Q${quarter}`,
        accountId: "discover",
        title: `Discover 5% Cashback Bonus — ${alias.category}`,
        category: alias.category,
        merchantContains: "",
        ratePct: 5,
        startsOn,
        endsOn,
        source: "web",
        url: DISCOVER_URLS[0],
        active: true
      });
    }
  });

  // Heuristic: bullet-like category names near "5%"
  const nearFive = text.match(/5%\s+(?:cash\s*back\s+)?(?:at\s+)?([A-Za-z0-9 &/-]{3,40})/gi) || [];
  nearFive.forEach((chunk) => {
    const label = chunk.replace(/^5%\s+(?:cash\s*back\s+)?(?:at\s+)?/i, "").trim();
    const category = mapCategoryLabel(label);
    if (seen.has(category)) return;
    seen.add(category);
    found.push({
      id: `offer:discover:web:${category}:${year}Q${quarter}`,
      accountId: "discover",
      title: `Discover 5% — ${label.slice(0, 60)}`,
      category,
      merchantContains: "",
      ratePct: 5,
      startsOn,
      endsOn,
      source: "web",
      url: DISCOVER_URLS[0],
      active: true
    });
  });

  return found;
}

async function fetchDiscoverOffers(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const asOf = options.asOf || new Date();
  let lastError = null;
  for (const url of DISCOVER_URLS) {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "ShelfFinanceHub/0.2 (rewards optimizer; personal)"
        }
      });
      if (!response.ok) {
        lastError = new Error(`Discover HTTP ${response.status}`);
        continue;
      }
      const html = await response.text();
      const parsed = parseDiscoverHtml(html, asOf);
      if (parsed.length) return { offers: parsed, url, mode: "live" };
      lastError = new Error("Discover page fetched but no categories parsed");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Discover rewards fetch failed");
}

async function syncRewards(db, options = {}) {
  const forceMock = options.forceMock === true;
  const asOf = options.asOf || new Date();
  let offers = [];
  let mode = "live";
  let error = null;
  let amexStatus = "seed_only";

  if (forceMock) {
    mode = "mock";
    offers = mockDiscoverOffers(asOf);
  } else {
    try {
      const result = await fetchDiscoverOffers({
        fetchImpl: options.fetchImpl,
        asOf
      });
      offers = result.offers;
      mode = result.mode;
    } catch (err) {
      mode = "skipped";
      error = err.message || String(err);
      // Keep prior web offers; do not clear.
    }
  }

  let upserted = 0;
  offers.forEach((offer) => {
    const before = dbApi.getRewardsOffer(db, offer.id);
    const saved = dbApi.upsertRewardsOffer(db, offer, { fromWeb: true });
    if (saved && (!before || before.source !== "manual")) upserted += 1;
  });

  dbApi.setConnectorWatermark(db, "rewards-web", new Date().toISOString());
  dbApi.setMeta(db, "rewardsWebStatus", error || mode);
  dbApi.setMeta(db, "rewardsAmexStatus", amexStatus);

  return {
    source: "rewards",
    mode,
    error,
    amexStatus,
    upserted,
    offers: offers.map((o) => o.id)
  };
}

module.exports = {
  DISCOVER_URLS,
  mockDiscoverOffers,
  parseDiscoverHtml,
  fetchDiscoverOffers,
  syncRewards,
  mapCategoryLabel,
  quarterBounds
};
