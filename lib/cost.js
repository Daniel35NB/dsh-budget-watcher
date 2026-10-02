// Pure cost model for the DeepSeek API.
//
// This file answers "what did that message cost?" without spending a single
// token of its own: the provider reports exact token usage on every assistant
// message, and DSH records it in the session log. So the estimate is arithmetic
// over numbers that are already on disk, not a model call.
//
// Prices are DeepSeek's published USD rates per 1M tokens. They are the part
// most likely to go stale, so they sit in one table with the date they were
// read, and an unknown model is reported as unpriced rather than guessed at.

/**
 * Date these rates were read from https://api-docs.deepseek.com/quick_start/pricing/.
 * Check that page when DeepSeek announces a change.
 */
export const PRICING_READ_ON = "2026-10-02";

/**
 * USD per 1M tokens. Off-peak is exactly half of peak on every line, but both
 * are listed because a table that only stores one and divides is a table that
 * silently breaks when the ratio changes.
 *
 * @typedef {{cacheHit: number, cacheMiss: number, output: number}} Rates
 */
export const PRICING = {
  "deepseek-flash": {
    label: "DeepSeek-V4.1-Flash",
    peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
    offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  },
  "deepseek-v4-pro": {
    label: "DeepSeek-V4-Pro-0813",
    peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
    offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
  },
};

/**
 * Legacy model names DeepSeek still accepts but bills at the Flash rate. The
 * pricing page states the retired models' requests "are served by the
 * DeepSeek-V4.1-Flash model and billed at the Flash price", so pricing them any
 * other way would over-report.
 */
const ALIASES = {
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
  "deepseek-chat": "deepseek-flash",
  "deepseek-reasoner": "deepseek-flash",
};

/**
 * Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday, excluding
 * Chinese public holidays. Weekends are off-peak in full.
 *
 * The holiday exclusion is the one part this cannot compute: the holiday
 * calendar is not published in the API docs and changes yearly. Treating a
 * holiday weekday as peak **over**states the cost, which is the safe direction
 * for a spend warning.
 *
 * @param {number} atMs epoch milliseconds of the call.
 * @returns {boolean}
 */
export function isPeak(atMs) {
  const at = new Date(atMs);
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/**
 * Resolve a model name to its rate card.
 * @param {string} model
 * @returns {{label: string, peak: Rates, offPeak: Rates} | undefined}
 */
export function pricingFor(model) {
  const name = String(model ?? "").trim().toLowerCase();
  if (name === "") return undefined;
  return PRICING[name] ?? PRICING[ALIASES[name]];
}

/**
 * The `usage` DSH records on an assistant message.
 * @typedef {object} Usage
 * @property {number} [inputTokens]
 * @property {number} [outputTokens]
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheWriteTokens]
 * @property {number} [reasoningTokens]
 */

function count(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Cost in USD of one provider usage report.
 *
 * The bucket semantics are DSH's, and they are not the obvious guess: in a
 * `TokenUsage`, `inputTokens` is the **uncached** input only, and
 * `cacheReadTokens` / `cacheWriteTokens` are separate additional buckets. The
 * DeepSeek adapter states the identity outright —
 * `usage.totalTokens = usage.inputTokens + usage.outputTokens + cacheReadTokens + cacheWriteTokens`
 * (`dsh-llm-deepseek/lib/index.js`) — so subtracting cache reads from
 * `inputTokens` would collapse the uncached half to zero on a well-cached turn
 * and under-report exactly the turns worth watching.
 *
 * DeepSeek's rate card has no separate cache-write line, so cache-write tokens
 * are billed at the uncached input rate. That is the conservative reading and
 * the only one the published prices support.
 *
 * @param {Usage | undefined} usage
 * @param {string} model
 * @param {number} atMs
 * @returns {{usd: number, rates: Rates, peak: boolean, cacheMissTokens: number, cacheReadTokens: number, outputTokens: number} | undefined}
 *   `undefined` when the model has no published rate — never a guessed number.
 */
export function usageCost(usage, model, atMs) {
  if (usage === undefined || usage === null) return undefined;
  const card = pricingFor(model);
  if (card === undefined) return undefined;

  const peak = isPeak(atMs);
  const rates = peak ? card.peak : card.offPeak;

  // Uncached input: `inputTokens` itself, plus any cache-write bucket.
  const cacheMissTokens = count(usage.inputTokens) + count(usage.cacheWriteTokens);
  const cacheReadTokens = count(usage.cacheReadTokens);
  const outputTokens = count(usage.outputTokens);

  const usd = (cacheReadTokens * rates.cacheHit + cacheMissTokens * rates.cacheMiss + outputTokens * rates.output) / 1_000_000;

  return { usd, rates, peak, cacheMissTokens, cacheReadTokens, outputTokens };
}

/** Fold one turn's numbers. */
function emptyTurn(turn) {
  return {
    turn,
    usd: 0,
    // Named for what it is: DSH's `inputTokens` bucket is the uncached half.
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheMissTokens: 0,
    reasoningTokens: 0,
    messages: 0,
    attempts: 0,
    unpricedMessages: 0,
    peak: false,
    models: [],
    startedAt: null,
    endedAt: null,
    lastAt: null,
    ended: false,
  };
}

/**
 * The usage one billed assistant call reports.
 *
 * Two tiers, and this mirrors what DSH itself does: the settled
 * `assistant/message` carries `usage`, but an attempt that failed or was
 * interrupted settles as `assistant/attempt`, which has **no** `usage` field —
 * its numbers survive only in the last `usage` chunk of its stream. Reading
 * just `usage` would silently drop the cost of every retry.
 *
 * @param {{type: string, data: any}} event
 */
export function usageOf(event) {
  const direct = event?.data?.usage;
  if (typeof direct === "object" && direct !== null) return direct;

  const stream = event?.data?.stream;
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record?.type === "usage" && typeof record.usage === "object" && record.usage !== null) return record.usage;
    const chunk = record?.chunk;
    if (chunk?.type === "usage" && typeof chunk.usage === "object" && chunk.usage !== null) return chunk.usage;
  }
  return undefined;
}

