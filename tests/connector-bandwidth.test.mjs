import assert from "node:assert/strict";
import test from "node:test";

import {
  BANDWIDTH_IN_PROGRESS_CODE,
  createBandwidthMeasurementRunner,
  measureBandwidth,
} from "../connector/bandwidth.mjs";

function bytesResponse(size) {
  return new Response(new Uint8Array(size));
}

function okResponse() {
  return new Response("ok");
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("measures successful download and upload directions with injected fetch", async () => {
  const calls = [];
  const result = await measureBandwidth({
    downloadBytes: 12,
    uploadBytes: 8,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("__down")) return bytesResponse(12);
      assert.equal(init.method, "POST");
      assert.equal(init.body.byteLength, 8);
      return okResponse();
    },
  });

  assert.equal(result.measuredBy, "local-connector");
  assert.equal(result.download.status, "complete");
  assert.equal(result.download.bytesTransferred, 12);
  assert.equal(typeof result.download.mbps, "number");
  assert.equal(result.upload.status, "complete");
  assert.equal(result.upload.bytesTransferred, 8);
  assert.equal(typeof result.upload.mbps, "number");
  assert.equal(calls.length, 2);
});

test("marks short download as failed without an Mbps value", async () => {
  const result = await measureBandwidth({
    downloadBytes: 12,
    uploadBytes: 8,
    fetchImpl: async (url) => String(url).includes("__down")
      ? bytesResponse(4)
      : okResponse(),
  });

  assert.equal(result.download.status, "failed");
  assert.equal(result.download.bytesTransferred, 4);
  assert.match(result.download.reason, /ended before/i);
  assert.equal("mbps" in result.download, false);
  assert.equal(result.upload.status, "complete");
});

test("marks timeout as failed without an Mbps value", async () => {
  let calls = 0;
  const result = await measureBandwidth({
    timeoutMs: 5,
    downloadBytes: 12,
    uploadBytes: 8,
    fetchImpl: async (_url, init = {}) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        });
      }
      return okResponse();
    },
  });

  assert.equal(result.download.status, "failed");
  assert.match(result.download.reason, /timed out/i);
  assert.equal("mbps" in result.download, false);
});

test("rejects a concurrent bandwidth measurement while one is active", async () => {
  const firstDownload = deferred();
  const runner = createBandwidthMeasurementRunner({
    downloadBytes: 12,
    uploadBytes: 8,
    fetchImpl: async (url) => {
      if (String(url).includes("__down")) {
        await firstDownload.promise;
        return bytesResponse(12);
      }
      return okResponse();
    },
  });

  const firstRun = runner();
  await assert.rejects(
    () => runner(),
    (error) => error.code === BANDWIDTH_IN_PROGRESS_CODE,
  );
  firstDownload.resolve();
  const result = await firstRun;
  assert.equal(result.download.status, "complete");
});
