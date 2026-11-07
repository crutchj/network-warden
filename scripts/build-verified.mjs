import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateArtifact } from "./validate-artifact.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = resolve(
  process.env.SITES_RUNTIME_ROOT ?? resolve(projectRoot, ".sites-runtime"),
);
const vinextCli = resolve(
  projectRoot,
  "node_modules",
  "vinext",
  "dist",
  "cli.js",
);

function duration(value, fallback) {
  if (!value) return fallback;
  const match = /^(\d+)(ms|s|m)?$/.exec(value.trim());
  if (!match) {
    throw new Error(`Unsupported duration "${value}". Use ms, s, or m.`);
  }
  const amount = Number(match[1]);
  const multiplier = { ms: 1, s: 1_000, m: 60_000 }[match[2] ?? "ms"];
  return amount * multiplier;
}

function runBuild() {
  if (!existsSync(vinextCli)) {
    throw new Error(
      "Vinext is unavailable. Run npm install and wait for it to finish before building.",
    );
  }

  const xdgConfig = resolve(runtimeRoot, "xdg-config");
  const temp = resolve(runtimeRoot, "tmp");
  const wranglerLogs = resolve(runtimeRoot, "wrangler", "logs");
  for (const path of [xdgConfig, temp, wranglerLogs]) {
    mkdirSync(path, { recursive: true });
  }

  const timeoutMs = duration(process.env.SITES_BUILD_TIMEOUT, 3 * 60_000);
  const killAfterMs = duration(process.env.SITES_BUILD_KILL_AFTER, 10_000);

  console.log("Running bounded vinext build...");
  const child = spawn(process.execPath, [vinextCli, "build"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgConfig,
      TMPDIR: temp,
      WRANGLER_WRITE_LOGS: "false",
      WRANGLER_LOG_PATH: wranglerLogs,
      MINIFLARE_REGISTRY_PATH: resolve(runtimeRoot, "wrangler", "registry"),
    },
    stdio: "inherit",
  });

  return new Promise((resolveBuild, rejectBuild) => {
    let forcedKill;
    const timeout = setTimeout(() => {
      console.error(`Build exceeded ${timeoutMs} ms; stopping it.`);
      child.kill("SIGTERM");
      forcedKill = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      clearTimeout(forcedKill);
      rejectBuild(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(forcedKill);
      if (code === 0) {
        resolveBuild();
        return;
      }
      rejectBuild(
        new Error(
          signal
            ? `Vinext build stopped with signal ${signal}.`
            : `Vinext build exited with code ${code}.`,
        ),
      );
    });
  });
}

try {
  await runBuild();
  await validateArtifact(projectRoot);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
