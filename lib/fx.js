// A USD→CNY rate, from a central bank, for the third-party models that only
// publish USD prices.
//
// Why this file exists: DeepSeek publishes its prices in both CNY and USD, so the
// plugin never needed a rate. Every other provider publishes USD only, and a CNY
// account still wants one total. Earlier that was solved by asking the user for a
// rate by hand; it does not have to be, because the ECB publishes a daily
// reference rate as a 1.5 KB XML file with no key and no auth.
//
// Two honest caveats, both recorded in the README's known limitations:
//
//  * The ECB quotes against the euro, so USD→CNY is a *cross* rate —
//    (EUR→CNY) / (EUR→USD) — not the PBOC's 中间价. The PBOC's own fixing exists
//    but has no machine-readable endpoint, so this is the reliable option rather
//    than the perfect one.
//  * A reference rate is a mid-market rate, not the rate you are actually billed
//    at. Card spreads and a provider's own conversion both move the real number,
//    so every converted figure stays marked as approximate.

/**
 * The ECB's daily reference rates. One file, all currencies, EUR-based.
 * Published on business days, so at a weekend this is Friday's rate.
 */
export const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

/** How long a fetched rate is trusted before another fetch is attempted. */
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

/** A rate is a small thing; if the answer takes this long, give up on it. */
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * How long to wait before trying again after a failure.
 *
 * Without this, a fetch that fails would be retried on every panel poll — every
 * three seconds, forever — because a failure leaves nothing cached to make the
 * next call a no-op. Attempts are rate-limited, not just successes.
 */
const DEFAULT_RETRY_MS = 5 * 60 * 1000;

/**
 * Pull the date and the USD→CNY cross rate out of the ECB's daily XML.
 *
 * Pure, so the arithmetic is testable without a network. Returns `undefined`
 * rather than throwing or guessing whenever anything is missing or implausible —
 * a wrong rate is worse than no rate, because it would quietly scale every
 * third-party figure.
 *
 * @param {string} xml
 * @returns {{date: string | null, usdToCny: number, usdPerEur: number, cnyPerEur: number} | undefined}
 */
