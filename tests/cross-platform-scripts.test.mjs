import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const startLocalSource = await readFile(
  new URL("../scripts/start-local.mjs", import.meta.url),
  "utf8",
);
const startWindowsSource = await readFile(
  new URL("../scripts/start-windows.mjs", import.meta.url),
  "utf8",
);

test("Windows-facing npm commands avoid Unix-only shell syntax", () => {
  const windowsFacingScripts = [
    "dev",
    "build",
    "start",
    "test",
    "validate:artifact",
    "lint",
    "db:generate",
    "start:local",
    "start:windows",
  ];

  for (const name of windowsFacingScripts) {
    const command = packageJson.scripts[name];
    assert.equal(typeof command, "string", `Missing npm script: ${name}`);
    assert.doesNotMatch(command, /(^|\s)bash(\s|$)/, `${name} requires bash`);
    assert.doesNotMatch(
      command,
      /(^|&&\s*)[A-Z_][A-Z0-9_]*=/,
      `${name} uses POSIX-only environment assignment`,
    );
  }
});

test("Windows launchers use Node directly instead of Windows npm command shims", () => {
  for (const source of [startLocalSource, startWindowsSource]) {
    assert.doesNotMatch(source, /\bnpm(?:\.cmd)?\b/i);
  }

  assert.match(
    startWindowsSource,
    /start\(process\.execPath,\s*\["scripts\/start-local\.mjs"\]\)/,
  );
  assert.match(
    startLocalSource,
    /spawn\(\s*process\.execPath,\s*\[\s*"scripts\/dev\.mjs"/,
  );
});
