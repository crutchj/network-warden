import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  authenticatePfSense,
  inspectPfSenseCertificate,
  pfsenseClientInternals,
} from "../connector/pfsense/client.mjs";
import {
  extractCsrfToken,
  isAccessDeniedPage,
  isLoginPage,
  parseCpuLoadPage,
  parseGatewaysPage,
  parseInterfacesPage,
} from "../connector/pfsense/html.mjs";

test("recognizes pfSense login, CSRF, and denied pages", () => {
  const login = `
    <body id="login">
      <form><input name="__csrf_magic" value="sid:abc123">
      <input name="usernamefld"></form>
    </body>`;
  assert.equal(isLoginPage(login), true);
  assert.equal(extractCsrfToken(login), "sid:abc123");
  assert.equal(isAccessDeniedPage("<h1>Access Denied</h1>"), true);
});

test("parses WAN interface, gateway, and CPU status fixtures", () => {
  const interfaces = parseInterfacesPage(`
    <div class="panel-title">WAN Interface (wan, igc0)</div>
    <table>
      <tr><th>Status</th><td>up</td></tr>
      <tr><th>DHCP</th><td>up</td></tr>
      <tr><th>IPv4 Address</th><td>198.51.100.8</td></tr>
      <tr><th>IPv4 Upstream gateway</th><td>198.51.100.1</td></tr>
      <tr><th>Media</th><td>1000baseT full-duplex</td></tr>
    </table>
    <div class="panel-title">LAN Interface (lan, igc1)</div>
    <table><tr><th>IPv4 Address</th><td>192.0.2.1</td></tr></table>
  `);
  assert.equal(interfaces.wan?.status, "up");
  assert.equal(interfaces.wan?.ipv4Address, "198.51.100.8");
  assert.equal(interfaces.wan?.ipv4Gateway, "198.51.100.1");

  const gateways = parseGatewaysPage(`
    <table>
      <tr><th>Gateway Name</th><th>Monitor IP</th><th>Delay</th><th>Loss</th><th>Status</th></tr>
      <tr><td>WAN_DHCP</td><td>1.1.1.1</td><td>11.2ms</td><td>0.0%</td><td>Online</td></tr>
    </table>
  `);
  assert.deepEqual(gateways, [{
    name: "WAN_DHCP",
    status: "Online",
    monitor: "1.1.1.1",
    delay: "11.2ms",
    loss: "0.0%",
  }]);
  assert.equal(parseCpuLoadPage("<span>17%</span>"), 17);
});

test("pins the firewall certificate and refuses non-telemetry paths", () => {
  const fingerprint = "AA:".repeat(31) + "AA";
  assert.doesNotThrow(() => pfsenseClientInternals.assertPinnedFingerprint(fingerprint, fingerprint));
  assert.throws(
    () => pfsenseClientInternals.assertPinnedFingerprint(fingerprint, "BB:".repeat(31) + "BB"),
    /certificate changed/i,
  );
  assert.equal(pfsenseClientInternals.validateRequestPath("/status_interfaces.php"), "/status_interfaces.php");
  assert.throws(
    () => pfsenseClientInternals.validateRequestPath("/status_services.php"),
    /non-telemetry/i,
  );
  assert.throws(
    () => pfsenseClientInternals.validateRequestPath("https://example.com/"),
    /non-telemetry/i,
  );
});

test("HTTP compatibility mode requires an explicit unencrypted-password acknowledgment", async () => {
  const target = {
    host: "192.0.2.1",
    protocol: "http",
    port: 80,
  };
  await assert.rejects(
    authenticatePfSense({
      target,
      username: "networkwarden",
      password: "test-password",
      timeoutMs: 100,
    }),
    /without encryption/i,
  );
  await assert.rejects(
    inspectPfSenseCertificate(target, 100),
    /requires HTTPS/i,
  );
});

test("dashboard never persists the pfSense password", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /type="password"/);
  assert.match(source, /HTTPS \(recommended\)/);
  assert.match(source, /HTTP \(unencrypted\)/);
  assert.match(source, /password without encryption/);
  assert.match(source, /setPfSensePassword\(""\)/);
  assert.doesNotMatch(source, /localStorage\.(?:setItem|getItem)\([^)]*pfsense/i);
  assert.doesNotMatch(source, /sessionStorage\.(?:setItem|getItem)\([^)]*pfsense/i);
});
