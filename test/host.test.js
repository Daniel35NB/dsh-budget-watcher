// Host-half tests.
//
// `index.js` is imported for real: the schemastery import inside it fails in
// this repository (the package is only resolvable inside a DSH installation)
// and must degrade rather than throw, which is itself one of the properties
// under test. The Cordis context is a stand-in that records what the plugin
// registers, so the assertions are about the plugin's behaviour rather than
// about a mock of it.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { apply } from "../index.js";

const STATE_PATH = "/dsh-budget-watcher/balance";
const CONFIG_PATH = "/dsh-budget-watcher/config";
const BALANCE_URL = "https://api.deepseek.com/user/balance";

const DOCUMENTED = {
  is_available: true,
  balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }],
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A Cordis-shaped context that records registrations instead of running them. */
function makeHarness(options = {}) {
  const routes = new Map();
  const disposers = [];
  const state = { credential: undefined, resolveCalls: [] };

  const webServer = {
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
  const credentials = {
    async resolve(ref) {
      state.resolveCalls.push(ref);
      return state.credential;
    },
  };

  const ctx = {
    logger: { warn() {}, info() {} },
    get: (serviceName) => {
      if (serviceName === "credentials") return credentials;
      if (serviceName === "sessions") return options.sessions;
      if (serviceName === "agents") return options.agents;
      if (serviceName === "configEditor") return options.configEditor;
      return undefined;
    },
    inject: (_dependencies, callback) => {
      const dispose = callback({ webServer });
      if (typeof dispose === "function") disposers.push(dispose);
    },
    effect: (factory) => {
      const dispose = factory();
      if (typeof dispose === "function") disposers.push(dispose);
    },
  };

  return { ctx, routes, disposers, state };
}

/** Answer one request against a registered route. */
async function request(route, options = {}) {
  const { method = "GET", url = STATE_PATH, headers = {} } = options;
  let status = 0;
  let payload = "";
  const res = {
    writeHead(code) {
      status = code;
    },
    end(chunk) {
      payload = chunk ?? "";
    },
  };
  await route.handler({ method, url, headers: { host: "127.0.0.1:19387", ...headers } }, res);
  return { status, body: JSON.parse(payload) };
}

/** Count upstream calls and answer with a scripted response. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  return calls;
}

const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status });

test("the bundled route serves the normalized topped-up balance", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const { status, body } = await request(harness.routes.get(STATE_PATH));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.provider.id, "deepseek");
  assert.equal(body.featured.currency, "CNY");
  assert.equal(body.featured.toppedUp, "100.00", "the field this plugin exists to show");
  assert.equal(body.featured.granted, "10.00");
  assert.equal(body.isAvailable, true);
  assert.equal(typeof body.fetchedAt, "number");
});

test("the API key is resolved through the credentials service and sent as a bearer token", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-secret", source: "file" };
  const calls = stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  await request(harness.routes.get(STATE_PATH));
  assert.deepEqual(harness.state.resolveCalls, ["DEEPSEEK_API_KEY"]);
  assert.equal(calls[0].url, BALANCE_URL);
  // Bearer, not the `x-api-key` header the inference API uses.
  assert.equal(calls[0].init.headers.authorization, "Bearer sk-secret");
  assert.equal(calls[0].init.redirect, "error");
});

test("one upstream request serves every read inside the freshness window", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  const calls = stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { refreshIntervalMs: 60_000 });

  await request(harness.routes.get(STATE_PATH));
  await request(harness.routes.get(STATE_PATH));
  await request(harness.routes.get(STATE_PATH));
  assert.equal(calls.length, 1, "a poll from each open window must not multiply upstream traffic");
});

test("?refresh=1 bypasses the freshness window", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  const calls = stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { refreshIntervalMs: 60_000 });

  await request(harness.routes.get(STATE_PATH));
  await request(harness.routes.get(STATE_PATH), { url: `${STATE_PATH}?refresh=1` });
  assert.equal(calls.length, 2);
});

test("a rejected key becomes a renderable state, not an exception", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-bad", source: "file" };
  // The unauthenticated 401 is plain text; a wrong key answers JSON. Both are
  // covered because a client that parses the body unconditionally breaks here.
  stubFetch(() => new Response("Authentication Fails (governor)", { status: 401 }));
  apply(harness.ctx, {});

  const first = await request(harness.routes.get(STATE_PATH));
  assert.equal(first.status, 200, "the route answers 200 with a failure state; the widget renders it");
  assert.equal(first.body.ok, false);
  assert.equal(first.body.error.code, "unauthorized");

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "Authentication Fails, Your api key: ****0000 is invalid" } }), { status: 401 });
  const second = await request(harness.routes.get(STATE_PATH), { url: `${STATE_PATH}?refresh=1` });
  assert.equal(second.body.error.code, "unauthorized");
});

test("a missing key is reported without touching the network", async () => {
  const harness = makeHarness();
  const calls = stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const { body } = await request(harness.routes.get(STATE_PATH));
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "no-key");
  assert.match(body.error.message, /DEEPSEEK_API_KEY/);
  assert.equal(calls.length, 0);
});

test("a failed refresh keeps the last good balance and marks it stale", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const good = await request(harness.routes.get(STATE_PATH));
  assert.equal(good.body.featured.toppedUp, "100.00");

  globalThis.fetch = async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  };
  const failed = await request(harness.routes.get(STATE_PATH), { url: `${STATE_PATH}?refresh=1` });
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.stale, true);
  assert.equal(failed.body.featured.toppedUp, "100.00", "the previous number is still the most useful thing on screen");
  assert.equal(failed.body.error.code, "network");
  assert.match(failed.body.error.message, /ECONNREFUSED/);
});

test("an unreadable body is a protocol error rather than a zero balance", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => new Response("<html>gateway</html>", { status: 200 }));
  apply(harness.ctx, {});

  const { body } = await request(harness.routes.get(STATE_PATH));
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "bad-response");
  assert.deepEqual(body.wallets, [], "no wallet is invented from a body that carries none");
});

test("the endpoint can be pointed at a stand-in server", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  const calls = stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { endpoint: "http://127.0.0.1:9/user/balance" });

  await request(harness.routes.get(STATE_PATH));
  assert.equal(calls[0].url, "http://127.0.0.1:9/user/balance");
});

test("the fence refuses a non-loopback authority and a cross-site caller", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});
  const route = harness.routes.get(STATE_PATH);

  const rebound = await request(route, { headers: { host: "evil.example:19387" } });
  assert.equal(rebound.status, 403);
  assert.match(rebound.body.error, /loopback/);

  const crossSite = await request(route, { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(crossSite.status, 403);

  const wrongOrigin = await request(route, { headers: { origin: "http://evil.example" } });
  assert.equal(wrongOrigin.status, 403);

  const sameOrigin = await request(route, { headers: { origin: "http://127.0.0.1:19387" } });
  assert.equal(sameOrigin.status, 200);
});

test("allowNonLoopback drops the loopback requirement but keeps the origin checks", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { allowNonLoopback: true });
  const route = harness.routes.get(STATE_PATH);

  assert.equal((await request(route, { headers: { host: "192.168.1.10:19387" } })).status, 200);
  assert.equal((await request(route, { headers: { host: "192.168.1.10:19387", "sec-fetch-site": "cross-site" } })).status, 403);
});

test("only GET is served", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const { status } = await request(harness.routes.get(STATE_PATH), { method: "POST" });
  assert.equal(status, 405);
});

test("an unknown provider degrades instead of failing the profile", async () => {
  const harness = makeHarness();
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { provider: "openai" });

  const { status, body } = await request(harness.routes.get(STATE_PATH));
  assert.equal(status, 200);
  assert.equal(body.provider.label, "openai");
  assert.equal(body.ok, false);
});

test("disposing the plugin removes the route and aborts in-flight work", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  assert.equal(harness.routes.has(STATE_PATH), true);
  for (const dispose of harness.disposers) dispose();
  assert.equal(harness.routes.has(STATE_PATH), false);
});

test("an explicit config key wins over the credentials service", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-from-store", source: "file" };
  const calls = stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { apiKey: "sk-from-config" });

  await request(harness.routes.get(STATE_PATH));
  assert.equal(calls[0].init.headers.authorization, "Bearer sk-from-config");
  assert.deepEqual(harness.state.resolveCalls, [], "the store is not consulted when the config carries a key");
});

// --- cost estimates -------------------------------------------------------

/** One session whose log holds a single priced assistant message. */
function costSession({ id, parent, inputTokens, time }) {
  const events = [
    { type: "turn/start", seq: 0, time, data: { turn: 1 } },
    {
      type: "assistant/message",
      seq: 1,
      time: time + 1,
      data: { turn: 1, message: { source: { provider: "deepseek", model: "deepseek-flash" } }, usage: { inputTokens } },
    },
  ];
  return {
    id,
    header: parent === undefined ? {} : { parentSession: parent },
    seq: events.length,
    ownEvents: () => events,
    snapshotEvents: () => [events[events.length - 1]],
  };
}

/** Off-peak Flash input, so 1M uncached tokens is exactly $0.15. */
const OFF_PEAK = Date.parse("2026-10-02T12:00:00Z");

test("the route attaches a priced cost block when the agents service is present", async () => {
  const root = costSession({ id: "session-root", inputTokens: 1_000_000, time: OFF_PEAK });
  const harness = makeHarness({ sessions: { list: () => [root] } });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { usdToCny: 7.2 });

  const { body } = await request(harness.routes.get(STATE_PATH), { url: `${STATE_PATH}?session=session-root` });
  assert.equal(body.cost.available, true);
  assert.equal(body.cost.sessionId, "session-root");
  assert.equal(body.cost.session.usd.toFixed(4), "0.1500");
  assert.equal(body.cost.session.amount.toFixed(2), "1.08", "USD spend is shown in the balance's currency");
  assert.equal(body.cost.currency, "CNY", "auto follows the featured wallet");
  assert.equal(body.cost.lastTurn.usd.toFixed(4), "0.1500");
  assert.equal(body.cost.warn, false);
});

