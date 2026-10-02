// dsh-budget-watcher — host half.
//
// Answers one question for the client half: how much topped-up balance is left
// on the API account this profile is using? Today that means exactly one
// provider, DeepSeek's public `GET /user/balance`, whose `topped_up_balance`
// field is the money the user actually paid in — as opposed to the promotional
// `granted_balance` that expires.
//
// Three design constraints shape this file:
//
//  * The provider call needs the user's API key, so it can only happen here, in
//    the host. A browser cannot call api.deepseek.com: the key would be exposed
//    and the API sends no CORS headers.
//  * One poll must serve every open window, so the last answer is cached and
//    concurrent requests share a single in-flight upstream call.
//  * Nothing here may take the profile down. Every optional service is read with
//    `ctx.get`, every import that could fail is dynamic, and a fetch failure is
//    reported as a state the widget renders rather than an exception that
//    escapes into the loader.

import { describeHttpFailure, normalizeBalance, pickWallet } from "./lib/balance.js";
import { convertUsd } from "./lib/cost.js";
import { createCostLedger } from "./lib/ledger.js";

/** Base path for this plugin's routes. Owned by the plugin, outside `/api`. */
const ROUTE_BASE = "/dsh-budget-watcher";
const STATE_PATH = `${ROUTE_BASE}/balance`;
/** Write path for the settings tab. Same fence, JSON body required. */
const CONFIG_PATH = `${ROUTE_BASE}/config`;

/** Refuse to buffer more than this from the balance endpoint. */
const MAX_BODY_BYTES = 64 * 1024;

const DEFAULT_REFRESH_MS = 60_000;
const MIN_REFRESH_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Recent-spend window for the burn-rate warning: short enough to catch a runaway. */
const DEFAULT_BURN_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_BURN_WARN_USD_PER_HOUR = 2;
/**
 * USD→CNY used only to place a USD-priced estimate beside a CNY balance. This
 * is an approximation and a configurable one: the plugin has no exchange-rate
 * source, and quietly inventing a rate would make a spend warning less
 * trustworthy, not more.
 */
const DEFAULT_USD_TO_CNY = 7.2;

/**
 * Reported in every payload.
 *
 * A host plugin's module is imported once and cached for the life of the DSH
 * process, so editing a loaded plugin's source has no effect until that process
 * restarts. Without a marker in the response there is no way to tell a stale
 * module from a plugin that simply has nothing to report — which is exactly the
 * confusion this field exists to end. Keep it in step with package.json.
 */
const PLUGIN_VERSION = "0.2.0";

/**
 * Providers this plugin can read. Only DeepSeek is implemented; the table
 * exists so a second provider is an addition rather than a rewrite of the
 * request path, which is the shape the feature was asked for.
 *
 * `credentialRef` is an environment-variable-style name resolved through
 * `ctx.credentials` — `DEEPSEEK_API_KEY` is the same reference the shipped
 * DeepSeek LLM adapter uses, so one key configured in the Models page serves
 * both inference and this widget.
 */
const PROVIDERS = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/user/balance",
    credentialRef: "DEEPSEEK_API_KEY",
  },
};

// schemastery gives the profile real validation and a settings UI. It is
// imported dynamically because a third-party plugin must keep working when the
// import fails: a static import of a package this installation does not carry
// would stop the whole profile from loading, which is a far worse outcome than
// losing config validation.
let Schema;
try {
  ({ default: Schema } = await import("@deepseek-ai/schemastery"));
} catch {
  Schema = undefined;
}

