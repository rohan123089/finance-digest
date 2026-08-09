(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MoneyLearned = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SCOPES = Object.freeze(["money", "digest"]);
  const MONEY_EFFECTS = Object.freeze(["set_category", "set_direction"]);
  const DIGEST_EFFECTS = Object.freeze([
    "mute",
    "junk_reading",
    "set_domain",
    "force_kind"
  ]);
  const DOMAINS = Object.freeze(["personal", "school", "professional"]);
  const FORCE_KINDS = Object.freeze(["event", "task", "drop"]);

  function parseEffectValue(raw) {
    if (raw == null || raw === "") return {};
    if (typeof raw === "object") return raw;
    try {
      return JSON.parse(String(raw));
    } catch {
      return {};
    }
  }

  function stringifyEffectValue(value) {
    if (value == null) return "{}";
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  }

  /** Stable money merchant key — mirrors model streamKey for expenses. */
  function merchantKey(merchant, direction) {
    const raw = String(merchant || "")
      .trim()
      .toLowerCase();
    if (!raw) return "";
    if (direction === "in") return raw.replace(/\s+/g, " ").trim();
    return (
      raw
        .replace(
          /\b(debitcard|pos|purchase|withdrawal|ach|checkcard|visa|mastercard)\b/g,
          " "
        )
        .replace(/\b\d{4}\b/g, " ")
        .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, " ")
        .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, " ")
        .replace(
          /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/g,
          " "
        )
        .replace(/\b(20)?\d{2}\b/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim() || raw
    );
  }

  /**
   * P2P rails reuse one merchant label for many real payees (Venmo, Zelle…).
   * Never learn/propagate category across them — each tx is its own decision.
   */
  function isPeerP2pMerchant(merchant) {
    const m = String(merchant || "").toLowerCase();
    if (!m) return false;
    return (
      /\bvenmo\b/.test(m) ||
      /\bpaypal\b/.test(m) ||
      /\bcash\s*app\b/.test(m) ||
      /\bzelle\b/.test(m)
    );
  }

  function emailLocal(from) {
    const text = String(from || "").toLowerCase();
    const angle = text.match(/<([^>]+)>/);
    const addr = (angle ? angle[1] : text).trim();
    const m = addr.match(/[\w.+-]+@[\w.-]+\.\w+/);
    return m ? m[0] : addr.replace(/\s+/g, " ").slice(0, 120);
  }

  function emailDomain(from) {
    const addr = emailLocal(from);
    const at = addr.lastIndexOf("@");
    return at >= 0 ? addr.slice(at + 1) : "";
  }

  function hostFromUrl(url) {
    try {
      const u = new URL(String(url || ""));
      return u.hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return "";
    }
  }

  function ruleId(scope, matchKind, matchKey, effect) {
    const safe = [scope, matchKind, matchKey, effect]
      .map((part) =>
        String(part || "")
          .toLowerCase()
          .replace(/[^a-z0-9@._+-]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 48)
      )
      .join(":");
    return `lr:${safe}`.slice(0, 160);
  }

  function normalizeRuleInput(input) {
    const scope = String(input.scope || "").toLowerCase();
    if (!SCOPES.includes(scope)) throw new Error(`Invalid learned scope: ${scope}`);
    const matchKind = String(input.matchKind || input.match_kind || "").toLowerCase();
    const matchKey = String(input.matchKey || input.match_key || "")
      .trim()
      .toLowerCase();
    if (!matchKind || !matchKey) throw new Error("matchKind and matchKey required");
    const effect = String(input.effect || "").toLowerCase();
    const allowed = scope === "money" ? MONEY_EFFECTS : DIGEST_EFFECTS;
    if (!allowed.includes(effect)) {
      throw new Error(`Invalid effect ${effect} for scope ${scope}`);
    }
    const effectValue = parseEffectValue(
      input.effectValue != null ? input.effectValue : input.effect_value
    );
    if (effect === "set_category" && !effectValue.category) {
      throw new Error("set_category requires effectValue.category");
    }
    if (effect === "set_direction" && !effectValue.direction) {
      throw new Error("set_direction requires effectValue.direction");
    }
    if (effect === "set_domain") {
      const domain = String(effectValue.domain || "").toLowerCase();
      if (!DOMAINS.includes(domain)) {
        throw new Error("set_domain requires personal|school|professional");
      }
      effectValue.domain = domain;
    }
    if (effect === "force_kind") {
      const kind = String(effectValue.kind || "").toLowerCase();
      if (!FORCE_KINDS.includes(kind)) {
        throw new Error("force_kind requires event|task|drop");
      }
      effectValue.kind = kind;
    }
    return {
      id: input.id || ruleId(scope, matchKind, matchKey, effect),
      scope,
      matchKind,
      matchKey,
      effect,
      effectValue,
      priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100,
      source: String(input.source || "user_action"),
      evidence: input.evidence || input.evidence_json || null,
      hitCount: Number(input.hitCount || input.hit_count || 0) || 0,
      active: input.active === false || input.active === 0 ? false : true
    };
  }

  function sortRules(rules) {
    return [...(rules || [])].sort((a, b) => {
      const pa = Number(a.priority) || 100;
      const pb = Number(b.priority) || 100;
      if (pa !== pb) return pa - pb;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
  }

  function ruleMatchesMoney(rule, merchant, direction) {
    if (!rule || !rule.active) return false;
    if (rule.scope !== "money") return false;
    const key = merchantKey(merchant, direction);
    if (!key) return false;
    if (rule.matchKind === "merchant_key") return rule.matchKey === key;
    if (rule.matchKind === "merchant_contains") {
      return key.includes(rule.matchKey) || String(merchant || "").toLowerCase().includes(rule.matchKey);
    }
    return false;
  }

  /**
   * @returns {{ category?: string, direction?: string, ruleIds: string[] } | null}
   */
  function resolveMoney(rules, merchant, direction) {
    const active = sortRules(rules).filter((r) => r.scope === "money" && r.active);
    const hits = active.filter((r) => ruleMatchesMoney(r, merchant, direction));
    if (!hits.length) return null;
    const out = { ruleIds: [] };
    hits.forEach((rule) => {
      const value = parseEffectValue(rule.effectValue);
      out.ruleIds.push(rule.id);
      if (rule.effect === "set_category" && value.category) {
        out.category = value.category;
      }
      if (rule.effect === "set_direction" && value.direction) {
        out.direction = value.direction;
      }
    });
    return out.category || out.direction ? out : null;
  }

  function candidatesFromDigestMessage(message) {
    const from = message.from || message.sender || "";
    const sender = emailLocal(from);
    const fromDomain = emailDomain(from);
    const groupId = String(
      message.groupId || message.data?.groupId || ""
    ).trim();
    const calendarId = String(
      message.calendarId || message.data?.calendarId || ""
    ).trim();
    const listIds = []
      .concat(message.listIds || [])
      .concat(message.data?.listIds || [])
      .concat(message.targetRef?.listIds || [])
      .map((id) => String(id).toLowerCase())
      .filter(Boolean);
    const url = message.url || message.data?.url || "";
    const host = hostFromUrl(url);
    const sourceRef = String(message.sourceRef || message.data?.sourceRef || "");
    return { sender, fromDomain, groupId, calendarId, listIds, host, sourceRef };
  }

  function ruleMatchesDigest(rule, candidates) {
    if (!rule || !rule.active || rule.scope !== "digest") return false;
    const key = rule.matchKey;
    switch (rule.matchKind) {
      case "sender":
        return candidates.sender && candidates.sender === key;
      case "from_domain":
        return candidates.fromDomain && candidates.fromDomain === key;
      case "list_id":
        return (candidates.listIds || []).includes(key);
      case "group_id":
        return candidates.groupId && candidates.groupId === key;
      case "calendar_id":
        return candidates.calendarId && candidates.calendarId === key;
      case "host":
        return candidates.host && candidates.host === key;
      case "source_ref_prefix":
        return candidates.sourceRef && candidates.sourceRef.startsWith(key);
      default:
        return false;
    }
  }

  /**
   * @returns {{ mute: boolean, junkReading: boolean, domain?: string, forceKind?: string, ruleIds: string[] }}
   */
  function resolveDigest(rules, message) {
    const candidates = candidatesFromDigestMessage(message || {});
    const active = sortRules(rules).filter((r) => r.scope === "digest" && r.active);
    const hits = active.filter((r) => ruleMatchesDigest(r, candidates));
    const out = {
      mute: false,
      junkReading: false,
      ruleIds: []
    };
    hits.forEach((rule) => {
      const value = parseEffectValue(rule.effectValue);
      out.ruleIds.push(rule.id);
      if (rule.effect === "mute") out.mute = true;
      if (rule.effect === "junk_reading") out.junkReading = true;
      if (rule.effect === "set_domain" && value.domain) out.domain = value.domain;
      if (rule.effect === "force_kind" && value.kind) out.forceKind = value.kind;
    });
    return out;
  }

  function moneyLearnFromCommit(tx) {
    const direction = tx.direction || "";
    if (direction !== "in" && direction !== "out") return [];
    const merchant = tx.merchant || tx.rawMerchant || "";
    // Venmo/Zelle/etc. — do not learn a shared category from one payment.
    if (isPeerP2pMerchant(merchant)) return [];
    const key = merchantKey(merchant, direction);
    if (!key || key.length < 3) return [];
    const rules = [];
    if (tx.category && tx.category !== "uncategorized") {
      rules.push(
        normalizeRuleInput({
          scope: "money",
          matchKind: "merchant_key",
          matchKey: key,
          effect: "set_category",
          effectValue: { category: tx.category },
          source: "user_action",
          evidence: { transactionId: tx.id, merchant }
        })
      );
    }
    if (direction === "in") {
      rules.push(
        normalizeRuleInput({
          scope: "money",
          matchKind: "merchant_key",
          matchKey: key,
          effect: "set_direction",
          effectValue: { direction: "in" },
          source: "user_action",
          evidence: { transactionId: tx.id, merchant }
        })
      );
    }
    return rules;
  }

  function digestLearnFromUnsubscribe(data) {
    const ref = data?.targetRef || data || {};
    const listIds = [].concat(ref.listIds || []).filter(Boolean);
    const sender = ref.sender || ref.from || data?.sender || "";
    const host = ref.host || (ref.url ? hostFromUrl(ref.url) : "");
    const rules = [];
    listIds.forEach((listId) => {
      rules.push(
        normalizeRuleInput({
          scope: "digest",
          matchKind: "list_id",
          matchKey: String(listId).toLowerCase(),
          effect: "mute",
          effectValue: {},
          source: "user_action",
          evidence: { listId }
        })
      );
    });
    if (sender) {
      rules.push(
        normalizeRuleInput({
          scope: "digest",
          matchKind: "sender",
          matchKey: emailLocal(sender),
          effect: "mute",
          effectValue: {},
          source: "user_action",
          evidence: { sender }
        })
      );
    }
    if (host) {
      rules.push(
        normalizeRuleInput({
          scope: "digest",
          matchKind: "host",
          matchKey: host,
          effect: "junk_reading",
          effectValue: {},
          source: "user_action",
          evidence: { host }
        })
      );
    }
    return rules;
  }

  function digestLearnFromTarget(targetItem, actionType) {
    if (!targetItem) return [];
    const data = targetItem.data || {};
    const sourceRef = String(data.sourceRef || targetItem.sourceRef || "");
    const groupMatch = sourceRef.match(/groupme:group\/([^/]+)/i);
    const groupId = data.groupId || (groupMatch ? groupMatch[1] : "");
    const calendarId = data.calendarId || "";
    const from = data.from || data.sender || data.sharedBy || "";
    const url = data.url || "";
    const rules = [];
    const isDecline =
      actionType === "action.rsvp.no" || actionType === "action.dismiss";
    const isGoing =
      actionType === "action.rsvp.yes" || actionType === "action.going";

    // Whole-group drop is thresholded in learnFromDigestAction (needs 2 declines).
    if (groupId && isDecline) {
      rules.push(
        normalizeRuleInput({
          scope: "digest",
          matchKind: "group_id",
          matchKey: String(groupId),
          effect: "force_kind",
          effectValue: { kind: "drop" },
          source: "user_action",
          evidence: {
            groupId,
            actionType,
            targetId: targetItem.id,
            threshold: 2
          },
          priority: 120,
          hitCount: 1
        })
      );
    }
    if (calendarId && isDecline) {
      rules.push(
        normalizeRuleInput({
          scope: "digest",
          matchKind: "calendar_id",
          matchKey: String(calendarId),
          effect: "force_kind",
          effectValue: { kind: "drop" },
          source: "user_action",
          evidence: {
            calendarId,
            actionType,
            targetId: targetItem.id,
            threshold: 2
          },
          priority: 120,
          hitCount: 1
        })
      );
    }
    if (groupId && isGoing) {
      rules.push(
        normalizeRuleInput({
          scope: "digest",
          matchKind: "group_id",
          matchKey: String(groupId),
          effect: "force_kind",
          effectValue: { kind: "event" },
          source: "user_action",
          evidence: { groupId, actionType, targetId: targetItem.id },
          priority: 110
        })
      );
      if (data.domain && DOMAINS.includes(String(data.domain))) {
        rules.push(
          normalizeRuleInput({
            scope: "digest",
            matchKind: "group_id",
            matchKey: String(groupId),
            effect: "set_domain",
            effectValue: { domain: data.domain },
            source: "user_action",
            evidence: { groupId, domain: data.domain }
          })
        );
      }
    }
    // Mute real email senders only — GroupMe display names are not stable mute keys.
    if (from && isDecline && /@/.test(from)) {
      rules.push(
        normalizeRuleInput({
          scope: "digest",
          matchKind: "sender",
          matchKey: emailLocal(from),
          effect: "mute",
          effectValue: {},
          source: "user_action",
          evidence: { from, actionType, targetId: targetItem.id },
          priority: 130
        })
      );
      const domainKey = emailDomain(from);
      if (domainKey) {
        rules.push(
          normalizeRuleInput({
            scope: "digest",
            matchKind: "from_domain",
            matchKey: domainKey,
            effect: "set_domain",
            effectValue: {
              domain: DOMAINS.includes(String(data.domain))
                ? data.domain
                : /edu$|\.edu\./i.test(domainKey)
                  ? "school"
                  : "personal"
            },
            source: "user_action",
            evidence: {
              from,
              domainKey,
              actionType,
              targetId: targetItem.id,
              threshold: 2
            },
            priority: 140,
            hitCount: 1
          })
        );
      }
    }
    if (isDecline && url) {
      const host = hostFromUrl(url);
      if (host) {
        rules.push(
          normalizeRuleInput({
            scope: "digest",
            matchKind: "host",
            matchKey: host,
            effect: "junk_reading",
            effectValue: {},
            source: "user_action",
            evidence: { host, actionType, targetId: targetItem.id }
          })
        );
      }
    }
    return rules;
  }

  /** True when this rule should stay inactive until enough distinct target evidence. */
  function digestRuleNeedsThreshold(rule) {
    const ev = rule?.evidence || {};
    const threshold = Number(ev.threshold) || 0;
    return threshold > 1;
  }

  /**
   * Merge evidence for a thresholded rule. Returns { evidence, hitCount, active }.
   */
  function mergeThresholdEvidence(existing, incoming, threshold) {
    const prev = existing?.evidence || {};
    const next = incoming?.evidence || {};
    const ids = new Set(
      []
        .concat(prev.targetIds || [])
        .concat(next.targetIds || [])
        .concat(prev.targetId ? [prev.targetId] : [])
        .concat(next.targetId ? [next.targetId] : [])
        .map(String)
        .filter(Boolean)
    );
    const hitCount = Math.max(ids.size, Number(existing?.hitCount) || 0, 1);
    return {
      evidence: {
        ...prev,
        ...next,
        targetIds: [...ids],
        threshold
      },
      hitCount,
      active: hitCount >= threshold
    };
  }

  /** Suggest bill seed id from stream category/merchant. */
  function suggestBillSeed(stream) {
    const cat = String(stream.category || "").toLowerCase();
    const merchant = String(stream.merchant || stream.key || "").toLowerCase();
    if (
      cat === "housing" ||
      /\b(rent|lease|apartment|landlord|housing)\b/.test(merchant)
    ) {
      return { id: "bill:rent", title: "Rent", category: "housing", leadDays: 5 };
    }
    if (
      cat === "utilities" ||
      /\b(utilit|comcast|xfinity|electric|gas|water|comed|internet|wifi)\b/.test(
        merchant
      )
    ) {
      return {
        id: "bill:utilities",
        title: "Utilities",
        category: "utilities",
        leadDays: 3
      };
    }
    if (cat === "subscriptions" || /\b(netflix|spotify|hulu|subscription)\b/.test(merchant)) {
      return {
        id: "bill:subscriptions",
        title: "Subscriptions",
        category: "subscriptions",
        leadDays: 3
      };
    }
    return null;
  }

  function dueDayFromDate(isoDate) {
    const day = Number(String(isoDate || "").slice(8, 10));
    if (!Number.isFinite(day) || day < 1) return 1;
    return Math.min(28, day);
  }

  function billSuggestionFromStream(stream) {
    if (!stream || stream.direction === "in") return null;
    const label = stream.cadenceLabel || "";
    if (label !== "monthly" && label !== "bimonthly") return null;
    const seed = suggestBillSeed(stream);
    const title =
      seed?.title ||
      String(stream.merchant || stream.key || "Recurring")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 48);
    const category = seed?.category || stream.category || "";
    return {
      streamKey: stream.key,
      merchant: stream.merchant,
      amount: stream.amount,
      cadenceLabel: stream.cadenceLabel,
      lastDate: stream.lastDate,
      occurrences: stream.occurrences,
      category,
      dueDay: dueDayFromDate(stream.lastDate),
      leadDays: seed?.leadDays || 5,
      seedBillId: seed?.id || null,
      title,
      transactionIds: stream.transactionIds || []
    };
  }

  function buildMonthlyTallies(transactions) {
    const months = new Map();
    (transactions || []).forEach((tx) => {
      if (!tx?.date || tx.duplicateOf) return;
      const key = String(tx.date).slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(key)) return;
      if (!months.has(key)) {
        months.set(key, {
          key,
          income: 0,
          expenses: 0,
          transfers: 0,
          needsReviewCount: 0,
          transactionIds: []
        });
      }
      const row = months.get(key);
      row.transactionIds.push(tx.id);
      if (tx.needsReview) row.needsReviewCount += 1;
      if (!tx.direction || !Number.isFinite(tx.amount)) return;
      if (tx.direction === "in") row.income += tx.amount;
      else if (tx.direction === "out") row.expenses += tx.amount;
      else if (tx.direction === "transfer") row.transfers += tx.amount;
    });
    return [...months.values()]
      .map((row) => ({
        ...row,
        income: Math.round(row.income * 100) / 100,
        expenses: Math.round(row.expenses * 100) / 100,
        transfers: Math.round(row.transfers * 100) / 100,
        net: Math.round((row.income - row.expenses) * 100) / 100,
        count: row.transactionIds.length
      }))
      .sort((a, b) => b.key.localeCompare(a.key));
  }

  function recurringMarksFromStreams(streams) {
    const marks = {};
    (streams || []).forEach((stream) => {
      (stream.transactionIds || []).forEach((id) => {
        marks[id] = {
          streamKey: stream.key,
          cadenceLabel: stream.cadenceLabel,
          amount: stream.amount,
          merchant: stream.merchant
        };
      });
    });
    return marks;
  }

  return {
    SCOPES,
    MONEY_EFFECTS,
    DIGEST_EFFECTS,
    DOMAINS,
    parseEffectValue,
    stringifyEffectValue,
    merchantKey,
    isPeerP2pMerchant,
    emailLocal,
    emailDomain,
    hostFromUrl,
    ruleId,
    normalizeRuleInput,
    sortRules,
    resolveMoney,
    resolveDigest,
    candidatesFromDigestMessage,
    moneyLearnFromCommit,
    digestLearnFromUnsubscribe,
    digestLearnFromTarget,
    digestRuleNeedsThreshold,
    mergeThresholdEvidence,
    suggestBillSeed,
    billSuggestionFromStream,
    buildMonthlyTallies,
    recurringMarksFromStreams,
    dueDayFromDate
  };
});
