import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

test("bandwidth test runs through the local connector only", () => {
  assert.match(pageSource, /\/v1\/bandwidth/);
  assert.match(pageSource, /Measured by the local connector from this PC/);
  assert.match(pageSource, /disabled=\{testing \|\| connectorState !== "live"\}/);
  assert.doesNotMatch(pageSource, /@cloudflare\/speedtest|new SpeedTest|logAimApiUrl|bandwidthAbortRequestDuration/);
});

test("failed bandwidth directions render failure without speed, percent, or quality", () => {
  assert.match(pageSource, /downloadFailed \? "Failed"/);
  assert.match(pageSource, /uploadFailed \? "Failed"/);
  assert.match(pageSource, /downloadComplete \? <span>Mbps<\/span>/);
  assert.match(pageSource, /uploadComplete \? <span>Mbps<\/span>/);
  assert.match(pageSource, /downloadComplete && downloadPlan/);
  assert.match(pageSource, /uploadComplete && uploadPlan/);
  assert.match(pageSource, /const bandwidthQuality = downloadComplete && uploadComplete/);
  assert.match(pageSource, /\{bandwidthQuality && \(/);
});

test("expected bandwidth fields accept direct numeric typing without spinner controls", () => {
  assert.doesNotMatch(pageSource, /<input type="number"/);
  assert.match(pageSource, /type="text" inputMode="numeric" pattern="\[0-9\]\*"/);
  assert.match(pageSource, /replace\(\/\\D\/g, ""\)/);
});

test("settings keep home-lab details local and exclude credentials", () => {
  assert.match(pageSource, /Network Warden settings/);
  assert.match(pageSource, /Firewall address/);
  assert.match(pageSource, /Expected download/);
  assert.match(pageSource, /Expected upload/);
  assert.match(pageSource, /\/v1\/settings/);
  assert.match(pageSource, /No credentials are saved here/);
});
