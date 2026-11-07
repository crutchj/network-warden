import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import {
  describePfSenseProbeAdapter,
  pfsenseTelemetryFindings,
} from "./adapters/pfsense-probe.mjs";
import { correlateChecks } from "./engine.mjs";
import { collectPfSenseTelemetry } from "./pfsense/client.mjs";

const execFileAsync = promisify(execFile);

function elapsed(startedAt) {
  return Math.max(1, Math.round(performance.now() - startedAt));
}

function activeIpv4Adapter() {
  const startedAt = performance.now();
  for (const [interfaceName, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && !address.address.startsWith("169.254.")) {
        return {
          ok: true,
          interfaceName,
          address: address.address,
          duration: `${elapsed(startedAt)} ms`,
        };
      }
    }
  }
  return {
    ok: false,
    interfaceName: "none",
    address: "unavailable",
    duration: `${elapsed(startedAt)} ms`,
  };
}

async function pingHost(host, timeoutMs) {
  const startedAt = performance.now();
  const windows = process.platform === "win32";
  const args = windows
    ? ["-n", "2", "-w", String(timeoutMs), host]
    : ["-c", "2", "-W", String(Math.max(1, Math.ceil(timeoutMs / 1000))), host];

  try {
    const { stdout } = await execFileAsync(windows ? "ping.exe" : "ping", args, {
      timeout: timeoutMs * 3,
      windowsHide: true,
    });
    return {
      ok: true,
      detail: stdout.split(/\r?\n/).find((line) => /time[=<]/i.test(line))?.trim() ?? "reply received",
      elapsedMs: elapsed(startedAt),
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message.split(/\r?\n/)[0] : "ping failed",
      elapsedMs: elapsed(startedAt),
    };
  }
}

function checkTcp(host, port, timeoutMs) {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    function finish(ok, detail) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        ok,
        target: `${host}:${port}`,
        detail,
        elapsedMs: elapsed(startedAt),
      });
    }

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, `TCP ${host}:${port} accepted a connection`));
    socket.once("timeout", () => finish(false, `TCP ${host}:${port} timed out after ${timeoutMs} ms`));
    socket.once("error", (error) => finish(false, error.message));
  });
}

function checkPfSenseGui(host, protocol, port, timeoutMs) {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const secureTransport = protocol === "https";
    const transport = secureTransport ? https : http;
    const request = transport.request(
      {
        host,
        port,
        path: "/",
        method: "GET",
        ...(secureTransport ? { rejectUnauthorized: false } : {}),
        timeout: timeoutMs,
        headers: {
          "User-Agent": "Network-Warden-ReadOnly-Connector/0.5",
        },
      },
      (response) => {
        response.resume();
        resolve({
          ok: true,
          statusCode: response.statusCode ?? 0,
          detail: `${protocol.toUpperCase()} responded with status ${response.statusCode ?? "unknown"}`,
          elapsedMs: elapsed(startedAt),
        });
      },
    );

    request.once("timeout", () => {
      request.destroy();
      resolve({
        ok: false,
        statusCode: 0,
        detail: `${protocol.toUpperCase()} timed out after ${timeoutMs} ms`,
        elapsedMs: elapsed(startedAt),
      });
    });
    request.once("error", (error) => {
      resolve({
        ok: false,
        statusCode: 0,
        detail: error.message,
        elapsedMs: elapsed(startedAt),
      });
    });
    request.end();
  });
}

async function resolveWithSystem(hostname) {
  const startedAt = performance.now();
  try {
    const addresses = await dns.promises.resolve4(hostname);
    return {
      ok: addresses.length > 0,
      hostname,
      addresses,
      detail: addresses.length ? `resolved ${addresses.length} IPv4 address(es)` : "no IPv4 answers",
      elapsedMs: elapsed(startedAt),
    };
  } catch (error) {
    return {
      ok: false,
      hostname,
      addresses: [],
      detail: error instanceof Error ? error.message : "DNS lookup failed",
      elapsedMs: elapsed(startedAt),
    };
  }
}

async function resolveWithExternal(hostname, server, timeoutMs) {
  const startedAt = performance.now();
  const resolver = new dns.promises.Resolver({ timeout: timeoutMs, tries: 1 });
  resolver.setServers([server]);
  try {
    const addresses = await resolver.resolve4(hostname);
    return {
      ok: addresses.length > 0,
      hostname,
      server,
      addresses,
      detail: addresses.length ? `direct query returned ${addresses.length} IPv4 answer(s)` : "no IPv4 answers",
      elapsedMs: elapsed(startedAt),
    };
  } catch (error) {
    return {
      ok: false,
      hostname,
      server,
      addresses: [],
      detail: error instanceof Error ? error.message : "external DNS lookup failed",
      elapsedMs: elapsed(startedAt),
    };
  }
}

export async function runDiagnostics(config, pfsenseSession = null) {
  const target = config.pfsense;
  const adapter = describePfSenseProbeAdapter(target, Boolean(pfsenseSession));
  const timeoutMs = config.diagnostics.timeoutMs;
  const hostname = config.diagnostics.dnsHostname;
  const externalDnsServer = config.diagnostics.externalDnsServer;

  const localAdapter = activeIpv4Adapter();
  const [pfsensePing, pfsenseGui, internetTcp, systemDns, externalDns, pfsenseTelemetry] = await Promise.all([
    pingHost(target.host, timeoutMs),
    checkPfSenseGui(target.host, target.protocol, target.port, timeoutMs),
    checkTcp(config.diagnostics.internetProbeHost, config.diagnostics.internetProbePort, timeoutMs),
    resolveWithSystem(hostname),
    resolveWithExternal(hostname, externalDnsServer, timeoutMs),
    pfsenseSession
      ? collectPfSenseTelemetry(pfsenseSession, target, Math.max(timeoutMs, 5000))
      : Promise.resolve(null),
  ]);

  const snapshot = {
    collectedAt: new Date().toISOString(),
    target,
    localAdapter,
    pfsensePing,
    pfsenseGui,
    internetTcp,
    systemDns,
    externalDns,
  };

  const result = correlateChecks(snapshot);

  return {
    ...result,
    findings: [
      ...result.findings,
      ...pfsenseTelemetryFindings(adapter, pfsenseTelemetry),
    ],
    collectedAt: snapshot.collectedAt,
    adapter: {
      id: adapter.id,
      platform: adapter.platform,
      mode: adapter.mode,
    },
    capabilityCoverage: adapter.capabilityCoverage,
    pfsenseTelemetry: pfsenseTelemetry
      ? {
          collectedAt: pfsenseTelemetry.collectedAt,
          connected: true,
        }
      : {
          collectedAt: null,
          connected: false,
        },
    target: {
      host: target.host,
      protocol: target.protocol,
      port: target.port,
    },
  };
}
