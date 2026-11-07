import assert from "node:assert/strict";
import test from "node:test";

import {
  CONNECTOR_COVERAGE_UNAVAILABLE_MESSAGE,
  getConnectorCoverageDisplay,
} from "../app/connector-capability-display.js";

test("maps available connector checks by label without count-only copy", () => {
  const display = getConnectorCoverageDisplay([
    { id: "local-adapter", label: "Computer network", source: "windows", status: "available" },
    { id: "configured-dns", label: "Configured DNS", source: "windows", status: "available" },
  ]);

  assert.equal(display.status, "ready");
  assert.deepEqual(
    display.items.map((item) => item.label),
    ["Computer network", "Configured DNS"],
  );
  assert.equal(display.message, "");
  assert.doesNotMatch(JSON.stringify(display), /\b\d+\s+(?:live\s+)?checks? (?:are|is) available/i);
});

test("keeps unavailable checks unavailable and carries the reason", () => {
  const display = getConnectorCoverageDisplay([
    { id: "internet-by-ip", label: "Internet path", source: "windows", status: "available" },
    {
      id: "pfsense-system-load",
      label: "CPU load",
      source: "pfsense",
      status: "unavailable",
      reason: "Connect the restricted pfSense account for this session.",
    },
  ]);

  const cpuLoad = display.items.find((item) => item.id === "pfsense-system-load");
  assert.equal(cpuLoad?.status, "unavailable");
  assert.equal(cpuLoad?.reason, "Connect the restricted pfSense account for this session.");
});

test("falls back honestly when capability coverage is missing or empty", () => {
  for (const input of [undefined, null, []]) {
    const display = getConnectorCoverageDisplay(input);
    assert.equal(display.status, "unavailable");
    assert.equal(display.message, CONNECTOR_COVERAGE_UNAVAILABLE_MESSAGE);
    assert.deepEqual(display.items, []);
  }
});