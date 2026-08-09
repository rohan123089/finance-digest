"use strict";

const assert = require("node:assert/strict");
const Learned = require("../engine/learned.js");
const Model = require("../engine/model.js");

// Money resolve
{
  const rules = [
    Learned.normalizeRuleInput({
      scope: "money",
      matchKind: "merchant_key",
      matchKey: Learned.merchantKey("ACH RENT VERSAILLE LLC", "out"),
      effect: "set_category",
      effectValue: { category: "housing" }
    })
  ];
  const hit = Learned.resolveMoney(rules, "ACH RENT VERSAILLE LLC", "out");
  assert.equal(hit.category, "housing");
  const miss = Learned.resolveMoney(rules, "STARBUCKS", "out");
  assert.equal(miss, null);
}

// Venmo/Zelle are per-tx — never learn a shared category
{
  assert.equal(Learned.isPeerP2pMerchant("ACH:VENMO -PAYMENT"), true);
  assert.equal(Learned.isPeerP2pMerchant("Web Branch:Zelle RAKESH"), true);
  assert.equal(Learned.isPeerP2pMerchant("STARBUCKS"), false);
  const learned = Learned.moneyLearnFromCommit({
    id: "v1",
    direction: "out",
    merchant: "ACH:VENMO -PAYMENT",
    category: "dining"
  });
  assert.equal(learned.length, 0);
}

// Digest mute
{
  const rules = [
    Learned.normalizeRuleInput({
      scope: "digest",
      matchKind: "list_id",
      matchKey: "news.acme.com",
      effect: "mute",
      effectValue: {}
    }),
    Learned.normalizeRuleInput({
      scope: "digest",
      matchKind: "host",
      matchKey: "tracking.example",
      effect: "junk_reading",
      effectValue: {}
    })
  ];
  const muted = Learned.resolveDigest(rules, {
    listIds: ["news.acme.com"],
    from: "newsletter@acme.example"
  });
  assert.equal(muted.mute, true);
  const junk = Learned.resolveDigest(rules, {
    url: "https://tracking.example/x"
  });
  assert.equal(junk.junkReading, true);
}

// Monthly tallies
{
  const months = Learned.buildMonthlyTallies([
    { id: "1", date: "2026-08-01", direction: "in", amount: 1000 },
    { id: "2", date: "2026-08-05", direction: "out", amount: 100, needsReview: true },
    { id: "3", date: "2026-07-10", direction: "out", amount: 50 }
  ]);
  assert.equal(months[0].key, "2026-08");
  assert.equal(months[0].income, 1000);
  assert.equal(months[0].expenses, 100);
  assert.equal(months[0].needsReviewCount, 1);
}

// Uncategorized monthly rent-sized stream is detected
{
  const txs = [
    {
      id: "r1",
      date: "2026-05-01",
      direction: "out",
      amount: 1450,
      merchant: "ACH LANDLORD PAY",
      category: "uncategorized"
    },
    {
      id: "r2",
      date: "2026-06-01",
      direction: "out",
      amount: 1450,
      merchant: "ACH LANDLORD PAY",
      category: "uncategorized"
    },
    {
      id: "r3",
      date: "2026-07-02",
      direction: "out",
      amount: 1450,
      merchant: "ACH LANDLORD PAY",
      category: "uncategorized"
    }
  ];
  const streams = Model.detectRecurringStreams(txs, "out", {
    asOfDate: "2026-07-15"
  });
  assert.ok(streams.length >= 1, "expected recurring rent stream");
  assert.equal(streams[0].cadenceLabel, "monthly");
  const suggestion = Learned.billSuggestionFromStream(streams[0]);
  assert.ok(suggestion);
  assert.equal(suggestion.seedBillId, "bill:rent");
}

{
  const decline1 = Learned.digestLearnFromTarget(
    {
      id: "ev1",
      data: { groupId: "55", title: "Trivia", from: "Sam" }
    },
    "action.rsvp.no"
  );
  assert.ok(decline1.some((r) => r.matchKind === "group_id" && r.effect === "force_kind"));
  assert.ok(
    decline1.every((r) => r.matchKind !== "sender" || /@/.test(String(r.evidence?.from || ""))),
    "GroupMe display names must not become sender mutes"
  );
  const dropRule = decline1.find((r) => r.effect === "force_kind");
  assert.equal(dropRule.evidence.threshold, 2);
  assert.equal(Learned.digestRuleNeedsThreshold(dropRule), true);

  const merged1 = Learned.mergeThresholdEvidence(null, dropRule, 2);
  assert.equal(merged1.active, false);
  assert.equal(merged1.hitCount, 1);
  const merged2 = Learned.mergeThresholdEvidence(
    { evidence: merged1.evidence, hitCount: merged1.hitCount },
    {
      evidence: { targetId: "ev2", threshold: 2, groupId: "55" }
    },
    2
  );
  assert.equal(merged2.active, true);
  assert.ok(merged2.hitCount >= 2);

  const going = Learned.digestLearnFromTarget(
    {
      id: "ev3",
      data: { groupId: "55", domain: "school", from: "Alex" }
    },
    "action.rsvp.yes"
  );
  assert.ok(going.some((r) => r.effect === "force_kind" && r.effectValue.kind === "event"));
  assert.ok(going.some((r) => r.effect === "set_domain"));

  const emailDecline = Learned.digestLearnFromTarget(
    {
      id: "mail1",
      data: { from: "spam@promo.example", url: "https://tracking.example/x" }
    },
    "action.dismiss"
  );
  assert.ok(emailDecline.some((r) => r.matchKind === "sender" && r.effect === "mute"));
  assert.ok(emailDecline.some((r) => r.matchKind === "host" && r.effect === "junk_reading"));
  assert.ok(emailDecline.some((r) => r.matchKind === "from_domain"));
}

console.log("learned.test.js: ok");