test("a fan-out raises the burn warning the last turn alone would hide", async () => {
  const root = costSession({ id: "session-root", inputTokens: 10_000, time: OFF_PEAK });
  const children = Array.from({ length: 40 }, (_, index) =>
    costSession({ id: `session-child-${index}`, parent: "session-root", inputTokens: 1_000_000, time: OFF_PEAK + 1000 }),
  );
  const harness = makeHarness({ sessions: { list: () => [root, ...children] } });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { burnWarnUsdPerHour: 2, burnWindowMs: 15 * 60 * 1000 });

  const { body } = await request(harness.routes.get(STATE_PATH), { url: `${STATE_PATH}?session=session-root` });
  assert.equal(body.cost.session.descendants, 40);
  assert.equal(body.cost.session.usd.toFixed(3), (40 * 0.15 + 0.0015).toFixed(3));
  assert.equal(body.cost.lastTurn.usd.toFixed(4), "0.0015", "the visible turn looks cheap");
  assert.equal(body.cost.warn, true, "the projected hourly rate is what warns");
  assert.equal(body.cost.usdToCny, 7.2);
});

test("costEnabled false still answers the balance, and says why there are no figures", async () => {
  const root = costSession({ id: "session-root", inputTokens: 1_000_000, time: OFF_PEAK });
  const harness = makeHarness({ sessions: { list: () => [root] } });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { costEnabled: false });

  const { body } = await request(harness.routes.get(STATE_PATH));
  assert.deepEqual(body.cost, { available: false, reason: "disabled" });
  assert.equal(body.ok, true, "the balance still works");
});