/** Validated configuration, or `undefined` when schemastery is unavailable. */
export const Config = Schema?.object({
  provider: Schema.string().default("deepseek").description("Which API account to read. Only `deepseek` is implemented."),
  apiKey: Schema.string().role("secret").description("Explicit API key. When empty, the key is resolved from the credential reference below."),
  apiKeyEnv: Schema.string().default("DEEPSEEK_API_KEY").description("Credential reference holding the API key, resolved through the credentials service."),
  endpoint: Schema.string().description("Override the balance endpoint. Meant for testing against a stand-in server."),
  refreshIntervalMs: Schema.natural().min(MIN_REFRESH_MS).default(DEFAULT_REFRESH_MS).description(`How long one balance answer is reused before the next request, in milliseconds (minimum ${MIN_REFRESH_MS}).`),
  requestTimeoutMs: Schema.natural().min(1000).max(120_000).default(DEFAULT_TIMEOUT_MS).description("Deadline for one balance request, in milliseconds."),
  currency: Schema.string().default("auto").description("Currency to feature in the widget: `auto`, or an explicit code such as `CNY` or `USD`."),
  allowNonLoopback: Schema.boolean().default(false).description("Allow the widget to read balance when the GUI is served on a non-loopback address. Off by default: the route trusts its host, which is only sound on loopback."),
  costEnabled: Schema.boolean().default(true).description("Estimate what recent turns cost, from the token usage the provider already reports on every assistant message. Costs nothing extra: no API call and no tokens are spent."),
  burnWindowMs: Schema.natural().min(60_000).default(DEFAULT_BURN_WINDOW_MS).description(`Window for the recent-spend rate, in milliseconds (minimum 60000). This is the runaway warning.`),
  burnWarnUsdPerHour: Schema.number().min(0).default(DEFAULT_BURN_WARN_USD_PER_HOUR).description("Projected USD per hour above which the panel flags the spend. 0 disables the warning."),
  usdToCny: Schema.number().min(0).default(DEFAULT_USD_TO_CNY).description("Rate used to express USD API spend beside a CNY balance. An approximation, and yours to set: the plugin has no exchange-rate source."),
  costCurrency: Schema.string().default("auto").description("Currency to show cost estimates in: `auto` follows the featured balance currency, or an explicit code such as `CNY` or `USD`."),
});

/**
 * Read the API key at the moment of the call.
 *
 * Resolution is deliberately not cached: a key saved from the Models page
 * reaches the next poll without restarting anything, which is what the
 * credentials service promises its consumers.
 *
 * @returns {Promise<{ value: string, source: string } | undefined>}
 */
async function resolveApiKey(ctx, settings) {
  if (settings.apiKey !== "") return { value: settings.apiKey, source: "config" };

  const credentials = ctx.get("credentials");
  if (credentials !== undefined) {
    // `credentialRef` is a branded string at runtime, so the plain name the
    // config already holds is a valid reference.
    const hit = await credentials.resolve(settings.apiKeyEnv);
    if (hit !== undefined && hit.value !== "") return { value: hit.value, source: hit.source ?? "credentials" };
  }

  const ambient = process.env[settings.apiKeyEnv];
  if (typeof ambient === "string" && ambient !== "") return { value: ambient, source: "environment" };
  return undefined;
}

/**
 * Fetch and normalize one balance answer.
 *
 * `redirect: "error"` keeps a bearer token from being replayed to whatever a
 * redirect points at. The proxy is not configured here on purpose: the launcher
 * installs one global dispatcher before any plugin loads, and passing our own
 * would silently bypass it.
 *
 * @returns {Promise<{ ok: true, isAvailable: boolean, wallets: object[] }
 *   | { ok: false, code: string, message: string }>}
 */
async function fetchBalance(ctx, settings, provider, signal) {
  const key = await resolveApiKey(ctx, settings);
  if (key === undefined) {
    return {
      ok: false,
      code: "no-key",
      message: `No API key is configured. Add one in Settings, or export ${settings.apiKeyEnv}.`,
    };
  }

  const endpoint = settings.endpoint === "" ? provider.endpoint : settings.endpoint;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json", authorization: `Bearer ${key.value}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(settings.requestTimeoutMs)]),
    });
  } catch (error) {
    if (signal.aborted) return { ok: false, code: "aborted", message: "The request was cancelled." };
    const detail = error?.cause?.code ?? error?.name ?? "network error";
    return { ok: false, code: "network", message: `Could not reach ${new URL(endpoint).host} (${detail}).` };
  }

  const body = await readCapped(response);
  if (!response.ok) {
    const { code, message } = describeHttpFailure(response.status, body);
    return { ok: false, code, message };
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return { ok: false, code: "bad-response", message: "DeepSeek answered with a body that is not JSON." };
  }

  const balance = normalizeBalance(payload);
  if (balance === undefined) {
    return { ok: false, code: "bad-response", message: "DeepSeek's answer did not contain the documented balance fields." };
  }
  return { ok: true, ...balance };
}

