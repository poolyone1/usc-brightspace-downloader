import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  decryptStorageState,
  encryptStorageState,
  filterStorageState,
} from "../src/browser-session-store.js";
import type { StorageState } from "../src/browser-session-store.js";

const cookie = (name: string, domain: string) => ({
  name,
  value: `${name}-value`,
  domain,
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: "Lax" as const,
});

test("persists only exact Brightspace cookies and origin storage", () => {
  const state: StorageState = {
    cookies: [
      cookie("d2l", ".brightspace.usc.edu"),
      cookie("microsoft", "login.microsoftonline.com"),
      cookie("lookalike", "evilbrightspace.usc.edu"),
    ],
    origins: [
      { origin: "https://brightspace.usc.edu", localStorage: [{ name: "theme", value: "dark" }] },
      { origin: "https://login.microsoftonline.com", localStorage: [{ name: "token", value: "no" }] },
    ],
  };
  const filtered = filterStorageState(state, "https://brightspace.usc.edu");
  assert.deepEqual(filtered.cookies.map((entry) => entry.name), ["d2l"]);
  assert.deepEqual(filtered.origins.map((entry) => entry.origin), ["https://brightspace.usc.edu"]);
});

test("encrypts round-trip and fails closed after ciphertext modification", () => {
  const origin = "https://brightspace.usc.edu";
  const state: StorageState = {
    cookies: [cookie("d2l", ".brightspace.usc.edu")],
    origins: [],
  };
  const key = randomBytes(32);
  const envelope = encryptStorageState(state, origin, key);
  assert.deepEqual(decryptStorageState(envelope, origin, key), state);
  const bytes = Buffer.from(envelope.ciphertext, "base64");
  bytes[0] = (bytes[0] || 0) ^ 1;
  assert.throws(
    () => decryptStorageState({ ...envelope, ciphertext: bytes.toString("base64") }, origin, key),
    /could not be decrypted or was modified/,
  );
});
