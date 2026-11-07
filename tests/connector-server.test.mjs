import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dashboardOrigin = "http://localhost:7331";

async function startConnector() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "network-warden-test-"));
  const configPath = join(temporaryDirectory, "network-warden.config.json");
  await writeFile(configPath, JSON.stringify({ connector: { port: 0 } }, null, 2));
  const child = spawn(process.execPath, ["connector/server.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NETWORK_WARDEN_CONFIG: configPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const ready = new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`Connector did not start.\n${output}`)), 5000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/connector ready on http:\/\/127\.0\.0\.1:(\d+)/i);
      if (match) {
        clearTimeout(timeout);
        resolveReady(Number(match[1]));
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectReady(new Error(`Connector exited with code ${code}.\n${output}`));
    });
  });

  const port = await ready;
  assert.notEqual(port, 7332, "connector-server test must not bind the live connector port");
  return {
    child,
    configPath,
    baseUrl: `http://127.0.0.1:${port}`,
    cleanup: () => rm(temporaryDirectory, { recursive: true, force: true }),
  };
}

test("serves only local read-only connector endpoints to allowed dashboard origins", async () => {
  const { child, configPath, baseUrl, cleanup } = await startConnector();
  try {
    const statusResponse = await fetch(`${baseUrl}/v1/status`, {
      headers: { Origin: dashboardOrigin },
    });
    assert.equal(statusResponse.status, 200);
    assert.equal(statusResponse.headers.get("access-control-allow-origin"), dashboardOrigin);
    const status = await statusResponse.json();
    assert.equal(status.mode, "read-only");
    assert.equal(status.target.host, "192.168.1.1");
    assert.equal(status.version, "0.5.0");
    assert.equal(status.target.protocol, "https");
    assert.equal(status.target.port, 443);
    assert.equal(status.adapter.id, "pfsense-external-probe");
    assert.equal(status.capabilities.length, 5);
    assert.equal(status.pfsenseConnection.status, "disconnected");
    assert.equal(status.pfsenseConnection.credentialStorage, "none");
    assert.equal(
      status.capabilityCoverage.filter((capability) => capability.status === "unavailable").length,
      4,
    );

    const deniedResponse = await fetch(`${baseUrl}/v1/status`, {
      headers: { Origin: "https://untrusted.example" },
    });
    assert.equal(deniedResponse.status, 403);

    const missingResponse = await fetch(`${baseUrl}/v1/repair`, {
      method: "POST",
      headers: { Origin: dashboardOrigin },
    });
    assert.equal(missingResponse.status, 404);

    const invalidConnectResponse = await fetch(`${baseUrl}/v1/pfsense/connect`, {
      method: "POST",
      headers: {
        Origin: dashboardOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: "networkwarden" }),
    });
    assert.equal(invalidConnectResponse.status, 400);
    assert.doesNotMatch(await invalidConnectResponse.text(), /passwordfld|cookie|stack/i);

    const settingsResponse = await fetch(`${baseUrl}/v1/settings`, {
      method: "POST",
      headers: {
        Origin: dashboardOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        platform: "pfsense",
        host: "pfsense.home",
        protocol: "http",
        port: 8080,
        password: "must-not-be-written",
      }),
    });
    assert.equal(settingsResponse.status, 200);
    assert.deepEqual((await settingsResponse.json()).target, {
      host: "pfsense.home",
      protocol: "http",
      port: 8080,
    });
    const savedConfig = await readFile(configPath, "utf8");
    assert.match(savedConfig, /pfsense\.home/);
    assert.doesNotMatch(savedConfig, /must-not-be-written|password/i);

    const refreshedStatus = await fetch(`${baseUrl}/v1/status`, {
      headers: { Origin: dashboardOrigin },
    });
    assert.equal((await refreshedStatus.json()).target.host, "pfsense.home");
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await cleanup();
  }
});
