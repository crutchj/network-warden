import assert from "node:assert/strict";
import test from "node:test";

import { correlateChecks } from "../connector/engine.mjs";

function snapshot(overrides = {}) {
  return {
    target: { host: "192.0.2.1", protocol: "https", port: 443 },
    localAdapter: { ok: true, interfaceName: "Ethernet", address: "192.168.1.44", duration: "1 ms" },
    pfsensePing: { ok: true, detail: "reply", elapsedMs: 8 },
    pfsenseGui: { ok: true, statusCode: 200, detail: "responded", elapsedMs: 18 },
    internetTcp: { ok: true, target: "1.1.1.1:443", detail: "connected", elapsedMs: 24 },
    systemDns: { ok: true, hostname: "example.com", addresses: ["93.184.216.34"], detail: "resolved", elapsedMs: 12 },
    externalDns: { ok: true, hostname: "example.com", server: "1.1.1.1", addresses: ["93.184.216.34"], detail: "resolved", elapsedMs: 14 },
    ...overrides,
  };
}

test("reports healthy when local gateway, Internet, and DNS pass", () => {
  const result = correlateChecks(snapshot());
  assert.equal(result.ruleId, "local-core-paths-healthy");
  assert.equal(result.severity, "healthy");
  assert.equal(result.findings.length, 5);
});

test("isolates configured DNS failure from a working Internet path", () => {
  const result = correlateChecks(snapshot({
    systemDns: { ok: false, hostname: "example.com", addresses: [], detail: "timeout", elapsedMs: 2500 },
  }));
  assert.equal(result.ruleId, "configured-dns-resolver-failure");
  assert.equal(result.confidence, 98);
});

test("reports upstream path failure when pfSense is reachable but Internet is not", () => {
  const result = correlateChecks(snapshot({
    internetTcp: { ok: false, target: "1.1.1.1:443", detail: "timeout", elapsedMs: 2500 },
    systemDns: { ok: false, hostname: "example.com", addresses: [], detail: "timeout", elapsedMs: 2500 },
    externalDns: { ok: false, hostname: "example.com", server: "1.1.1.1", addresses: [], detail: "timeout", elapsedMs: 2500 },
  }));
  assert.equal(result.ruleId, "upstream-internet-path-unavailable");
  assert.match(result.action, /WAN address/);
});

test("stops at the local gateway when pfSense is unreachable", () => {
  const result = correlateChecks(snapshot({
    pfsensePing: { ok: false, detail: "timeout", elapsedMs: 2500 },
    pfsenseGui: { ok: false, statusCode: 0, detail: "timeout", elapsedMs: 2500 },
  }));
  assert.equal(result.ruleId, "pfsense-gateway-unreachable");
  assert.equal(result.confidence, 97);
});