/**
 * Read a response body as text, refusing to buffer an unbounded one. A balance
 * answer is a few hundred bytes; anything near this cap is not one.
 * @returns {Promise<string>}
 */
async function readCapped(response) {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return "";
  const text = await response.text();
  return text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text;
}

/**
 * The cache and its single-flight rule.
 *
 * A failed refresh keeps the previous good answer and marks it stale. That is
 * the difference between a widget that says "CNY 42.00, last checked 12 minutes
 * ago, could not refresh" and one that blanks itself because the network
 * hiccuped — the first is information, the second is noise.
 */
function createReader(ctx, settings, provider) {
  let cached; // last successful { isAvailable, wallets } with its timestamp
  let failure; // last failure, cleared by the next success
  let inflight;
  let lastAttempt = 0;
  const controllers = new Set();
  const lifetime = new AbortController();

  async function refresh() {
    if (inflight !== undefined) return inflight;
    lastAttempt = Date.now();
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    lifetime.signal.addEventListener("abort", abort, { once: true });
    inflight = (async () => {
      try {
        const result = await fetchBalance(ctx, settings, provider, controller.signal);
        if (result.ok) {
          cached = { isAvailable: result.isAvailable, wallets: result.wallets, fetchedAt: Date.now() };
          failure = undefined;
        } else if (result.code !== "aborted") {
          failure = { code: result.code, message: result.message };
        }
        return result;
      } finally {
        controllers.delete(controller);
        lifetime.signal.removeEventListener("abort", abort);
        inflight = undefined;
      }
    })();
    return inflight;
  }

  return {
    /**
     * @param {boolean} force bypass the freshness window.
     */
    async read(force) {
      const age = cached === undefined ? Number.POSITIVE_INFINITY : Date.now() - cached.fetchedAt;
      const fresh = age < settings.refreshIntervalMs;
      if (!force && fresh) return undefined;
      if (!force && failure !== undefined && Date.now() - lastAttempt < settings.refreshIntervalMs) return undefined;
      await refresh();
      return undefined;
    },
    /** The wire state the client renders. */
    state() {
      return {
        ok: failure === undefined && cached !== undefined,
        stale: failure !== undefined && cached !== undefined,
        provider: { id: provider.id, label: provider.label },
        currency: settings.currency,
        refreshIntervalMs: settings.refreshIntervalMs,
        fetchedAt: cached?.fetchedAt ?? null,
        isAvailable: cached?.isAvailable ?? null,
        wallets: cached?.wallets ?? [],
        featured: cached === undefined ? null : (pickWallet(cached.wallets, settings.currency) ?? null),
        error: failure ?? null,
        lastAttemptAt: lastAttempt === 0 ? null : lastAttempt,
      };
    },
    dispose() {
      lifetime.abort();
      controllers.clear();
    },
  };
}

/**
 * Same-origin fence for the plugin's own routes.
 *
 * These routes live outside `/api`, so the connection layer's Host/Origin fence
 * does not cover them and the plugin must apply its own. Three checks:
 *
 *  * the Host header must name a loopback authority, which is what stops a
 *    DNS-rebinding page from reading a response through a name that resolves to
 *    127.0.0.1;
 *  * a present Origin must match Host, so a cross-site page cannot read the
 *    answer;
 *  * `sec-fetch-site: cross-site` is refused outright as a second opinion.
 *
 * A GET is all this plugin serves, and it changes nothing but the cache, so
 * there is no CSRF-shaped write to protect.
 *
 * @returns {string | undefined} the violation, or `undefined` when acceptable.
 */
