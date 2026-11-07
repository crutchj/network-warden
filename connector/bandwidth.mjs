import { performance } from "node:perf_hooks";

export const BANDWIDTH_TEST_TIMEOUT_MS = 15_000;
export const DOWNLOAD_TEST_BYTES = 25_000_000;
export const UPLOAD_TEST_BYTES = 10_000_000;
export const CLOUDFLARE_DOWNLOAD_URL = "https://speed.cloudflare.com/__down";
export const CLOUDFLARE_UPLOAD_URL = "https://speed.cloudflare.com/__up";
export const BANDWIDTH_IN_PROGRESS_CODE = "BANDWIDTH_IN_PROGRESS";

function elapsedMilliseconds(startedAt) {
  return Math.max(1, Math.round(performance.now() - startedAt));
}

function completeDirection(bytesTransferred, durationMs) {
  return {
    status: "complete",
    mbps: Number(((bytesTransferred * 8) / (durationMs / 1000) / 1_000_000).toFixed(1)),
    bytesTransferred,
    durationMs,
  };
}

function failedDirection(reason, bytesTransferred, durationMs) {
  return {
    status: "failed",
    bytesTransferred,
    durationMs,
    reason,
  };
}

function abortErrorMessage(direction, timeoutMs) {
  return `${direction} measurement timed out after ${Math.round(timeoutMs / 1000)} seconds.`;
}

function errorMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function byteLength(chunk) {
  if (!chunk) return 0;
  if (typeof chunk.byteLength === "number") return chunk.byteLength;
  if (typeof chunk.length === "number") return chunk.length;
  return 0;
}

async function readBodyBytes(body) {
  if (!body) return 0;
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    let bytesTransferred = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) return bytesTransferred;
      bytesTransferred += byteLength(value);
    }
  }

  let bytesTransferred = 0;
  for await (const chunk of body) {
    bytesTransferred += byteLength(chunk);
  }
  return bytesTransferred;
}

function uploadPayload(size) {
  const payload = new Uint8Array(size);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = index % 251;
  }
  return payload;
}

async function measureDownload({
  fetchImpl,
  url,
  bytes,
  timeoutMs,
}) {
  const startedAt = performance.now();
  let timedOut = false;
  let bytesTransferred = 0;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(`${url}?bytes=${bytes}`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      return failedDirection(
        `Download endpoint returned HTTP ${response.status}.`,
        bytesTransferred,
        elapsedMilliseconds(startedAt),
      );
    }
    bytesTransferred = await readBodyBytes(response.body);
    const durationMs = elapsedMilliseconds(startedAt);
    if (bytesTransferred < bytes) {
      return failedDirection(
        "Download ended before the requested sample completed.",
        bytesTransferred,
        durationMs,
      );
    }
    return completeDirection(bytesTransferred, durationMs);
  } catch (error) {
    return failedDirection(
      timedOut || error?.name === "AbortError"
        ? abortErrorMessage("Download", timeoutMs)
        : errorMessage(error, "Download measurement failed."),
      bytesTransferred,
      elapsedMilliseconds(startedAt),
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function measureUpload({
  fetchImpl,
  url,
  bytes,
  timeoutMs,
}) {
  const startedAt = performance.now();
  let timedOut = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      body: uploadPayload(bytes),
      headers: {
        "Content-Type": "application/octet-stream",
      },
      signal: controller.signal,
    });
    const durationMs = elapsedMilliseconds(startedAt);
    if (!response.ok) {
      return failedDirection(`Upload endpoint returned HTTP ${response.status}.`, 0, durationMs);
    }
    return completeDirection(bytes, durationMs);
  } catch (error) {
    return failedDirection(
      timedOut || error?.name === "AbortError"
        ? abortErrorMessage("Upload", timeoutMs)
        : errorMessage(error, "Upload measurement failed."),
      0,
      elapsedMilliseconds(startedAt),
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function measureBandwidth({
  fetchImpl = globalThis.fetch,
  timeoutMs = BANDWIDTH_TEST_TIMEOUT_MS,
  downloadBytes = DOWNLOAD_TEST_BYTES,
  uploadBytes = UPLOAD_TEST_BYTES,
  downloadUrl = CLOUDFLARE_DOWNLOAD_URL,
  uploadUrl = CLOUDFLARE_UPLOAD_URL,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Bandwidth measurement requires a fetch implementation.");
  }

  const download = await measureDownload({
    fetchImpl,
    url: downloadUrl,
    bytes: downloadBytes,
    timeoutMs,
  });
  const upload = await measureUpload({
    fetchImpl,
    url: uploadUrl,
    bytes: uploadBytes,
    timeoutMs,
  });

  return {
    measuredBy: "local-connector",
    source: "Cloudflare speed endpoint",
    measuredAt: new Date().toISOString(),
    timeoutMs,
    download,
    upload,
  };
}

export function bandwidthInProgressError() {
  const error = new Error("Bandwidth measurement already in progress.");
  error.code = BANDWIDTH_IN_PROGRESS_CODE;
  return error;
}

export function isBandwidthInProgressError(error) {
  return error?.code === BANDWIDTH_IN_PROGRESS_CODE;
}

export function createBandwidthMeasurementRunner(options = {}) {
  let activeMeasurement = null;

  return async function runBandwidthMeasurement() {
    if (activeMeasurement) throw bandwidthInProgressError();
    activeMeasurement = measureBandwidth(options).finally(() => {
      activeMeasurement = null;
    });
    return activeMeasurement;
  };
}
