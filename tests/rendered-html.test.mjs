import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

const builtWorker = new URL("../dist/server/index.js", import.meta.url);

test("renders development preview metadata", async (t) => {
  if (!existsSync(builtWorker)) {
    t.skip("dist output is absent; run npm run build or npm run check for rendered HTML coverage.");
    return;
  }

  builtWorker.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(builtWorker.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  assert.match(await response.text(), developmentPreviewMeta);
});