function fenceViolation(req, allowNonLoopback) {
  if (!allowNonLoopback) {
    const host = req.headers.host ?? "";
    const hostname = /^\[.*\](?::\d+)?$/.test(host) ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
    const loopback = hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
    if (!loopback) return "host is not a loopback authority";
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== "null") {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return "unparseable Origin header";
    }
    if (originHost !== (req.headers.host ?? "")) return "Origin does not match Host";
  }
  if (req.headers["sec-fetch-site"] === "cross-site") return "sec-fetch-site: cross-site";
  // The settings write is a POST. Requiring a JSON content type is what stops a
  // cross-site form or a `text/plain` body from reaching it at all, because
  // those are the only shapes a cross-site "simple request" can send.
  if (req.method === "POST" && !/^\s*application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "")) {
    return "POST requires an application/json body";
  }
  return undefined;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * @param {object} rawConfig
 */
function resolveSettings(rawConfig) {
  const config = rawConfig !== null && typeof rawConfig === "object" ? rawConfig : {};
  const providerId = String(config.provider ?? "deepseek").trim().toLowerCase();
  const provider = PROVIDERS[providerId];
  const refresh = Number(config.refreshIntervalMs);
  const timeout = Number(config.requestTimeoutMs);

  return {
    providerId,
    provider,
    apiKey: typeof config.apiKey === "string" ? config.apiKey.trim() : "",
    apiKeyEnv: typeof config.apiKeyEnv === "string" && config.apiKeyEnv !== "" ? config.apiKeyEnv : "DEEPSEEK_API_KEY",
    endpoint: typeof config.endpoint === "string" ? config.endpoint.trim() : "",
    refreshIntervalMs: Number.isFinite(refresh) ? Math.max(MIN_REFRESH_MS, Math.trunc(refresh)) : DEFAULT_REFRESH_MS,
    requestTimeoutMs: Number.isFinite(timeout) ? Math.max(1000, Math.trunc(timeout)) : DEFAULT_TIMEOUT_MS,
    currency: String(config.currency ?? "auto").trim() || "auto",
    allowNonLoopback: config.allowNonLoopback === true,
    costEnabled: config.costEnabled !== false,
    burnWindowMs: Number.isFinite(Number(config.burnWindowMs)) ? Math.max(60_000, Math.trunc(Number(config.burnWindowMs))) : DEFAULT_BURN_WINDOW_MS,
    burnWarnUsdPerHour: Number.isFinite(Number(config.burnWarnUsdPerHour)) ? Math.max(0, Number(config.burnWarnUsdPerHour)) : DEFAULT_BURN_WARN_USD_PER_HOUR,
    usdToCny: Number.isFinite(Number(config.usdToCny)) && Number(config.usdToCny) > 0 ? Number(config.usdToCny) : DEFAULT_USD_TO_CNY,
    costCurrency: String(config.costCurrency ?? "auto").trim() || "auto",
  };
}

/**
 * Turn the ledger's USD figures into the payload the panel renders.
 *
 * The exchange rate is applied here rather than in the browser so there is one
 * implementation, and it is the configured one rather than a fetched one: the
 * plugin has no rate source, and a spend warning built on an invented rate is
 * worse than one that says which rate it used.
 *
 * @param {object} summary from the ledger.
 * @param {object} settings
 * @param {object|null} featured the wallet the panel is featuring, for `auto`.
 */
function costPayload(summary, settings, featured) {
  const currency = settings.costCurrency === "auto" ? (featured?.currency ?? "USD") : settings.costCurrency.toUpperCase();
  const toDisplay = (usd) => convertUsd(usd, currency, settings.usdToCny);

  const lastTurn = summary.lastTurn;
  const burn = summary.recent.usdPerHour;

  return {
    available: true,
    sessionId: summary.sessionId,
    currency,
    usdToCny: settings.usdToCny,
    pricingReadOn: summary.pricingReadOn ?? null,
    warn: settings.burnWarnUsdPerHour > 0 && burn >= settings.burnWarnUsdPerHour,
    warnUsdPerHour: settings.burnWarnUsdPerHour,
    lastTurn:
      lastTurn === null
        ? null
        : {
            turn: lastTurn.turn,
            ended: lastTurn.ended === true,
            usd: lastTurn.usd,
            amount: toDisplay(lastTurn.usd),
            uncachedInputTokens: lastTurn.uncachedInputTokens,
            cacheReadTokens: lastTurn.cacheReadTokens,
            outputTokens: lastTurn.outputTokens,
            messages: lastTurn.messages,
            models: lastTurn.models.map((entry) => entry.model),
          },
    session: {
      usd: summary.session.usd,
      amount: toDisplay(summary.session.usd),
      turns: summary.session.turns,
      sessions: summary.session.sessions,
      descendants: summary.session.descendants,
      unpricedTurns: summary.session.unpricedTurns,
    },
    recent: {
      windowMs: summary.recent.windowMs,
      usd: summary.recent.usd,
      amount: toDisplay(summary.recent.usd),
      usdPerHour: burn,
      amountPerHour: toDisplay(burn),
      messages: summary.recent.messages,
    },
  };
}

