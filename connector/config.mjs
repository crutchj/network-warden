import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const defaults = {
  dashboard: {
    host: "127.0.0.1",
    port: 7331,
  },
  connector: {
    host: "127.0.0.1",
    port: 7332,
    dashboardOrigins: [
      "http://localhost:7331",
      "http://127.0.0.1:7331",
    ],
  },
  pfsense: {
    adapter: "external-probe",
    host: "192.168.1.1",
    protocol: "https",
    port: 443,
  },
  diagnostics: {
    timeoutMs: 2500,
    dnsHostname: "example.com",
    externalDnsServer: "1.1.1.1",
    internetProbeHost: "1.1.1.1",
    internetProbePort: 443,
  },
};

function mergeConfig(base, custom) {
  const customPfSense = custom.pfsense ?? {};
  const configuredPort = customPfSense.port ?? customPfSense.httpsPort;
  const pfsense = {
    ...base.pfsense,
    ...customPfSense,
    protocol: customPfSense.protocol ??
      (Number(configuredPort) === 80 ? "http" : base.pfsense.protocol),
    port: configuredPort ?? base.pfsense.port,
  };
  delete pfsense.httpsPort;

  const merged = {
    dashboard: { ...base.dashboard, ...custom.server },
    connector: { ...base.connector, ...custom.connector },
    pfsense,
    diagnostics: { ...base.diagnostics, ...custom.diagnostics },
  };
  if (!custom.connector?.dashboardOrigins) {
    merged.connector.dashboardOrigins = [
      `http://localhost:${merged.dashboard.port}`,
      `http://127.0.0.1:${merged.dashboard.port}`,
    ];
  }
  return merged;
}

function validate(config) {
  if (config.connector.host !== "127.0.0.1") {
    throw new Error("The v1 connector must bind to 127.0.0.1.");
  }
  for (const [label, port] of [
    ["dashboard port", config.dashboard.port],
    ["pfSense management port", config.pfsense.port],
    ["Internet probe port", config.diagnostics.internetProbePort],
  ]) {
    if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
      throw new Error(`Invalid ${label}.`);
    }
  }
  if (!Number.isInteger(Number(config.connector.port)) || Number(config.connector.port) < 0 || Number(config.connector.port) > 65535) {
    throw new Error("Invalid connector port.");
  }
  config.connector.port = Number(config.connector.port);
  config.pfsense.port = Number(config.pfsense.port);
  if (config.pfsense.protocol !== "http" && config.pfsense.protocol !== "https") {
    throw new Error("The pfSense management protocol must be HTTP or HTTPS.");
  }
  if (!config.pfsense.host || typeof config.pfsense.host !== "string") {
    throw new Error("A pfSense host address is required.");
  }
  const host = config.pfsense.host.trim();
  if (
    host.length > 253 ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)
  ) {
    throw new Error("Enter a valid pfSense IP address or hostname.");
  }
  config.pfsense.host = host;
  if (config.pfsense.adapter !== "external-probe") {
    throw new Error("The current pfSense adapter must be external-probe.");
  }
  return config;
}

function readCustomConfig(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadConnectorConfig(projectRoot) {
  const path = resolve(
    process.env.NETWORK_WARDEN_CONFIG ??
      resolve(projectRoot, "config", "network-warden.config.json"),
  );
  const custom = readCustomConfig(path);
  return {
    path,
    value: validate(mergeConfig(defaults, custom)),
  };
}

export function saveHomeLabSettings(path, settings) {
  if (settings?.platform !== "pfsense") {
    throw new Error("pfSense is the only supported firewall platform in this release.");
  }

  const custom = readCustomConfig(path);
  custom.pfsense = {
    ...custom.pfsense,
    adapter: "external-probe",
    host: String(settings.host ?? "").trim(),
    protocol: settings.protocol ??
      (Number(settings.port ?? settings.httpsPort) === 80 ? "http" : "https"),
    port: Number(settings.port ?? settings.httpsPort),
  };
  delete custom.pfsense.httpsPort;

  const value = validate(mergeConfig(defaults, custom));
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(custom, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
  return value;
}

export { defaults as defaultConnectorConfig };
