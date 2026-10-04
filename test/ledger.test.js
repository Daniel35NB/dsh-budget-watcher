// Cost-ledger tests.
//
// The ledger is the part that decides *which* sessions count as one
// conversation's spend, so these tests are mostly about the tree and about a
// total that must not go backwards when a subagent finishes.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createCostLedger, readOwnEvents } from "../lib/ledger.js";

const FRI = (hhmm) => Date.parse(`2026-10-02T${hhmm}:00Z`);

/**
 * A stand-in session: an id, an optional parent, a log, and the methods the
 * ledger actually uses.
 */
function makeSession({ id, parent, events = [], model }) {
  return {
    id,
    header: parent === undefined ? {} : { parentSession: parent },
    seq: events.length,
    ownEvents: () => events,
    requestContext: () => (model === undefined ? undefined : { provider: "deepseek", model }),
    snapshotEvents: () => {
      const last = events[events.length - 1];
      return [typeof last?.time === "number" ? last : { time: 0 }];
    },
  };
}

/** One assistant message worth `inputTokens` uncached Flash input (off-peak). */
function message(turn, time, { inputTokens = 0, outputTokens = 0, model = "deepseek-flash" } = {}) {
  return {
    type: "assistant/message",
    seq: 0,
    time,
    data: { turn, message: { source: { provider: "deepseek", model } }, usage: { inputTokens, outputTokens } },
  };
}

test("readOwnEvents prefers ownEvents so inherited parent context is not re-billed", () => {
  const session = {
    ownEvents: () => ["own"],
    snapshotEvents: () => ["inherited", "own"],
  };
  assert.deepEqual(readOwnEvents(session), ["own"]);
});

test("readOwnEvents falls back to the snapshot, and to nothing at all", () => {
  assert.deepEqual(readOwnEvents({ snapshotEvents: () => ["a"] }), ["a"]);
  assert.deepEqual(readOwnEvents({}), []);
  assert.deepEqual(readOwnEvents({ ownEvents: () => { throw new Error("boom"); } }), []);
});

test("the ledger sums a root session on its own", () => {
  const root = makeSession({
    id: "s-root",
    events: [
      { type: "turn/start", seq: 0, time: FRI("12:00"), data: { turn: 1 } },
      message(1, FRI("12:01"), { inputTokens: 1_000_000 }),
    ],
  });
  const ledger = createCostLedger({ getSessions: () => [root], windowMs: 15 * 60 * 1000 });
  const summary = ledger.summary({ nowMs: FRI("12:02") });
  assert.equal(summary.sessionId, "s-root");
  assert.equal(summary.session.sessions, 1);
  assert.equal(summary.session.descendants, 0);
  assert.equal(summary.session.cost.toFixed(4), "0.1500");
  assert.equal(summary.thisTurn.turn, 1);
  assert.equal(summary.thisTurn.ended, false, "a turn with no turn/end is still running");
  assert.equal(summary.thisTurn.durationMs, FRI("12:02") - FRI("12:00"), "measured up to now while running");
  // $0.15 over two minutes -> $4.50/hour.
  assert.equal(summary.thisTurn.burnPerHour.toFixed(2), "4.50");
});

test("the burn series samples the windowed rate at each settled step", () => {
  const start = FRI("12:00");
  const root = makeSession({
    id: "s-root",
    events: [
      { type: "turn/start", seq: 0, time: start, data: { turn: 1 } },
      message(1, start + 10_000, { inputTokens: 1_000_000 }),
      message(1, start + 20_000, { inputTokens: 1_000_000 }),
    ],
  });
  const ledger = createCostLedger({ getSessions: () => [root], windowMs: 15_000 });
  const summary = ledger.summary({ nowMs: start + 30_000 });
  const series = summary.thisTurn.series;

  assert.equal(series.length, 2, "one sample per settled step");
  assert.equal(series[0].atMs, 10_000, "timed from the turn's own start");
  assert.equal(series[1].atMs, 20_000);
  // $0.15 alone in the window, over the full 15 s the window spans.
  assert.equal(series[0].amountPerHour.toFixed(2), "36.00");
  // The second step's own window still reaches the first, so the rate doubles.
  assert.equal(series[1].amountPerHour.toFixed(2), "72.00");
});