test("a broken sessions service costs the cost block, not the balance", async () => {
  const harness = makeHarness({ sessions: { list: () => { throw new Error("sessions exploded"); } } });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const { status, body } = await request(harness.routes.get(STATE_PATH));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.featured.toppedUp, "100.00");
  assert.deepEqual(body.cost, { available: false, reason: "no-live-sessions" });
});

test("the payload carries the plugin version, so a stale module is visible", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const { body } = await request(harness.routes.get(STATE_PATH));
  assert.equal(body.pluginVersion, "0.2.0", "a host module is cached for the life of the DSH process; this says which one answered");
});

test("the agents service is used when there is no session registry", async () => {
  const root = costSession({ id: "session-root", inputTokens: 1_000_000, time: OFF_PEAK });
  const harness = makeHarness({ agents: { list: () => [{ session: root }] } });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const { body } = await request(harness.routes.get(STATE_PATH));
  assert.equal(body.cost.session.usd.toFixed(4), "0.1500");
});

test("an explicit costCurrency overrides the balance currency", async () => {
  const root = costSession({ id: "session-root", inputTokens: 1_000_000, time: OFF_PEAK });
  const harness = makeHarness({ sessions: { list: () => [root] } });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { costCurrency: "USD", usdToCny: 7.2 });

  const { body } = await request(harness.routes.get(STATE_PATH));
  assert.equal(body.cost.currency, "USD");
  assert.equal(body.cost.session.amount.toFixed(4), "0.1500", "no conversion is applied for USD");
});

