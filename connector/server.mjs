import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describePfSenseProbeAdapter } from "./adapters/pfsense-probe.mjs";
import {
  createBandwidthMeasurementRunner,
  isBandwidthInProgressError,
} from "./bandwidth.mjs";
import { loadConnectorConfig, saveHomeLabSettings } from "./config.mjs";
import { runDiagnostics } from "./diagnostics.mjs";
import {
  authenticatePfSense,
  inspectPfSenseCertificate,
} from "./pfsense/client.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { path: configPath, value: config } = loadConnectorConfig(projectRoot);
const startedAt = new Date().toISOString();
let activeCheck = null;
let pfsenseSession = null;
const runBandwidthMeasurement = createBandwidthMeasurementRunner();

function json(response, status, payload, origin) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (origin && config.connector.dashboardOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(payload));
}

function allowedOrigin(request) {
  const origin = request.headers.origin;
  return !origin || config.connector.dashboardOrigins.includes(origin);
}

function publicConnectionState() {
  return pfsenseSession
    ? {
        status: "connected",
        connectedAt: pfsenseSession.connectedAt,
        credentialStorage: "memory-only",
      }
    : {
        status: "disconnected",
        connectedAt: null,
        credentialStorage: "none",
      };
}

async function readJsonBody(request, maximumBytes = 16 * 1024) {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw new Error("Content-Type must be application/json.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin;
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

  if (!allowedOrigin(request)) {
    json(response, 403, { error: "Origin not allowed." });
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": origin ?? "",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    });
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/status") {
    const adapter = describePfSenseProbeAdapter(config.pfsense, Boolean(pfsenseSession));
    json(response, 200, {
      status: "ready",
      mode: "read-only",
      version: "0.5.0",
      startedAt,
      adapter: {
        id: adapter.id,
        platform: adapter.platform,
        displayName: adapter.displayName,
        authentication: adapter.authentication,
      },
      target: adapter.target,
      capabilities: adapter.capabilities,
      capabilityCoverage: adapter.capabilityCoverage,
      pfsenseConnection: publicConnectionState(),
    }, origin);
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/settings") {
    try {
      const body = await readJsonBody(request);
      const updated = saveHomeLabSettings(configPath, {
        platform: body.platform,
        host: body.host,
        protocol: body.protocol,
        port: body.port,
      });
      config.pfsense = updated.pfsense;
      pfsenseSession = null;
      activeCheck = null;
      json(response, 200, {
        saved: true,
        target: {
          host: config.pfsense.host,
          protocol: config.pfsense.protocol,
          port: config.pfsense.port,
        },
        credentialStorage: "none",
      }, origin);
    } catch (error) {
      json(response, 400, {
        error: error instanceof Error ? error.message : "Could not save the local settings.",
      }, origin);
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/pfsense/certificate") {
    try {
      if (config.pfsense.protocol !== "https") {
        throw new Error("TLS certificate inspection is available only when pfSense uses HTTPS.");
      }
      json(response, 200, {
        target: {
          host: config.pfsense.host,
          protocol: config.pfsense.protocol,
          port: config.pfsense.port,
        },
        certificate: await inspectPfSenseCertificate(
          config.pfsense,
          Math.max(config.diagnostics.timeoutMs, 5000),
        ),
      }, origin);
    } catch (error) {
      json(response, 502, {
        error: error instanceof Error ? error.message : "Could not inspect the pfSense certificate.",
      }, origin);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/pfsense/connect") {
    try {
      const body = await readJsonBody(request);
      const session = await authenticatePfSense({
        target: config.pfsense,
        username: body.username,
        password: body.password,
        fingerprint256: body.fingerprint256,
        insecureTransportAcknowledged: body.insecureTransportAcknowledged,
        timeoutMs: Math.max(config.diagnostics.timeoutMs, 5000),
      });
      pfsenseSession = session;
      activeCheck = null;
      const adapter = describePfSenseProbeAdapter(config.pfsense, true);
      json(response, 200, {
        connection: publicConnectionState(),
        capabilities: adapter.capabilities,
        capabilityCoverage: adapter.capabilityCoverage,
      }, origin);
    } catch (error) {
      pfsenseSession = null;
      json(response, 400, {
        error: error instanceof Error ? error.message : "Could not connect the restricted pfSense account.",
      }, origin);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/pfsense/disconnect") {
    pfsenseSession = null;
    activeCheck = null;
    json(response, 200, { connection: publicConnectionState() }, origin);
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/check") {
    if (!activeCheck) {
      activeCheck = runDiagnostics(config, pfsenseSession).finally(() => {
        activeCheck = null;
      });
    }
    try {
      json(response, 200, await activeCheck, origin);
    } catch (error) {
      json(response, 500, {
        error: "Diagnostic check failed.",
        detail: error instanceof Error ? error.message : String(error),
      }, origin);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/bandwidth") {
    try {
      json(response, 200, await runBandwidthMeasurement(), origin);
    } catch (error) {
      if (isBandwidthInProgressError(error)) {
        json(response, 409, { error: "Bandwidth measurement already in progress." }, origin);
      } else {
        json(response, 502, {
          error: "Bandwidth measurement failed.",
          detail: error instanceof Error ? error.message : String(error),
        }, origin);
      }
    }
    return;
  }

  json(response, 404, { error: "Not found." }, origin);
});

server.listen(config.connector.port, config.connector.host, () => {
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : config.connector.port;
  console.log(`Network Warden connector ready on http://${config.connector.host}:${boundPort}`);
  console.log(`Read-only target: ${config.pfsense.protocol}://${config.pfsense.host}:${config.pfsense.port}`);
  console.log(`Configuration: ${configPath}`);
});

function shutdown() {
  pfsenseSession = null;
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
