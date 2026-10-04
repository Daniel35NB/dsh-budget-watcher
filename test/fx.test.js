// The real ECB file's shape, trimmed to the two currencies that matter here.
const ECB_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
    <Cube time='2026-10-02'>
      <Cube currency='USD' rate='1.1225'/>
      <Cube currency='JPY' rate='163.31'/>
      <Cube currency='CNY' rate='7.5259'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

import assert from "node:assert/strict";
import test from "node:test";

import { ECB_DAILY_URL, createFxCache, parseEcbDaily } from "../lib/fx.js";

function response(body, ok = true) {
  return { ok, text: async () => body };
}

// --- parsing --------------------------------------------------------------

test("the ECB's daily file gives a USD->CNY cross rate", () => {
  const parsed = parseEcbDaily(ECB_BODY);
  assert.equal(parsed?.date, "2026-10-02");
  assert.equal(parsed?.usdPerEur, 1.1225);
  assert.equal(parsed?.cnyPerEur, 7.5259);
  // The ECB quotes against the euro, so the pair has to be crossed.
  assert.equal(parsed?.usdToCny.toFixed(4), (7.5259 / 1.1225).toFixed(4));
  assert.equal(parsed?.usdToCny.toFixed(4), "6.7046");
});

test("a malformed or partial file yields no rate rather than a wrong one", () => {
  assert.equal(parseEcbDaily(""), undefined);
  assert.equal(parseEcbDaily("not xml at all"), undefined);
  assert.equal(parseEcbDaily("<Cube time='2026-10-02'><Cube currency='USD' rate='1.12'/></Cube>"), undefined, "CNY missing");
  assert.equal(parseEcbDaily("<Cube><Cube currency='USD' rate='0'/></Cube>"), undefined, "a zero divisor is not a rate");
  assert.equal(parseEcbDaily("<Cube><Cube currency='USD' rate='1.1'/><Cube currency='CNY' rate='999'/></Cube>"), undefined, "absurd cross rate rejected");
  assert.equal(parseEcbDaily(null), undefined);
});

// --- resolution order -----------------------------------------------------

test("a fresh rate is fetched once and then reused inside its TTL", async () => {
  let calls = 0;
  let clock = 1_000_000;
  const fx = createFxCache({
    fetchImpl: async (url) => {
      calls += 1;
      assert.equal(url, ECB_DAILY_URL);
      return response(ECB_BODY);
    },
    now: () => clock,
  });

  const first = await fx.resolve();
  assert.equal(first?.source, "ecb");
  assert.equal(first?.stale, false);
  assert.equal(first?.usdToCny.toFixed(4), "6.7046");

  clock += 60_000;
  const second = await fx.resolve();
  assert.equal(second?.usdToCny, first?.usdToCny);
  assert.equal(calls, 1, "a second call inside the TTL must not hit the network");

  clock += 12 * 60 * 60 * 1000;
  await fx.resolve();
  assert.equal(calls, 2, "past the TTL it refreshes");
});

test("a failed fetch falls back to the last rate that worked, and says it is stale", async () => {
  let clock = 1_000_000;
  let broken = false;
  const fx = createFxCache({
    fetchImpl: async () => {
      if (broken) throw new Error("offline");
      return response(ECB_BODY);
    },
    now: () => clock,
  });

  await fx.resolve();
  broken = true;
  clock += 24 * 60 * 60 * 1000;

  const stale = await fx.resolve();
  assert.equal(stale?.usdToCny.toFixed(4), "6.7046", "yesterday's rate beats no rate");
  assert.equal(stale?.stale, true, "and it is labelled stale so the caller can say so");
  assert.equal(stale?.source, "ecb");
});

test("with no network and no history it uses the configured rate", async () => {
  const fx = createFxCache({ fetchImpl: async () => { throw new Error("offline"); }, fallback: 7.2 });
  const rate = await fx.resolve();
  assert.equal(rate?.usdToCny, 7.2);
  assert.equal(rate?.source, "configured");
  assert.equal(rate?.stale, true);
});

test("with nothing at all it reports no rate instead of inventing one", async () => {
  const fx = createFxCache({ fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(await fx.resolve(), undefined);
  assert.equal(fx.snapshot(), undefined);
});

test("networking can be switched off entirely for a fixed rate", async () => {
  let called = false;
  const fx = createFxCache({
    enabled: false,
    fallback: 7.2,
    fetchImpl: async () => {
      called = true;
      return response(ECB_BODY);
    },
  });
  const rate = await fx.resolve();
  assert.equal(rate?.usdToCny, 7.2);
  assert.equal(rate?.source, "configured");
  assert.equal(called, false, "an explicit rate must not be overridden by a fetch");
});

test("a body that is not the file we expect is treated as a failed fetch", async () => {
  const fx = createFxCache({ fetchImpl: async () => response("<html>maintenance</html>") });
  assert.equal(await fx.resolve(), undefined);
});

test("an HTTP error is a failed fetch, not a thrown one", async () => {
  const fx = createFxCache({ fetchImpl: async () => response("nope", false) });
  assert.equal(await fx.resolve(), undefined);
});

test("concurrent callers share one fetch", async () => {
  let calls = 0;
  const fx = createFxCache({
    fetchImpl: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return response(ECB_BODY);
    },
  });
  const [a, b, c] = await Promise.all([fx.resolve(), fx.resolve(), fx.resolve()]);
  assert.equal(calls, 1, "single flight, so one panel poll cannot stampede the ECB");
  assert.equal(a?.usdToCny, b?.usdToCny);
  assert.equal(b?.usdToCny, c?.usdToCny);
});

test("snapshot answers without touching the network", async () => {
  let calls = 0;
  const fx = createFxCache({
    fetchImpl: async () => {
      calls += 1;
      return response(ECB_BODY);
    },
  });
  assert.equal(fx.snapshot(), undefined, "nothing known before the first fetch");
  await fx.resolve();
  assert.equal(fx.snapshot()?.source, "ecb");
  assert.equal(fx.snapshot()?.stale, false);
  assert.equal(calls, 1);
});