export function parseEcbDaily(xml) {
  if (typeof xml !== "string" || xml === "") return undefined;

  const usd = /currency=["']USD["']\s+rate=["']([0-9.]+)["']/.exec(xml);
  const cny = /currency=["']CNY["']\s+rate=["']([0-9.]+)["']/.exec(xml);
  if (usd === null || cny === null) return undefined;

  const usdPerEur = Number(usd[1]);
  const cnyPerEur = Number(cny[1]);
  if (!Number.isFinite(usdPerEur) || !Number.isFinite(cnyPerEur) || usdPerEur <= 0 || cnyPerEur <= 0) {
    return undefined;
  }

  const usdToCny = cnyPerEur / usdPerEur;
  // A sanity band, not a prediction: outside this the feed is broken or the file
  // is not what we think it is, and a silent 10x would be invisible on screen.
  if (usdToCny < 3 || usdToCny > 15) return undefined;

  const date = /time=["']([0-9]{4}-[0-9]{2}-[0-9]{2})["']/.exec(xml);
  return { date: date === null ? null : date[1], usdToCny, usdPerEur, cnyPerEur };
}

/**
 * Read the `usdToCny` setting, which is deliberately one field with two modes.
 *
 * `"auto"` — the default — means fetch a central-bank rate and keep it current.
 * A number means "use this and do not ask anyone", which is the older behaviour
 * and still the right answer behind a corporate proxy, on an air-gapped machine,
 * or when you simply want the figure you were billed at rather than a mid-market
 * rate. Keeping it as one field rather than a mode flag plus a number means the
 * settings tab needs one input, and the value you see is the value in force.
 *
 * @param {unknown} value
 * @returns {{mode: "auto" | "fixed", enabled: boolean, fallback: number}}
 */
export function parseFxSetting(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return { mode: "fixed", enabled: false, fallback: value };
  }
  const text = String(value ?? "").trim();
  if (text !== "" && text.toLowerCase() !== "auto") {
    const numeric = Number(text);
    if (Number.isFinite(numeric) && numeric > 0) return { mode: "fixed", enabled: false, fallback: numeric };
  }
  return { mode: "auto", enabled: true, fallback: 0 };
}

/**
 * A rate that resolves with the fallbacks a spend estimate actually needs.
 *
 * Order: a rate still inside its TTL, then a fresh fetch, then the last rate that
 * ever worked, then the configured fallback. It never throws, and it never returns
 * a made-up number: when everything fails it reports no rate, and the caller is
 * expected to leave USD-published models in USD rather than convert them at a
 * guess.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] injectable for tests.
 * @param {number} [options.fallback] a rate the user configured; 0 means none.
 * @param {boolean} [options.enabled] false to skip the network entirely.
 * @param {number} [options.ttlMs]
 * @param {number} [options.retryMs] how long to wait before retrying after a failure.
 * @param {number} [options.timeoutMs]
 * @param {() => number} [options.now]
 */
export function createFxCache({ fetchImpl = fetch, fallback = 0, enabled = true, ttlMs = DEFAULT_TTL_MS, retryMs = DEFAULT_RETRY_MS, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now } = {}) {
  /** @type {{usdToCny: number, date: string | null, source: string, fetchedAt: string, fetchedAtMs: number} | undefined} */
  let last;
  /** When the last *attempt* started, successful or not, so failures back off too. */
  let lastAttemptMs = 0;
  let inflight;

  const configured = Number.isFinite(Number(fallback)) && Number(fallback) > 0 ? Number(fallback) : 0;

  async function fetchOnce(force) {
    // Sharing an in-flight attempt comes *before* the backoff, or concurrent
    // callers would see the attempt they are themselves waiting on as "recently
    // tried" and give up instead of joining it.
    if (inflight !== undefined) return inflight;
    if (!force && lastAttemptMs !== 0 && now() - lastAttemptMs < retryMs) return undefined;
    lastAttemptMs = now();
    inflight = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(ECB_DAILY_URL, { signal: controller.signal, headers: { accept: "application/xml,text/xml" } });
        if (!response?.ok) return undefined;
        const parsed = parseEcbDaily(await response.text());
        if (parsed === undefined) return undefined;
        last = { ...parsed, source: "ecb", fetchedAt: new Date().toISOString(), fetchedAtMs: now() };
        return last;
      } catch {
        // Offline, blocked, timed out, or a body that is not the file we expect.
        // All the same to the caller: no new rate this time.
        return undefined;
      } finally {
        clearTimeout(timer);
        inflight = undefined;
      }
    })();
    return inflight;
  }

  return {
    /**
     * @param {boolean} [force] ignore the TTL, e.g. because the user asked.
     * @returns {Promise<{usdToCny: number, date: string | null, source: string, stale: boolean} | undefined>}
     */
    async resolve(force = false) {
      if (enabled !== false) {
        const fresh = last !== undefined && now() - last.fetchedAtMs < ttlMs;
        if (fresh && !force) return { ...last, stale: false };
        // A failed attempt must not be retried on every poll — the panel polls
        // every few seconds, and a dead endpoint would be hammered indefinitely.
        // `fetchOnce` owns that decision, so it can tell "backing off" apart from
        // "an attempt is already running".
        const fetched = await fetchOnce(force);
        if (fetched !== undefined) return { ...fetched, stale: false };
      }
      // A rate that worked before beats a rate someone typed months ago, and both
      // beat converting at a guess.
      if (last !== undefined) return { ...last, stale: true };
      if (configured > 0) return { usdToCny: configured, date: null, source: "configured", stale: true };
      return undefined;
    },

    /** What is known right now, without touching the network. */
    snapshot() {
      if (last !== undefined) return { ...last, stale: now() - last.fetchedAtMs >= ttlMs };
      if (configured > 0) return { usdToCny: configured, date: null, source: "configured", stale: true };
      return undefined;
    },
  };
}