test("a step older than the window drops out of the series", () => {
  const start = FRI("12:00");
  const root = makeSession({
    id: "s-root",
    events: [
      { type: "turn/start", seq: 0, time: start, data: { turn: 1 } },
      message(1, start + 1_000, { inputTokens: 1_000_000 }),
      message(1, start + 40_000, { inputTokens: 1_000_000 }),
    ],
  });
  const ledger = createCostLedger({ getSessions: () => [root], windowMs: 15_000 });
  const series = ledger.summary({ nowMs: start + 41_000 }).thisTurn.series;

  assert.equal(series[0].amountPerHour.toFixed(2), "36.00");
  // 40 s apart, so the first step is well outside the second's 15 s window: the
  // line steps back down rather than accumulating for ever.
  assert.equal(series[1].amountPerHour.toFixed(2), "36.00");
});

test("a fan-out counts its subagents, which is where a runaway actually burns", () => {
  const root = makeSession({
    id: "s-root",
    events: [{ type: "turn/start", seq: 0, time: FRI("12:00"), data: { turn: 1 } }, message(1, FRI("12:00"), { inputTokens: 100_000 })],
  });
  // 64 subagents each spending the same as a small call: the fire the visible
  // conversation does not show.
  const children = Array.from({ length: 64 }, (_, index) =>
    makeSession({ id: `s-child-${index}`, parent: "s-root", events: [message(1, FRI("12:01"), { inputTokens: 1_000_000 })] }),
  );
  const ledger = createCostLedger({ getSessions: () => [root, ...children], windowMs: 15 * 60 * 1000 });
  const summary = ledger.summary({ nowMs: FRI("12:02") });

  assert.equal(summary.session.sessions, 65);
  assert.equal(summary.session.descendants, 64);
  // 64 x $0.15 + $0.015
  assert.equal(summary.session.cost.toFixed(3), (64 * 0.15 + 0.015).toFixed(3));
  // The turn's own figure now includes the agents it spawned. Attributing by
  // time window rather than by the root's turn numbers is what makes the burn
  // rate reflect the fire instead of the calm.
  assert.equal(summary.thisTurn.cost.toFixed(3), (64 * 0.15 + 0.015).toFixed(3));
  // $9.615 over two minutes -> ~$288/hour.
  assert.equal(summary.thisTurn.burnPerHour.toFixed(0), "288");
  assert.equal(summary.recent.cost.toFixed(3), (64 * 0.15 + 0.015).toFixed(3));
});

test("a finished subagent keeps contributing, so a total never falls", () => {
  const root = makeSession({ id: "s-root", events: [message(1, FRI("12:00"), { inputTokens: 1_000_000 })] });
  const child = makeSession({ id: "s-child", parent: "s-root", events: [message(1, FRI("12:01"), { inputTokens: 1_000_000 })] });
  let live = [root, child];
  const ledger = createCostLedger({ getSessions: () => live, windowMs: 15 * 60 * 1000 });

  const withChild = ledger.summary({ nowMs: FRI("12:02") });
  assert.equal(withChild.session.cost.toFixed(4), "0.3000");

  // The subagent completes and drops out of the live list.
  live = [root];
  const afterChild = ledger.summary({ nowMs: FRI("12:03") });
  assert.equal(afterChild.session.cost.toFixed(4), "0.3000", "spend already incurred must not disappear");
  assert.equal(afterChild.session.sessions, 2);
});

test("a sibling conversation is not counted into this one", () => {
  const root = makeSession({ id: "s-root", events: [message(1, FRI("12:00"), { inputTokens: 1_000_000 })] });
  const other = makeSession({ id: "s-other", events: [message(1, FRI("12:00"), { inputTokens: 9_000_000 })] });
  const ledger = createCostLedger({ getSessions: () => [root, other], windowMs: 15 * 60 * 1000 });

  const summary = ledger.summary({ sessionId: "s-root", nowMs: FRI("12:01") });
  assert.equal(summary.session.sessions, 1);
  assert.equal(summary.session.cost.toFixed(4), "0.1500");
});

test("the client's session id wins over the newest-activity guess", () => {
  const quiet = makeSession({ id: "s-quiet", events: [message(1, FRI("11:00"), { inputTokens: 1_000_000 })] });
  const busy = makeSession({ id: "s-busy", events: [message(1, FRI("12:00"), { inputTokens: 2_000_000 })] });
  const ledger = createCostLedger({ getSessions: () => [quiet, busy], windowMs: 15 * 60 * 1000 });

  assert.equal(ledger.summary({ nowMs: FRI("12:01") }).sessionId, "s-busy", "without a hint, the busiest root wins");
  assert.equal(ledger.summary({ sessionId: "s-quiet", nowMs: FRI("12:01") }).sessionId, "s-quiet");
});

