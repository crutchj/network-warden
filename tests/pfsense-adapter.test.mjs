import assert from "node:assert/strict";
import test from "node:test";

import {
  describePfSenseProbeAdapter,
  pfsenseTelemetryFindings,
} from "../connector/adapters/pfsense-probe.mjs";

test("pfSense probe adapter reports disconnected firewall capabilities honestly", () => {
  const adapter = describePfSenseProbeAdapter({
    host: "192.0.2.1",
    protocol: "https",
    port: 443,
  });

  assert.equal(adapter.mode, "read-only");
  assert.equal(adapter.authentication, "not-connected");
  assert.equal(adapter.capabilities.length, 5);
  assert.equal(
    adapter.capabilityCoverage.filter((capability) => capability.status === "unavailable").length,
    4,
  );

  const findings = pfsenseTelemetryFindings(adapter);
  assert.deepEqual(
    findings.map(({ id, status }) => ({ id, status })),
    [
      { id: "pfsense-wan-interface", status: "unavailable" },
      { id: "pfsense-gateways", status: "unavailable" },
      { id: "pfsense-system-load", status: "unavailable" },
      { id: "pfsense-core-services", status: "unavailable" },
    ],
  );
});

test("authenticated adapter adds telemetry without adding service controls", () => {
  const adapter = describePfSenseProbeAdapter({
    host: "192.0.2.1",
    protocol: "https",
    port: 443,
  }, true);
  assert.equal(adapter.authentication, "session-only");
  assert.equal(adapter.capabilities.length, 8);
  assert.equal(
    adapter.capabilityCoverage.filter((capability) => capability.status === "unavailable").length,
    1,
  );

  const findings = pfsenseTelemetryFindings(adapter, {
    interfaces: {
      wan: {
        status: "up",
        dhcpStatus: "up",
        ipv4Address: "198.51.100.8",
        ipv4Gateway: "198.51.100.1",
        media: "1000baseT full-duplex",
      },
    },
    gateways: [
      {
        name: "WAN_DHCP",
        status: "Online",
        monitor: "1.1.1.1",
        delay: "11.2ms",
        loss: "0.0%",
      },
    ],
    cpuLoadPercent: 17,
  });

  assert.deepEqual(
    findings.map(({ id, status }) => ({ id, status })),
    [
      { id: "pfsense-wan-interface", status: "pass" },
      { id: "pfsense-gateways", status: "pass" },
      { id: "pfsense-system-load", status: "pass" },
      { id: "pfsense-core-services", status: "unavailable" },
    ],
  );
});
