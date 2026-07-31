import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { runnerImport } from "vite";

async function requestWorker(path = "/", init = {}, runtime = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`https://closewatch.example${path}`, {
      ...init,
      headers: {
        accept: "text/html",
        host: "closewatch.example",
        "x-forwarded-host": "closewatch.example",
        "x-forwarded-proto": "https",
        ...(init.headers ?? {}),
      },
    }),
    {
      ...runtime,
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

const render = (runtime = {}) => requestWorker("/", {}, runtime);

test("server fails visibly without runtime data instead of substituting fixtures", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();

  assert.match(html, /<title>Closewatch — Fund Close Monitor<\/title>/i);
  assert.match(html, /Every close, accounted for\./);
  assert.match(html, /Data service unavailable/);
  assert.match(html, /fixtures were not substituted/);
  assert.doesNotMatch(html, /Pipeline healthy/);
  assert.doesNotMatch(html, /\$636\.18/);
  assert.doesNotMatch(html, />SPY</);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /react-loading-skeleton/);
  assert.match(html, /https:\/\/closewatch\.example\/og\.png/);
});

test("rendered view states its financial scope and exclusions", async () => {
  const html = await (await render()).text();
  assert.match(html, /US-listed · USD · Price return/);
  assert.match(html, /As of previous close/);
  assert.match(html, /Price return, not total return/);
  assert.match(html, /No trading or advice/);
});

test("mobile fund cards label their percentages as price returns", async () => {
  const runnerConfig = {
    configFile: false,
    plugins: [react()],
    root: new URL("../", import.meta.url).pathname,
  };
  const [{ module: dashboardModule }, { module: snapshotModule }] = await Promise.all([
    runnerImport("/app/TrackerDashboard.tsx", runnerConfig),
    runnerImport("/lib/dashboard.ts", runnerConfig),
  ]);
  const html = renderToStaticMarkup(createElement(dashboardModule.default, {
    snapshot: snapshotModule.illustrativeSnapshot(),
  }));
  assert.match(html, /PREVIEW/);
  assert.match(html, /Price returns/);
  assert.match(html, /SAMPLE/);
});
