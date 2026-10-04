// Cost ledger over the live agent tree.
//
// The reason this exists at all: the runaway this plugin is meant to catch is a
// fan-out. A research skill hands 64 URLs to subagents, each subagent makes its
// own billed calls into its own session log, and the conversation you are
// looking at shows one turn that has not finished. Folding only the visible
// session would report the calm, not the fire.
//
// So the ledger folds the selected session *and* every descendant session, and
// keeps a finished descendant's figures after it leaves the live agent list —
// without that, a session total would fall as subagents complete, which is the
// one direction a spend counter must never move.
//
// Nothing here is DSH-specific beyond two method names, which is what lets the
// tests drive it with a plain object.

import { burnPerHour, foldTurns, normalizeCostCurrency, pricedMessages } from "./cost.js";

/** Cap on remembered sessions, so a pathological fan-out cannot grow forever. */
const DEFAULT_MAX_SESSIONS = 512;

/** How many closed turns the panel keeps for comparing one task against another. */
const DEFAULT_TURN_HISTORY = 10;

/** Cap on the burn series sent for the chart, so a fan-out cannot bloat the payload. */
const MAX_SERIES_POINTS = 240;

/**
 * Read a session's own events.
 *
 * `ownEvents()` is preferred over `snapshotEvents()`: a subagent session carries
 * its parent's events as inherited context, and those assistant messages were
 * already billed in the parent's turn. Counting them again would double-charge
 * every subagent for the context it was handed.
 *
 * @param {object} session
 * @returns {readonly object[]}
 */
export function readOwnEvents(session) {
  try {
    if (typeof session.ownEvents === "function") return session.ownEvents() ?? [];
  } catch {
    /* fall through to the snapshot path */
  }
  try {
    if (typeof session.snapshotEvents === "function") return session.snapshotEvents() ?? [];
  } catch {
    /* an unreadable session contributes nothing rather than failing the poll */
  }
  return [];
}

