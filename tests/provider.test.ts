import assert from "node:assert/strict";
import test from "node:test";
import { AlphaVantageProvider, barForSession } from "../lib/provider.ts";

test("provider adapter extracts and canonicalizes only the required OHLCV fields", async () => {
  const fakeFetch: typeof fetch = async () =>
    Response.json({
      "Meta Data": { "2. Symbol": "SPY" },
      "Time Series (Daily)": {
        "2026-07-28": { "4. close": "99.9", "5. volume": "42" },
        "2026-07-29": { "4. close": "100.1200000", "5. volume": "00045" },
      },
    });
  const provider = new AlphaVantageProvider("test-key", fakeFetch);
  const bars = await provider.dailySeries("SPY");
  assert.deepEqual(bars, [
    { sessionDate: "2026-07-29", close: "100.120000", volume: "45" },
    { sessionDate: "2026-07-28", close: "99.900000", volume: "42" },
  ]);
  assert.deepEqual(barForSession(bars, "2026-07-29"), bars[0]);
  assert.equal(barForSession(bars, "2026-07-27"), null);
});

test("provider throttling and malformed payloads fail closed", async () => {
  const throttled: typeof fetch = async () =>
    Response.json({ Note: "API call frequency exceeded." });
  const provider = new AlphaVantageProvider("test-key", throttled);
  await assert.rejects(() => provider.dailySeries("SPY"), /frequency exceeded/);

  const invalidPrice: typeof fetch = async () =>
    Response.json({
      "Time Series (Daily)": {
        "2026-07-29": { "4. close": "NaN", "5. volume": "10" },
      },
    });
  await assert.rejects(
    () => new AlphaVantageProvider("test-key", invalidPrice).dailySeries("SPY"),
    /Invalid non-negative decimal price/,
  );
});

test("provider HTTP failures preserve the failure instead of producing gaps", async () => {
  const unavailable: typeof fetch = async () =>
    new Response("unavailable", { status: 503 });
  await assert.rejects(
    () => new AlphaVantageProvider("test-key", unavailable).dailySeries("SPY"),
    /HTTP 503/,
  );
});

test("HTTP rate limits are not hammered and preserve Retry-After guidance", async () => {
  let calls = 0;
  const rateLimited: typeof fetch = async () => {
    calls += 1;
    return new Response("limited", {
      status: 429,
      headers: { "retry-after": "60" },
    });
  };
  await assert.rejects(
    () => new AlphaVantageProvider("test-key", rateLimited).dailySeries("SPY"),
    /HTTP 429; retry after 60/,
  );
  assert.equal(calls, 1);
});