/**
 * Every assistant call in a log that was billed, in order.
 *
 * An `assistant/attempt` event names no model — the agent loop writes it on the
 * failure and interrupt paths with only `{ turn, step, stream }`. The retry is
 * the same request, so the model comes from the turn it belongs to, falling
 * back to the session's own request context.
 *
 * @param {readonly object[]} events
 * @param {string} [fallbackModel]
 */
export function collectBilledUnits(events, fallbackModel = "") {
  const units = [];
  for (const event of events ?? []) {
    if (event === null || typeof event !== "object") continue;
    if (event.type === "assistant/message") {
      units.push({
        turn: event.data?.turn,
        time: event.time,
        kind: "message",
        model: event.data?.message?.source?.model ?? "",
        provider: event.data?.message?.source?.provider ?? "",
        usage: usageOf(event),
      });
    } else if (event.type === "assistant/attempt") {
      units.push({ turn: event.data?.turn, time: event.time, kind: "attempt", model: "", provider: "", usage: usageOf(event) });
    }
  }

  const modelByTurn = new Map();
  for (const unit of units) {
    if (unit.model !== "") modelByTurn.set(unit.turn, unit.model);
  }
  for (const unit of units) {
    if (unit.model === "") unit.model = modelByTurn.get(unit.turn) ?? (fallbackModel === "" ? "" : fallbackModel);
  }
  return units;
}

/**
 * Fold a session's events into per-turn token and cost totals.
 *
 * `turn/start` and `turn/end` bound turns; every billed assistant call inside
 * one adds to it. Tool calls and results carry no usage of their own — their
 * tokens are inside the next assistant call's prompt, which is exactly why a
 * fan-out turn shows up as one enormous number.
 *
 * @param {readonly {type: string, seq: number, time: number, data: any}[]} events
 * @param {string} [fallbackModel] session model, for an attempt whose turn has no message yet.
 * @returns {object[]} turns in ascending order.
 */
export function foldTurns(events, fallbackModel = "") {
  const turns = [];
  const byNumber = new Map();

  const open = (turn, time) => {
    if (!byNumber.has(turn)) {
      const created = emptyTurn(turn);
      byNumber.set(turn, created);
      turns.push(created);
    }
    const found = byNumber.get(turn);
    if (found.startedAt === null) found.startedAt = time;
    return found;
  };

  for (const event of events ?? []) {
    if (event === null || typeof event !== "object") continue;
    const data = event.data ?? {};
    if (event.type === "turn/start") open(data.turn, event.time);
    else if (event.type === "turn/end") {
      const turn = open(data.turn, event.time);
      turn.endedAt = event.time;
      turn.ended = true;
    }
  }

  for (const unit of collectBilledUnits(events, fallbackModel)) {
    const turn = open(unit.turn, unit.time);
    turn.lastAt = unit.time;

    const usage = unit.usage;
    if (unit.kind === "message") {
      turn.messages += 1;
      if (unit.model !== "" && !turn.models.some((entry) => entry.model === unit.model)) {
        turn.models.push({ provider: unit.provider, model: unit.model });
      }
    } else {
      turn.attempts += 1;
    }

    turn.uncachedInputTokens += count(usage?.inputTokens);
    turn.outputTokens += count(usage?.outputTokens);
    turn.cacheReadTokens += count(usage?.cacheReadTokens);
    turn.reasoningTokens += count(usage?.reasoningTokens);

    const priced = usageCost(usage, unit.model, unit.time);
    if (priced === undefined) {
      // No usage report at all, or a model with no published rate. Either way
      // this is an unknown cost, not a free one.
      turn.unpricedMessages += 1;
    } else {
      turn.usd += priced.usd;
      turn.cacheMissTokens += priced.cacheMissTokens;
      turn.peak = priced.peak;
    }
  }

  return turns;
}