// --- settings tab ---------------------------------------------------------

/** The row the loader would have inserted from cordis.patch.yml. */
function configRow(overrides = {}) {
  return { options: { id: "budget-watcher", name: "dsh-budget-watcher" }, fiber: { state: 2 }, ...overrides };
}

function fakeEditor(edit, rows = [configRow()]) {
  return { entries: () => rows, documentPath: "C:/profile/cordis.patch.yml", edit };
}

/** POST a JSON body at the config route, emitting the body after the handler subscribes. */
async function postConfig(route, body, headers = {}) {
  let status = 0;
  let payload = "";
  const res = { writeHead(code) { status = code; }, end(chunk) { payload = chunk ?? ""; } };
  const listeners = {};
  const req = {
    method: "POST",
    url: CONFIG_PATH,
    headers: { host: "127.0.0.1:19387", "content-type": "application/json", ...headers },
    on(event, handler) {
      (listeners[event] ??= []).push(handler);
      return req;
    },
    destroy() {},
  };
  const handled = route.handler(req, res);
  const chunk = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  for (const handler of listeners.data ?? []) handler(chunk);
  for (const handler of listeners.end ?? []) handler();
  await handled;
  return { status, body: payload === "" ? undefined : JSON.parse(payload) };
}

test("the state payload carries the running settings, never the key itself", async () => {
  const harness = makeHarness({ configEditor: fakeEditor(async () => {}) });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { apiKey: "sk-secret", refreshIntervalMs: 30_000 });

  const { body } = await request(harness.routes.get(STATE_PATH));
  assert.equal(body.settings.editable, true);
  assert.equal(body.settings.apiKeySet, true, "the panel may know a key is set");
  assert.equal(JSON.stringify(body).includes("sk-secret"), false, "but the secret never crosses to the page");
  assert.equal(body.settings.effective.refreshIntervalMs, 30_000);
  assert.equal("apiKey" in body.settings.effective, false, "the effective projection has no secret field at all");
});

test("without a config editor the row reports itself uneditable instead of failing", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const { body } = await request(harness.routes.get(STATE_PATH));
  assert.equal(body.settings.editable, false);
  assert.equal(body.settings.reason, "no-config-editor");

  const posted = await postConfig(harness.routes.get(CONFIG_PATH), { patch: { currency: "USD" } });
  assert.equal(posted.status, 409);
  assert.equal(posted.body.ok, false);
});