function sessionIdOf(session) {
  try {
    const id = session?.id;
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
}

function parentIdOf(session) {
  try {
    const parent = session?.header?.parentSession;
    return typeof parent === "string" && parent !== "" ? parent : undefined;
  } catch {
    return undefined;
  }
}

function seqOf(session) {
  try {
    const seq = Number(session?.seq);
    return Number.isFinite(seq) ? seq : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Timestamp of a session's newest event, without reading the whole log.
 *
 * `snapshotEvents(seq - 1)` asks for the single event at the tail, which is
 * O(1) and is what makes "which session is the user actually in" cheap enough
 * to answer on every poll.
 */
function lastEventTimeOf(session) {
  const seq = seqOf(session);
  if (seq === undefined || seq <= 0) return -1;
  try {
    const tail = session.snapshotEvents(seq - 1);
    const last = tail?.[tail.length - 1];
    return typeof last?.time === "number" ? last.time : -1;
  } catch {
    return -1;
  }
}

/**
 * @param {object} options
 * @param {() => object[]} options.getSessions returns the live sessions for each poll.
 * @param {number} options.windowMs recent-spend window.
 * @param {() => string} [options.getCurrency] which currency to price in. A getter, not a value:
 *   the currency follows the featured wallet, which is only known after the first balance read,
 *   while the ledger is built during plugin load.
 * @param {number} [options.maxSessions]
 */
export function createCostLedger({ getSessions, windowMs, getCurrency = () => "USD", maxSessions = DEFAULT_MAX_SESSIONS }) {
  /** @type {Map<string, {seq?: number, currency?: string, parent?: string, turns: object[], messages: object[], unpricedTurns: number, lastActivity: number}>} */
  const entries = new Map();

  function liveSessions() {
    let list;
    try {
      list = getSessions();
    } catch {
      return [];
    }
    if (!Array.isArray(list)) return [];
    return list.filter((session) => sessionIdOf(session) !== undefined);
  }

  /** Fold one session, reusing the previous fold when its log and currency have not moved. */
  function refresh(session) {
    const id = sessionIdOf(session);
    if (id === undefined) return undefined;
    const seq = seqOf(session);
    const currency = normalizeCostCurrency(getCurrency());
    const known = entries.get(id);
    if (known !== undefined && seq !== undefined && known.seq === seq && known.currency === currency) {
      known.lastActivity = lastEventTimeOf(session);
      return known;
    }

    const events = readOwnEvents(session);
    // An `assistant/attempt` names no model. The session's own request context
    // is the right stand-in: a retry retries the same request.
    let fallbackModel = "";
    try {
      fallbackModel = session.requestContext?.()?.model ?? "";
    } catch {
      /* no context yet: attempts in this session stay unpriced rather than mispriced */
    }
    const turns = foldTurns(events, fallbackModel, currency);
    const messages = pricedMessages(events, fallbackModel, currency);
    const entry = {
      seq,
      currency,
      parent: parentIdOf(session),
      turns,
      messages,
      unpricedTurns: turns.filter((turn) => turn.unpricedMessages > 0).length,
      lastActivity: lastEventTimeOf(session),
    };
    entries.set(id, entry);

    if (entries.size > maxSessions) {
      // Drop the least recently active entries, but never the ones a caller
      // might still be walking a parent chain through: keep the newest.
      const ordered = [...entries.entries()].sort((a, b) => a[1].lastActivity - b[1].lastActivity);
      for (const [oldest] of ordered.slice(0, entries.size - maxSessions)) entries.delete(oldest);
    }
    return entry;
  }

  /** Does `id` belong to the tree rooted at `rootId`? */
  function inTree(id, rootId) {
    let cursor = id;
    for (let depth = 0; depth < 64; depth += 1) {
      if (cursor === rootId) return true;
      const entry = entries.get(cursor);
      if (entry?.parent === undefined) return false;
      cursor = entry.parent;
    }
    return false;
  }

  return {
    /**
     * @param {object} [options]
     * @param {string} [options.sessionId] the session the client is showing, when it knows.
     * @param {number} [options.nowMs]
     */
    summary({ sessionId, nowMs = Date.now() } = {}) {
      const live = liveSessions();
      for (const session of live) refresh(session);

      if (entries.size === 0) return undefined;

      // Prefer the session the client named. Otherwise fall back to the live
      // session with the newest event, which is the conversation being typed
      // into in every ordinary case.
      let rootId;
      if (sessionId !== undefined && entries.has(sessionId)) {
        rootId = sessionId;
      } else {
        let newest = -Infinity;
        for (const session of live) {
          const id = sessionIdOf(session);
          if (id === undefined) continue;
          const entry = entries.get(id);
          // Only a root can be "the conversation": a subagent is never it.
          if (entry?.parent !== undefined) continue;
          if (entry.lastActivity > newest) {
            newest = entry.lastActivity;
            rootId = id;
          }
        }
        if (rootId === undefined) rootId = [...entries.keys()][0];
      }

      const since = nowMs - windowMs;
      let cost = 0;
      let turns = 0;
      let unpricedTurns = 0;
      let recentCost = 0;
      let recentMessages = 0;
      let sessions = 0;
      let descendants = 0;
      let lastActivity = -Infinity;
      const models = new Set();
      /** Every billed call in the tree, for attribution by time window. */
      const units = [];

      for (const [id, entry] of entries) {
        if (!inTree(id, rootId)) continue;
        sessions += 1;
        if (id !== rootId) descendants += 1;
        turns += entry.turns.length;
        unpricedTurns += entry.unpricedTurns;
        lastActivity = Math.max(lastActivity, entry.lastActivity);
        for (const turn of entry.turns) {
          cost += turn.cost;
          for (const model of turn.models) if (model.model !== "") models.add(model.model);
        }
        for (const message of entry.messages) {
          units.push(message);
          if (message.time < since) continue;
          recentMessages += 1;
          if (message.priced) recentCost += message.cost;
        }
      }

      /**
       * Everything the whole tree spent inside one turn's wall-clock window.
       *
       * Attribution is by TIME, not by turn number, and that is the point: a
       * fanned-out turn bills almost entirely in its subagents, whose turn
       * numbers are their own private sequences. Summing only the root's own
       * turns would report a calm rate while sixty agents burn — the exact case
       * this number exists to catch.
       */
      const windowTotals = (from, to) => {
        let cost = 0;
        let messages = 0;
        let attempts = 0;
        let unpriced = 0;
        let uncachedInputTokens = 0;
        let cacheReadTokens = 0;
        let outputTokens = 0;
        for (const unit of units) {
          if (unit.time < from || unit.time > to) continue;
          if (unit.kind === "attempt") attempts += 1;
          else messages += 1;
          uncachedInputTokens += unit.uncachedInputTokens ?? 0;
          cacheReadTokens += unit.cacheReadTokens ?? 0;
          outputTokens += unit.outputTokens ?? 0;
          if (unit.priced) cost += unit.cost;
          else unpriced += 1;
        }
        return { cost, messages, attempts, unpriced, uncachedInputTokens, cacheReadTokens, outputTokens };
      };

      /**
       * The live-burn series for one turn: the trailing-window rate evaluated at
       * each moment something was billed.
       *
       * Sampling at billing events rather than on a clock is the honest choice.
       * Between two settled steps nothing has been spent, so the rate is an
       * average of an unchanged total and there is no new fact to draw; the
       * client extends the line from the last sample to now.
       *
       * The denominator is the full window, matching `recent.costPerHour`, so the
       * drawn line and the `live burn` row are the same number rather than two
       * definitions of one idea.
       */
      const seriesInWindow = (from, to) => {
        const within = units.filter((unit) => unit.time >= from && unit.time <= to).sort((a, b) => a.time - b.time);
        if (within.length === 0) return [];
        // Thin rather than truncate: the shape of the whole turn matters more
        // than every sample of it, and a fan-out can bill hundreds of times.
        const step = Math.ceil(within.length / MAX_SERIES_POINTS);
        const points = [];
        for (let index = 0; index < within.length; index += step) {
          const unit = within[index];
          const windowStart = unit.time - windowMs;
          let sum = 0;
          for (let back = index; back >= 0; back -= 1) {
            const other = within[back];
            if (other.time < windowStart) break;
            if (other.priced) sum += other.cost;
          }
          points.push({
            atMs: Math.max(0, Math.round(unit.time - from)),
            amountPerHour: Math.round(burnPerHour(sum, windowMs) * 100) / 100,
          });
        }
        return points;
      };

      // The root's own turns define the conversation's timeline; a subagent's
      // turn numbers are its own private sequence.
      const rootTurns = entries.get(rootId)?.turns ?? [];
      const running = rootTurns[rootTurns.length - 1] ?? null;

      let thisTurn = null;
      if (running !== null && typeof running.startedAt === "number") {
        // A running turn is measured up to now; a closed one up to its own end,
        // which is what freezes the figure.
        const to = running.endedAt ?? nowMs;
        const totals = windowTotals(running.startedAt, to);
        const durationMs = Math.max(0, to - running.startedAt);
        thisTurn = {
          turn: running.turn,
          ended: running.ended === true,
          startedAt: running.startedAt,
          endedAt: running.endedAt ?? null,
          durationMs,
          cost: totals.cost,
          messages: totals.messages,
          attempts: totals.attempts,
          unpricedMessages: totals.unpriced,
          uncachedInputTokens: totals.uncachedInputTokens,
          cacheReadTokens: totals.cacheReadTokens,
          outputTokens: totals.outputTokens,
          models: running.models.map((entry) => entry.model),
          burnPerHour: burnPerHour(totals.cost, durationMs),
          series: seriesInWindow(running.startedAt, to),
        };
      }

      // Closed turns, newest last, so two finished tasks can be compared. Capped
      // because this is a panel figure, not an analytics table.
      const closed = rootTurns.filter((turn) => turn.ended === true && typeof turn.startedAt === "number");
      const history = closed.slice(-DEFAULT_TURN_HISTORY).map((turn) => {
        const to = turn.endedAt ?? turn.startedAt;
        const totals = windowTotals(turn.startedAt, to);
        const durationMs = Math.max(0, to - turn.startedAt);
        return {
          turn: turn.turn,
          endedAt: to,
          durationMs,
          cost: totals.cost,
          messages: totals.messages,
          burnPerHour: burnPerHour(totals.cost, durationMs),
        };
      });

      const recentPerHour = recentMessages === 0 ? 0 : (recentCost / windowMs) * 3_600_000;

      return {
        sessionId: rootId,
        currency: normalizeCostCurrency(getCurrency()),
        thisTurn,
        turns: history,
        session: { cost, turns, sessions, descendants, unpricedTurns, models: [...models] },
        recent: { windowMs, cost: recentCost, messages: recentMessages, costPerHour: recentPerHour, since },
        lastActivity: lastActivity === -Infinity ? null : lastActivity,
      };
    },

    /** Forget everything. Used when the plugin unloads. */
    dispose() {
      entries.clear();
    },

    /** Exposed for tests: how many sessions are remembered. */
    size() {
      return entries.size;
    },
  };
}
