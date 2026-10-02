// Cost-model tests.
//
// Every expected number here is hand-computed from DeepSeek's published rates
// so a silent change to the arithmetic fails the suite rather than quietly
// mis-reporting someone's spend.

import assert from "node:assert/strict";
import { test } from "node:test";

import { PRICING, convertUsd, foldTurns, isPeak, pricingFor, summarizeCost, usageCost } from "../lib/cost.js";

/** 2026-10-02 is a Friday, so weekday rules apply. */
const FRI = (hhmm) => Date.parse(`2026-10-02T${hhmm}:00Z`);
const SAT = (hhmm) => Date.parse(`2026-10-03T${hhmm}:00Z`);

test("peak hours are the two UTC weekday windows DeepSeek publishes", () => {
  assert.equal(isPeak(FRI("00:30")), false);
  assert.equal(isPeak(FRI("01:00")), true);
  assert.equal(isPeak(FRI("03:59")), true);
  assert.equal(isPeak(FRI("04:00")), false, "04:00 is the first off-peak hour");
  assert.equal(isPeak(FRI("05:59")), false);
  assert.equal(isPeak(FRI("06:00")), true);
  assert.equal(isPeak(FRI("09:59")), true);
  assert.equal(isPeak(FRI("10:00")), false, "10:00 is the end of the second window");
  assert.equal(isPeak(FRI("23:00")), false);
});

test("weekends are off-peak in full", () => {
  assert.equal(isPeak(SAT("02:00")), false);
  assert.equal(isPeak(SAT("07:00")), false);
});

test("legacy model names are priced at the Flash rate, as DeepSeek documents", () => {
  assert.equal(pricingFor("deepseek-flash"), PRICING["deepseek-flash"]);
  assert.equal(pricingFor("deepseek-v4-flash"), PRICING["deepseek-flash"]);
  assert.equal(pricingFor("deepseek-v4-flash-vision-exp"), PRICING["deepseek-flash"]);
  assert.equal(pricingFor("DeepSeek-Flash"), PRICING["deepseek-flash"], "matching is case-insensitive");
  assert.equal(pricingFor("deepseek-v4-pro"), PRICING["deepseek-v4-pro"]);
});

test("an unknown model has no price at all, rather than a guessed one", () => {
  assert.equal(pricingFor("gpt-5"), undefined);
  assert.equal(pricingFor(""), undefined);
  assert.equal(pricingFor(undefined), undefined);
  assert.equal(usageCost({ inputTokens: 1000 }, "mimo-v2.6-pro", FRI("12:00")), undefined);
});

test("off-peak Flash output is billed at the published output rate", () => {
  const priced = usageCost({ outputTokens: 1_000_000 }, "deepseek-flash", FRI("12:00"));
  assert.equal(priced?.peak, false);
  assert.equal(priced?.usd, 0.6);
});

test("cached and uncached input are billed at their own rates, as separate buckets", () => {
  // DSH's `inputTokens` is the UNCACHED half; cache reads are additional.
  // 1M uncached at $0.15 + 400k cache-read at $0.003.
  const priced = usageCost({ inputTokens: 1_000_000, cacheReadTokens: 400_000 }, "deepseek-flash", FRI("12:00"));
  assert.equal(priced?.cacheMissTokens, 1_000_000, "cache reads are not subtracted from the uncached bucket");
  assert.equal(Math.abs((priced?.usd ?? 0) - (0.15 + 0.0012)) < 1e-12, true, `got ${priced?.usd}`);
});

test("a fully cached prompt is nearly free, and a fully fresh one is not", () => {
  const cached = usageCost({ inputTokens: 0, cacheReadTokens: 1_000_000 }, "deepseek-flash", FRI("12:00"));
  const fresh = usageCost({ inputTokens: 1_000_000, cacheReadTokens: 0 }, "deepseek-flash", FRI("12:00"));
  assert.equal(cached?.cacheMissTokens, 0);
  assert.equal(cached?.usd, 0.003);
  assert.equal(fresh?.usd, 0.15);
});