/**
 * The live sessions to price.
 *
 * `ctx.sessions` is the host session registry and the direct answer. `agents`
 * is a fallback for a composition without it: an agent and its session share one
 * id, so `agent.session` is the same object. Both are read defensively — a
 * missing or throwing service disables the cost section rather than the route.
 *
 * @param {object} ctx
 * @returns {object[]}
 */
function liveSessionsOf(ctx) {
  const store = ctx.get("sessions");
  if (store !== undefined && typeof store.list === "function") {
    try {
      const list = store.list();
      if (Array.isArray(list)) return list;
    } catch {
      /* fall through to the agent view */
    }
  }
  const agents = ctx.get("agents");
  if (agents !== undefined && typeof agents.list === "function") {
    try {
      const list = agents.list();
      if (Array.isArray(list)) return list.map((agent) => agent?.session).filter((session) => session !== undefined);
    } catch {
      /* both views unavailable */
    }
  }
  return [];
}

const name = "dsh-budget-watcher";

/** Refuse a config write larger than this. The form sends a handful of fields. */
const MAX_CONFIG_BYTES = 8 * 1024;

/**
 * The configuration a user may change from the settings tab, and the type each
 * value is coerced to before it reaches the loader.
 *
 * This is an allow-list rather than "whatever the request contained": the value
 * is written into the user's profile patch file, where an unrecognised key is at
 * best noise and at worst a validation failure that stops the profile loading.
 * `apiKey` is handled separately because it is a secret with leave-unchanged
 * semantics.
 */
const EDITABLE = {
  provider: "string",
  apiKeyEnv: "string",
  endpoint: "string",
  refreshIntervalMs: "number",
  requestTimeoutMs: "number",
  currency: "string",
  allowNonLoopback: "boolean",
  costEnabled: "boolean",
  burnWindowMs: "number",
  burnWarnUsdPerHour: "number",
  usdToCny: "number",
  costCurrency: "string",
};

/**
 * Project the running configuration into the shape the settings tab renders.
 *
 * The `apiKey` value never crosses this boundary — only whether one is set. A
 * secret that reaches the page has already leaked, and this route is not on the
 * authenticated `/api` prefix.
 */
function settingsPayload(settings, extras) {
  return {
    effective: {
      provider: settings.providerId,
      apiKeyEnv: settings.apiKeyEnv,
      endpoint: settings.endpoint,
      refreshIntervalMs: settings.refreshIntervalMs,
      requestTimeoutMs: settings.requestTimeoutMs,
      currency: settings.currency,
      allowNonLoopback: settings.allowNonLoopback,
      costEnabled: settings.costEnabled,
      burnWindowMs: settings.burnWindowMs,
      burnWarnUsdPerHour: settings.burnWarnUsdPerHour,
      usdToCny: settings.usdToCny,
      costCurrency: settings.costCurrency,
    },
    apiKeySet: settings.apiKey !== "",
    ...extras,
  };
}

/**
 * Type-check a request body's patch before anything else happens.
 *
 * This runs *before* `configEditor.edit`, not inside its change callback, so a
 * mistyped field is refused without the profile patch ever being opened. The
 * loader would reject it anyway — but only after the write path had begun, and
 * the difference between "rejected" and "rejected after touching the user's
 * config file" is worth the small duplication.
 *
 * @returns {string | undefined} the problem, or `undefined` when acceptable.
 */
