import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig } from "../src/config.js";

test("migrates the original OAuth-only config shape in memory", () => {
  const config = validateConfig({
    baseUrl: "https://brightspace.usc.edu/anything",
    clientId: "old-client",
    redirectUri: "https://localhost:3001/oauth/callback",
    outputDir: "/tmp/courses",
    concurrency: 4,
  });
  assert.equal(config.auth.method, "oauth");
  if (config.auth.method !== "oauth") assert.fail("expected OAuth config");
  assert.equal(config.auth.clientId, "old-client");
  assert.equal(config.baseUrl, "https://brightspace.usc.edu");
});

test("defaults a config without OAuth credentials to browser-session", () => {
  const config = validateConfig({ outputDir: "/tmp/courses" });
  assert.deepEqual(config.auth, { method: "browser-session" });
});