/**
 * Price every billed assistant call in a log individually.
 *
 * The window question ("what have we spent in the last N minutes") is a
 * message-time question, so it is answered from this list rather than from
 * turn totals: a fanned-out turn can run for twenty minutes and never close,
 * and a turn-level figure would stay silent for exactly that whole time.
 *
 * @param {readonly object[]} events
 * @param {string} [fallbackModel]
 * @returns {{time: number, usd: number, priced: boolean, model: string, kind: string}[]}
 */
export function pricedMessages(events, fallbackModel = "") {
  return collectBilledUnits(events, fallbackModel).map((unit) => {
    const cost = usageCost(unit.usage, unit.model, unit.time);
    return {
      time: typeof unit.time === "number" ? unit.time : 0,
      usd: cost?.usd ?? 0,
      priced: cost !== undefined,
      model: unit.model,
      kind: unit.kind,
    };
  });
}

/**
 * The summary the panel renders.
 *
 * `recent` is the early-warning number. A turn that fans out to dozens of
 * subagents does not finish, so a "cost of the last completed turn" would stay
 * silent through exactly the runaway this is meant to catch. Cost is therefore
 * accumulated per assistant message with its own timestamp, and the recent
 * window reports what the session has spent in the last few minutes and what
 * that projects to per hour.
 *
 * @param {object} input
 * @param {readonly object[]} input.events session events.
 * @param {number} input.nowMs
 * @param {number} [input.windowMs] recent-burn window, default 15 minutes.
 * @param {number} [input.sessionStartedAt]
 */
export function summarizeCost({ events, nowMs, windowMs = 15 * 60 * 1000, sessionStartedAt = null, fallbackModel = "" }) {
  const turns = foldTurns(events, fallbackModel);
  const messages = pricedMessages(events, fallbackModel);

  let usd = 0;
  let uncachedInputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let unpricedTurns = 0;

  const since = nowMs - windowMs;
  let recentUsd = 0;
  let recentMessages = 0;
  for (const message of messages) {
    if (message.time < since) continue;
    recentMessages += 1;
    if (message.priced) recentUsd += message.usd;
  }

  let lastTurn = null;
  for (const turn of turns) {
    usd += turn.usd;
    uncachedInputTokens += turn.uncachedInputTokens;
    outputTokens += turn.outputTokens;
    cacheReadTokens += turn.cacheReadTokens;
    if (turn.unpricedMessages > 0) unpricedTurns += 1;
    if (lastTurn === null || turn.turn >= lastTurn.turn) lastTurn = turn;
  }

  const burnPerHour = recentMessages === 0 ? 0 : (recentUsd / windowMs) * 3_600_000;

  return {
    pricingReadOn: PRICING_READ_ON,
    lastTurn,
    session: { usd, turns: turns.length, uncachedInputTokens, outputTokens, cacheReadTokens, unpricedTurns },
    recent: {
      windowMs,
      usd: recentUsd,
      messages: recentMessages,
      usdPerHour: burnPerHour,
      since,
    },
    messages,
    sessionStartedAt,
    nowMs,
  };
}

/**
 * Convert a USD estimate for display next to a balance held in another
 * currency. The rate is the caller's, because the plugin has no exchange-rate
 * source and inventing one silently would be worse than asking.
 *
 * @param {number} usd
 * @param {string} currency
 * @param {number} usdToCny
 * @returns {number}
 */
export function convertUsd(usd, currency, usdToCny) {
  const code = String(currency ?? "").trim().toUpperCase();
  if (code === "USD" || !Number.isFinite(usdToCny) || usdToCny <= 0) return usd;
  return usd * usdToCny;
}