function validatePatch(patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return "body.patch must be an object";
  for (const [key, kind] of Object.entries(EDITABLE)) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key];
    if (kind === "boolean" && typeof value !== "boolean") return `${key} must be a boolean`;
    if (kind === "number" && (typeof value !== "number" || !Number.isFinite(value))) return `${key} must be a finite number`;
    if (kind === "string" && typeof value !== "string") return `${key} must be a string`;
  }
  if (Object.hasOwn(patch, "apiKey") && patch.apiKey !== null && typeof patch.apiKey !== "string") {
    return "apiKey must be a string or null";
  }
  return undefined;
}

/**
 * Merge a validated patch onto the configuration currently in the patch.
 *
 * `apiKey` is deliberately tri-state: absent leaves it alone, `""` removes it,
 * anything else sets it. A form that posted an empty string for an untouched
 * field would otherwise silently delete the user's key.
 */
function mergeConfig(current, patch, inherited) {
  const next = { ...current };

  for (const key of Object.keys(EDITABLE)) {
    if (!Object.hasOwn(patch, key)) continue;
    const kind = EDITABLE[key];
    if (kind === "string") {
      if (patch[key].trim() === "") delete next[key];
      else next[key] = patch[key].trim();
    } else {
      next[key] = patch[key];
    }
  }

  if (Object.hasOwn(patch, "apiKey")) {
    if (patch.apiKey === null || patch.apiKey === "") delete next.apiKey;
    else next.apiKey = patch.apiKey;
  }

  // A value identical to the layer beneath is not worth persisting: the editor
  // drops the whole `config` key when the result equals `inherited`, which is
  // what makes "reset to default" work.
  return JSON.stringify(next) === JSON.stringify(inherited ?? {}) ? {} : next;
}

/** Read a bounded JSON request body. */
function readJsonBody(req, limit = MAX_CONFIG_BYTES) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish({ error: "body too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => finish({ error: "body read failed" }));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") return finish({ value: {} });
      try {
        finish({ value: JSON.parse(text) });
      } catch {
        finish({ error: "body is not valid JSON" });
      }
    });
  });
}

/**
 * Locate this plugin's own row in the profile patch.
 *
 * `configEditor.entries()` returns only rows it can address unambiguously, so a
 * duplicate id means the row is not editable from here — reported rather than
 * written to the wrong one.
 */
function findConfigEntry(ctx) {
  const editor = ctx.get("configEditor");
  if (editor === undefined || typeof editor.edit !== "function") return { reason: "no-config-editor" };
  let entries;
  try {
    entries = editor.entries();
  } catch {
    return { reason: "entries-unavailable" };
  }
  const entry = entries.find((candidate) => candidate?.options?.name === name);
  if (entry === undefined) return { reason: "row-not-addressable" };
  return { editor, entry };
}