test("a large cached prefix does not cancel the uncached remainder", () => {
  // The bug this guards: treating `inputTokens` as the whole prompt and
  // subtracting cache reads would clamp 50k uncached against a 1M cached prefix
  // to zero and report the turn as almost free.
  const priced = usageCost({ inputTokens: 50_000, cacheReadTokens: 1_000_000 }, "deepseek-flash", FRI("12:00"));
  assert.equal(priced?.cacheMissTokens, 50_000);
  assert.equal(Math.abs((priced?.usd ?? 0) - (50_000 * 0.15 + 1_000_000 * 0.003) / 1_000_000) < 1e-12, true);
});

test("DeepSeek has no cache-write line, so cache writes bill as uncached input", () => {
  const priced = usageCost({ inputTokens: 100_000, cacheWriteTokens: 900_000 }, "deepseek-flash", FRI("12:00"));
  assert.equal(priced?.cacheMissTokens, 1_000_000);
  assert.equal(priced?.usd, 0.15);
});

test("peak costs exactly twice off-peak", () => {
  const usage = { inputTokens: 250_000, cacheReadTokens: 250_000, outputTokens: 500_000 };
  const off = usageCost(usage, "deepseek-v4-pro", FRI("12:00"));
  const peak = usageCost(usage, "deepseek-v4-pro", FRI("02:00"));
  assert.equal(peak?.peak, true);
  assert.equal(Math.abs((peak?.usd ?? 0) - 2 * (off?.usd ?? 0)) < 1e-12, true);
});

test("missing or nonsense token fields price as zero rather than NaN", () => {
  assert.equal(usageCost({}, "deepseek-flash", FRI("12:00"))?.usd, 0);
  assert.equal(usageCost({ inputTokens: -5, outputTokens: Number.NaN }, "deepseek-flash", FRI("12:00"))?.usd, 0);
});

test("foldTurns groups usage by the turn that produced it", () => {
  const events = [
    { type: "turn/start", seq: 0, time: 1000, data: { turn: 1 } },
    { type: "assistant/message", seq: 1, time: 2000, data: { turn: 1, step: 1, message: { source: { provider: "deepseek", model: "deepseek-flash" } }, usage: { inputTokens: 1000, outputTokens: 100 } } },
    { type: "assistant/message", seq: 2, time: 3000, data: { turn: 1, step: 2, message: { source: { provider: "deepseek", model: "deepseek-flash" } }, usage: { inputTokens: 2000, outputTokens: 200 } } },
    { type: "turn/end", seq: 3, time: 4000, data: { turn: 1, reason: { kind: "completed" } } },
    { type: "turn/start", seq: 4, time: 5000, data: { turn: 2 } },
    { type: "assistant/message", seq: 5, time: 6000, data: { turn: 2, step: 1, message: { source: { provider: "deepseek", model: "deepseek-flash" } }, usage: { inputTokens: 4000, outputTokens: 400 } } },
  ];
  const turns = foldTurns(events);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].turn, 1);
  assert.equal(turns[0].messages, 2);
  assert.equal(turns[0].uncachedInputTokens, 3000);
  assert.equal(turns[0].outputTokens, 300);
  assert.equal(turns[0].ended, true);
  assert.equal(turns[1].turn, 2);
  assert.equal(turns[1].ended, false, "a turn still running is not marked ended");
  assert.equal(turns[0].models.length, 1, "one model is recorded once, not per message");
});

test("foldTurns tolerates a malformed log without throwing", () => {
  assert.deepEqual(foldTurns([]), []);
  assert.deepEqual(foldTurns(undefined), []);
  assert.deepEqual(foldTurns([null, { type: "nonsense" }, { type: "assistant/message" }]).length, 1);
});

