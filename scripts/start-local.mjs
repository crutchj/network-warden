import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 7331;
const DEFAULT_HOST = "127.0.0.1";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readConfigFile(path) {
  if (!existsSync(path)) return {};

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`Network Warden could not read ${path}.`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function validPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error("NETWORK_WARDEN_PORT must be a whole number from 1024 through 65535.");
    process.exit(1);
  }
  return port;
}

const configPath = resolve(
  process.env.NETWORK_WARDEN_CONFIG ??
    resolve(projectRoot, "config", "network-warden.config.json"),
);
const fileConfig = readConfigFile(configPath);

const port = validPort(
  argumentValue("--port") ??
    process.env.NETWORK_WARDEN_PORT ??
    fileConfig.server?.port ??
    DEFAULT_PORT,
);
const host =
  argumentValue("--host") ??
  process.env.NETWORK_WARDEN_HOST ??
  fileConfig.server?.host ??
  DEFAULT_HOST;

const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
const networkAllowed =
  process.argv.includes("--allow-network") ||
  process.env.NETWORK_WARDEN_ALLOW_NETWORK === "true";

if (!localHosts.has(host) && !networkAllowed) {
  console.error(
    `Refusing to bind Network Warden to ${host}. ` +
      "Use --allow-network only after configuring authentication and firewall rules.",
  );
  process.exit(1);
}

const resolved = {
  configPath,
  host,
  port,
  displayUrl: `http://localhost:${port}`,
  localOnly: localHosts.has(host),
};

if (process.argv.includes("--print-config")) {
  console.log(JSON.stringify(resolved, null, 2));
  process.exit(0);
}

console.log("");
console.log("Network Warden local dashboard");
console.log(`Open ${resolved.displayUrl}`);
console.log(`Listening on ${host}:${port}`);
console.log("");

const child = spawn(
  process.execPath,
  ["scripts/dev.mjs", "--host", host, "--port", String(port)],
  {
    cwd: projectRoot,
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: ".wrangler/wrangler.log",
    },
    stdio: "inherit",
  },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