function apply(ctx, config) {
  const settings = resolveSettings(config);

  if (settings.provider === undefined) {
    // An unusable config must not throw: a throw here fails the plugin's fiber
    // and the profile reports a load error for what is really a typo. The
    // widget renders this instead.
    ctx.logger?.warn?.(`[${name}] unknown provider "${settings.providerId}"; no balance will be read`);
  }

  const reader = createReader(ctx, settings, settings.provider ?? { id: settings.providerId, label: settings.providerId });

  // Reads the live agent tree to price what recent turns actually cost. It
  // spends no tokens of its own: every figure comes from the usage the provider
  // already reported and DSH already logged.
  const ledger = settings.costEnabled
    ? createCostLedger({ getSessions: () => liveSessionsOf(ctx), windowMs: settings.burnWindowMs })
    : undefined;

  /**
   * What the settings tab renders.
   *
   * Only the running values plus whether the row can be written. Reading the
   * patch document's own values back (`configEditor.configuration()`) would mean
   * touching the profile directory on every poll for a cosmetic
   * "explicitly set vs default" hint, so it is deliberately not done.
   */
  const currentSettings = () => {
    const located = findConfigEntry(ctx);
    if (located.reason !== undefined) return settingsPayload(settings, { editable: false, reason: located.reason });
    return settingsPayload(settings, { editable: true });
  };

  // `ctx.inject` rather than the exported `inject`: a profile without a web
  // server should still load this plugin and simply have nothing to serve,
  // instead of parking the fiber forever.
  ctx.inject(["webServer"], (injected) => {
    const webServer = injected.webServer ?? ctx.get("webServer");
    if (webServer === undefined) return () => {};

    const dispose = webServer.register({
      kind: "exact",
      path: STATE_PATH,
      handler: async (req, res) => {
        if (req.method !== "GET") {
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        const violation = fenceViolation(req, settings.allowNonLoopback);
        if (violation !== undefined) {
          sendJson(res, 403, { error: `forbidden: ${violation}` });
          return;
        }
        const params = new URL(req.url ?? STATE_PATH, "http://localhost").searchParams;
        const force = params.get("refresh") === "1";
        try {
          await reader.read(force);
        } catch (error) {
          ctx.logger?.warn?.(`[${name}] balance refresh failed: ${String(error)}`);
        }

        const state = { ...reader.state(), pluginVersion: PLUGIN_VERSION };
        let cost;
        if (ledger === undefined) {
          cost = { available: false, reason: "disabled" };
        } else {
          try {
            // The client names the conversation it is showing when it can. The
            // ledger falls back to the newest live root session otherwise, so
            // an older client still gets an answer.
            const requested = params.get("session");
            const summary = ledger.summary({
              sessionId: requested !== null && requested !== "" ? requested : undefined,
            });
            // A silent absence is indistinguishable from a bug, so the payload
            // says why there are no figures instead of omitting the key.
            cost = summary === undefined ? { available: false, reason: "no-live-sessions" } : costPayload(summary, settings, state.featured);
          } catch (error) {
            // Cost is an addition to the balance, never a reason to fail it.
            ctx.logger?.warn?.(`[${name}] cost estimate failed: ${String(error)}`);
            cost = { available: false, reason: "failed" };
          }
        }

        sendJson(res, 200, { ...state, cost, settings: currentSettings() });
      },
    });

    // The settings tab's write path. Same fence as the read, plus a required
    // JSON content type, so a cross-site form cannot reach it.
    const disposeConfig = webServer.register({
      kind: "exact",
      path: CONFIG_PATH,
      handler: async (req, res) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        const violation = fenceViolation(req, settings.allowNonLoopback);
        if (violation !== undefined) {
          sendJson(res, 403, { error: `forbidden: ${violation}` });
          return;
        }

        const located = findConfigEntry(ctx);
        if (located.reason !== undefined) {
          sendJson(res, 409, { ok: false, error: `the profile row is not editable (${located.reason})`, settings: currentSettings() });
          return;
        }

        const body = await readJsonBody(req);
        if (body.error !== undefined) {
          sendJson(res, 400, { ok: false, error: body.error, settings: currentSettings() });
          return;
        }

        // Refused before the profile patch is opened.
        const invalid = validatePatch(body.value?.patch);
        if (invalid !== undefined) {
          sendJson(res, 400, { ok: false, error: invalid, settings: currentSettings() });
          return;
        }

        try {
          await located.editor.edit(located.entry, (current, inherited) => mergeConfig(current ?? {}, body.value.patch, inherited));
        } catch (error) {
          // A rejected write leaves the profile untouched: configEditor rolls
          // the file back when reconciliation fails.
          ctx.logger?.warn?.(`[${name}] config write failed: ${String(error)}`);
          sendJson(res, 400, { ok: false, error: String(error?.message ?? error), settings: currentSettings() });
          return;
        }

        sendJson(res, 200, { ok: true, settings: currentSettings(), note: "Saved to the profile patch. Config edits apply live." });
      },
    });

    return () => {
      dispose();
      disposeConfig();
    };
  });

  ctx.effect(() => () => {
    reader.dispose();
    ledger?.dispose();
  });
}

export { apply, name };
