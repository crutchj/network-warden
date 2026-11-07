import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadConnectorConfig,
  saveHomeLabSettings,
} from "../connector/config.mjs";

test("migrates a legacy port-80 target to HTTP compatibility mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "network-warden-config-"));
  const configPath = join(directory, "network-warden.config.json");
  const previousPath = process.env.NETWORK_WARDEN_CONFIG;
  try {
    await writeFile(configPath, JSON.stringify({
      pfsense: {
        adapter: "external-probe",
        host: "192.0.2.1",
        httpsPort: 80,
      },
    }));
    process.env.NETWORK_WARDEN_CONFIG = configPath;
    const { value } = loadConnectorConfig(directory);
    assert.deepEqual(value.pfsense, {
      adapter: "external-probe",
      host: "192.0.2.1",
      protocol: "http",
      port: 80,
    });
  } finally {
    if (previousPath === undefined) delete process.env.NETWORK_WARDEN_CONFIG;
    else process.env.NETWORK_WARDEN_CONFIG = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("saves protocol and port without the legacy HTTPS-only key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "network-warden-config-"));
  const configPath = join(directory, "network-warden.config.json");
  try {
    const value = saveHomeLabSettings(configPath, {
      platform: "pfsense",
      host: "pfsense.home",
      protocol: "https",
      port: 8443,
    });
    assert.equal(value.pfsense.protocol, "https");
    assert.equal(value.pfsense.port, 8443);
    const saved = await readFile(configPath, "utf8");
    assert.doesNotMatch(saved, /httpsPort/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
