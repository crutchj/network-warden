import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logPath = resolve(projectRoot, ".wrangler", "wrangler.log");
const viteCli = resolve(projectRoot, "node_modules", "vite", "bin", "vite.js");

mkdirSync(dirname(logPath), { recursive: true });

const child = spawn(process.execPath, [viteCli, ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: {
    ...process.env,
    WRANGLER_LOG_PATH: logPath,
  },
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(`Could not start the Network Warden dashboard: ${error.message}`);
  process.exit(1);
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
