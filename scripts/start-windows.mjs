import { spawn } from "node:child_process";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConnectorConfig } from "../connector/config.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { value: config } = loadConnectorConfig(projectRoot);
const connectorUrl = `http://${config.connector.host}:${config.connector.port}`;
const dashboardUrl = `http://localhost:${config.dashboard.port}`;
const dashboardLaunchUrl = `${dashboardUrl}/?connectorPort=${config.connector.port}`;
const children = [];

function start(command, args) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  children.push(child);
  child.once("exit", (code) => {
    if (code && code !== 0) shutdown(code);
  });
  return child;
}

function waitFor(url, attempts = 80) {
  return new Promise((resolveReady, rejectReady) => {
    let remaining = attempts;
    function tryOnce() {
      const request = http.get(url, (response) => {
        response.resume();
        if ((response.statusCode ?? 500) < 500) {
          resolveReady();
          return;
        }
        retry();
      });
      request.setTimeout(700, () => request.destroy());
      request.once("error", retry);
    }
    function retry() {
      remaining -= 1;
      if (remaining <= 0) {
        rejectReady(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(tryOnce, 250);
    }
    tryOnce();
  });
}

function openBrowser(url) {
  if (process.platform === "win32") {
    const opener = spawn("cmd.exe", ["/d", "/s", "/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    opener.unref();
  }
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("Starting Network Warden…");
start(process.execPath, ["connector/server.mjs"]);
start(process.execPath, ["scripts/start-local.mjs"]);

try {
  await Promise.all([
    waitFor(`${connectorUrl}/v1/status`),
    waitFor(`${dashboardUrl}/`),
  ]);
  console.log("Network Warden is ready.");
  openBrowser(dashboardLaunchUrl);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  shutdown(1);
}