test("a message with no usage report is counted as unpriced, not as free", () => {
  const events = [
    { type: "turn/start", seq: 0, time: 1000, data: { turn: 1 } },
    { type: "assistant/message", seq: 1, time: 2000, data: { turn: 1, message: { source: { model: "deepseek-flash" } } } },
  ];
  const [turn] = foldTurns(events);
  assert.equal(turn.unpricedMessages, 1);
  assert.equal(turn.usd, 0);
});

test("summarizeCost totals the session and reports the last turn", () => {
  const now = FRI("12:00");
  const events = [
    { type: "turn/start", seq: 0, time: now - 60_000, data: { turn: 1 } },
    { type: "assistant/message", seq: 1, time: now - 50_000, data: { turn: 1, message: { source: { model: "deepseek-flash" } }, usage: { inputTokens: 1_000_000, outputTokens: 0 } } },
    { type: "turn/end", seq: 2, time: now - 40_000, data: { turn: 1, reason: { kind: "completed" } } },
    { type: "turn/start", seq: 3, time: now - 30_000, data: { turn: 2 } },
    { type: "assistant/message", seq: 4, time: now - 20_000, data: { turn: 2, message: { source: { model: "deepseek-flash" } }, usage: { inputTokens: 0, outputTokens: 1_000_000 } } },
  ];
  const summary = summarizeCost({ events, nowMs: now });
  assert.equal(summary.session.turns, 2);
  assert.equal(summary.session.usd.toFixed(4), (0.15 + 0.6).toFixed(4));
  assert.equal(summary.lastTurn.turn, 2, "the last turn is the one the person's last message started");
  assert.equal(summary.lastTurn.usd.toFixed(4), "0.6000");
  assert.equal(summary.session.unpricedTurns, 0);
  assert.equal(summary.recent.windowMs, 15 * 60 * 1000);
});

test("the recent window projects a per-hour burn rate from messages inside it", () => {
  const now = FRI("12:00");
  const windowMs = 15 * 60 * 1000;
  // One message 5 minutes ago costing $0.15 → $0.60/hour over the 15-minute window.
  const events = [
    { type: "turn/start", seq: 0, time: now - 5 * 60_000, data: { turn: 1 } },
    { type: "assistant/message", seq: 1, time: now - 5 * 60_000, data: { turn: 1, message: { source: { model: "deepseek-flash" } }, usage: { inputTokens: 1_000_000 } } },
  ];
  const summary = summarizeCost({ events, nowMs: now, windowMs });
  assert.equal(summary.recent.messages, 1);
  assert.equal(summary.recent.usd.toFixed(4), "0.1500");
  assert.equal(summary.recent.usdPerHour.toFixed(4), "0.6000");
});

test("messages older than the window do not inflate the burn rate", () => {
  const now = FRI("12:00");
  const events = [
    { type: "assistant/message", seq: 0, time: now - 90 * 60_000, data: { turn: 1, message: { source: { model: "deepseek-flash" } }, usage: { inputTokens: 1_000_000 } } },
  ];
  const summary = summarizeCost({ events, nowMs: now, windowMs: 15 * 60 * 1000 });
  assert.equal(summary.recent.usd, 0);
  assert.equal(summary.recent.usdPerHour, 0);
  assert.equal(summary.session.usd.toFixed(4), "0.1500", "the session total still counts it");
});

test("an empty or unreadable log summarises to zeroes instead of throwing", () => {
  const summary = summarizeCost({ events: [], nowMs: FRI("12:00") });
  assert.equal(summary.lastTurn, null);
  assert.equal(summary.session.usd, 0);
  assert.equal(summary.session.turns, 0);
  assert.equal(summary.recent.usdPerHour, 0);
  assert.equal(summary.pricingReadOn, "2026-10-02");
});

test("convertUsd leaves USD alone and applies the caller's rate otherwise", () => {
  assert.equal(convertUsd(1, "USD", 7.2), 1);
  assert.equal(convertUsd(1, "CNY", 7.2), 7.2);
  assert.equal(convertUsd(1, "CNY", 0), 1, "a missing rate degrades to the raw USD figure");
  assert.equal(convertUsd(1, "CNY", Number.NaN), 1);
});
