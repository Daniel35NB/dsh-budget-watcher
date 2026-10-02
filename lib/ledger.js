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

import { foldTurns, pricedMessages } from "./cost.js";

/** Cap on remembered sessions, so a pathological fan-out cannot grow forever. */
const DEFAULT_MAX_SESSIONS = 512;

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
 * @param {number} [options.maxSessions]
 */
export function createCostLedger({ getSessions, windowMs, maxSessions = DEFAULT_MAX_SESSIONS }) {
  /** @type {Map<string, {seq?: number, parent?: string, turns: object[], messages: object[], unpricedTurns: number, lastActivity: number}>} */
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

  /** Fold one session, reusing the previous fold when its log has not moved. */
  function refresh(session) {
    const id = sessionIdOf(session);
    if (id === undefined) return undefined;
    const seq = seqOf(session);
    const known = entries.get(id);
    if (known !== undefined && seq !== undefined && known.seq === seq) {
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
    const turns = foldTurns(events, fallbackModel);
    const messages = pricedMessages(events, fallbackModel);
    const entry = {
      seq,
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
      let usd = 0;
      let turns = 0;
      let unpricedTurns = 0;
      let recentUsd = 0;
      let recentMessages = 0;
      let sessions = 0;
      let descendants = 0;
      let lastActivity = -Infinity;
      const models = new Set();

      for (const [id, entry] of entries) {
        if (!inTree(id, rootId)) continue;
        sessions += 1;
        if (id !== rootId) descendants += 1;
        turns += entry.turns.length;
        unpricedTurns += entry.unpricedTurns;
        lastActivity = Math.max(lastActivity, entry.lastActivity);
        for (const turn of entry.turns) {
          usd += turn.usd;
          for (const model of turn.models) if (model.model !== "") models.add(model.model);
        }
        for (const message of entry.messages) {
          if (message.time < since) continue;
          recentMessages += 1;
          if (message.priced) recentUsd += message.usd;
        }
      }

      // The root's own last turn is what "my last message cost" means; a
      // subagent's turn numbers are its own private sequence.
      const root = entries.get(rootId);
      let lastTurn = null;
      for (const turn of root?.turns ?? []) {
        if (lastTurn === null || turn.turn >= lastTurn.turn) lastTurn = turn;
      }

      const usdPerHour = recentMessages === 0 ? 0 : (recentUsd / windowMs) * 3_600_000;

      return {
        sessionId: rootId,
        lastTurn,
        session: { usd, turns, sessions, descendants, unpricedTurns, models: [...models] },
        recent: { windowMs, usd: recentUsd, messages: recentMessages, usdPerHour, since },
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