test("a subagent is never chosen as the conversation when no session id is given", () => {
  const root = makeSession({ id: "s-root", events: [message(1, FRI("11:00"), { inputTokens: 1_000_000 })] });
  const child = makeSession({ id: "s-child", parent: "s-root", events: [message(1, FRI("12:00"), { inputTokens: 1_000_000 })] });
  const ledger = createCostLedger({ getSessions: () => [root, child], windowMs: 15 * 60 * 1000 });

  const summary = ledger.summary({ nowMs: FRI("12:01") });
  assert.equal(summary.sessionId, "s-root", "the root is the conversation even when a child is newer");
  assert.equal(summary.session.descendants, 1);
});

test("the recent window is recomputed as time passes, without refolding the log", () => {
  const root = makeSession({ id: "s-root", events: [message(1, FRI("12:00"), { inputTokens: 1_000_000 })] });
  let folds = 0;
  const counted = { ...root, ownEvents: () => { folds += 1; return root.ownEvents(); } };
  const ledger = createCostLedger({ getSessions: () => [counted], windowMs: 10 * 60 * 1000 });

  const early = ledger.summary({ nowMs: FRI("12:05") });
  assert.equal(early.recent.cost.toFixed(4), "0.1500");
  const late = ledger.summary({ nowMs: FRI("12:30") });
  assert.equal(late.recent.cost, 0, "the message has aged out of the window");
  assert.equal(late.session.cost.toFixed(4), "0.1500", "the session total still counts it");
  assert.equal(folds, 1, "an unchanged log is not refolded on every poll");
});

test("no live sessions means no cost section rather than a zero", () => {
  const ledger = createCostLedger({ getSessions: () => [], windowMs: 60_000 });
  assert.equal(ledger.summary({ nowMs: FRI("12:00") }), undefined);
  const missing = createCostLedger({ getSessions: () => undefined, windowMs: 60_000 });
  assert.equal(missing.summary({ nowMs: FRI("12:00") }), undefined);
});

test("a throwing sessions service disables the section instead of failing the route", () => {
  const ledger = createCostLedger({ getSessions: () => { throw new Error("no sessions service"); }, windowMs: 60_000 });
  assert.equal(ledger.summary({ nowMs: FRI("12:00") }), undefined);
});

test("unreadable sessions are skipped, not fatal", () => {
  const broken = { id: "s-broken", header: {}, seq: 3, ownEvents: () => { throw new Error("boom"); } };
  const ledger = createCostLedger({ getSessions: () => [broken], windowMs: 60_000 });
  const summary = ledger.summary({ nowMs: FRI("12:00") });
  assert.equal(summary.sessionId, "s-broken");
  assert.equal(summary.session.cost, 0);
});

test("an unpriced model is reported rather than silently costed at zero", () => {
  const root = makeSession({
    id: "s-root",
    events: [message(1, FRI("12:00"), { inputTokens: 1_000_000, model: "mimo-v2.6-pro" })],
  });
  const ledger = createCostLedger({ getSessions: () => [root], windowMs: 60_000 });
  const summary = ledger.summary({ nowMs: FRI("12:01") });
  assert.equal(summary.session.cost, 0);
  assert.equal(summary.session.unpricedTurns, 1);
});

test("a retried attempt is billed from its stream, using the session's model", () => {
  // A failed attempt settles as `assistant/attempt` with no `usage` and no
  // model; the cost survives only in the stream's last usage chunk. Without
  // this, every retry would be invisible in the total.
  const attempt = {
    type: "assistant/attempt",
    seq: 1,
    time: FRI("12:01"),
    data: {
      turn: 1,
      step: 1,
      stream: [
        { type: "text-chunks", time0: 0, index: 0, dt: [], texts: ["hi"] },
        { type: "chunk", time: 1, chunk: { type: "usage", usage: { inputTokens: 2_000_000, outputTokens: 0 } } },
      ],
    },
  };
  const root = makeSession({
    id: "s-root",
    model: "deepseek-flash",
    events: [{ type: "turn/start", seq: 0, time: FRI("12:00"), data: { turn: 1 } }, attempt],
  });
  const ledger = createCostLedger({ getSessions: () => [root], windowMs: 60_000 });
  const summary = ledger.summary({ nowMs: FRI("12:02") });

  assert.equal(summary.session.cost.toFixed(4), "0.3000", "the retry's 2M uncached tokens are billed");
  assert.equal(summary.thisTurn.attempts, 1);
  assert.equal(summary.thisTurn.messages, 0);
});

test("dispose forgets every fold", () => {
  const root = makeSession({ id: "s-root", events: [message(1, FRI("12:00"), { inputTokens: 1_000_000 })] });
  const ledger = createCostLedger({ getSessions: () => [root], windowMs: 60_000 });
  ledger.summary({ nowMs: FRI("12:01") });
  assert.equal(ledger.size(), 1);
  ledger.dispose();
  assert.equal(ledger.size(), 0);
});