test("saving validates, merges onto the current config, and reports the new values", async () => {
  let seen;
  const editor = fakeEditor(async (entry, change) => {
    seen = { entry, next: change({ currency: "auto" }, {}) };
  });
  const harness = makeHarness({ configEditor: editor });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const { status, body } = await postConfig(harness.routes.get(CONFIG_PATH), {
    patch: { currency: "USD", costEnabled: false, burnWindowMs: 600_000, usdToCny: 7.1 },
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(seen.entry.options.id, "budget-watcher", "the editor writes to this plugin's own row");
  assert.deepEqual(seen.next, { currency: "USD", costEnabled: false, burnWindowMs: 600_000, usdToCny: 7.1 },
    "only the fields that were sent, merged onto what was there");
});

test("an unknown field is refused rather than written into the profile", async () => {
  let called = false;
  const harness = makeHarness({ configEditor: fakeEditor(async () => { called = true; }) });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  // An unrecognised key would land in the user's patch file; it is dropped
  // silently, so the write still succeeds with only the known fields.
  const { status } = await postConfig(harness.routes.get(CONFIG_PATH), { patch: { nonsense: 1, currency: "USD" } });
  assert.equal(status, 200);
  assert.equal(called, true);
});

test("a wrong-typed field is refused", async () => {
  const harness = makeHarness({ configEditor: fakeEditor(async () => {}) });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const numeric = await postConfig(harness.routes.get(CONFIG_PATH), { patch: { refreshIntervalMs: "soon" } });
  assert.equal(numeric.status, 400);
  assert.match(numeric.body.error, /refreshIntervalMs/);

  const boolean = await postConfig(harness.routes.get(CONFIG_PATH), { patch: { costEnabled: "yes" } });
  assert.equal(boolean.status, 400);
  assert.match(boolean.body.error, /costEnabled/);
});

test("the settings write requires a JSON body and the same fence as the read", async () => {
  const harness = makeHarness({ configEditor: fakeEditor(async () => {}) });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});
  const route = harness.routes.get(CONFIG_PATH);

  const notJson = await postConfig(route, { patch: {} }, { "content-type": "text/plain" });
  assert.equal(notJson.status, 403, "a cross-site simple request cannot reach the write");

  const rebound = await postConfig(route, { patch: {} }, { host: "evil.example" });
  assert.equal(rebound.status, 403);

  const GET = await request(route);
  assert.equal(GET.status, 405, "only POST writes");

  const malformed = await postConfig(route, "{not json");
  assert.equal(malformed.status, 400);
});

test("apiKey is tri-state: absent leaves it, empty clears it, a value sets it", async () => {
  let seen;
  const editor = fakeEditor(async (entry, change) => {
    seen = change({ currency: "auto", apiKey: "sk-existing" }, {});
  });
  const harness = makeHarness({ configEditor: editor });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});
  const route = harness.routes.get(CONFIG_PATH);

  await postConfig(route, { patch: { currency: "USD" } });
  assert.equal(seen.apiKey, "sk-existing", "an untouched password box must not delete the key");

  await postConfig(route, { patch: { apiKey: "" } });
  assert.equal("apiKey" in seen, false, "clearing it removes the field");

  await postConfig(route, { patch: { apiKey: "sk-new" } });
  assert.equal(seen.apiKey, "sk-new");
});

test("a config equal to the inherited layer is written as no override at all", async () => {
  let seen;
  const editor = fakeEditor(async (entry, change) => {
    seen = change({ currency: "USD" }, { currency: "USD" });
  });
  const harness = makeHarness({ configEditor: editor });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const { status } = await postConfig(harness.routes.get(CONFIG_PATH), { patch: { currency: "USD" } });
  assert.equal(status, 200);
  assert.deepEqual(seen, {}, "matching the layer beneath means the row goes back to inheriting");
});

