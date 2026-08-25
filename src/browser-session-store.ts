import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext } from "playwright";
import { getStateDir } from "./config.js";
import { keychain } from "./keychain.js";

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

interface EncryptedEnvelope {
  version: 1;
  createdAt: string;
  origin: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function sessionPath(): string {
  return path.join(getStateDir(), "browser-session.enc");
}

function normalizedCookieDomain(domain: string): string {
  return domain.replace(/^\./, "").toLowerCase();
}

export function filterStorageState(state: StorageState, baseUrl: string): StorageState {
  const origin = new URL(baseUrl).origin;
  const hostname = new URL(origin).hostname.toLowerCase();
  return {
    cookies: state.cookies.filter((cookie) => normalizedCookieDomain(cookie.domain) === hostname),
    origins: state.origins
      .filter((entry) => entry.origin === origin)
      .map((entry) => ({ origin: entry.origin, localStorage: entry.localStorage })),
  };
}

function associatedData(origin: string): Buffer {
  return Buffer.from(`usc-bs-browser-session:v1:${origin}`, "utf8");
}

export function encryptStorageState(
  state: StorageState,
  origin: string,
  key: Buffer,
): EncryptedEnvelope {
  if (key.length !== 32) throw new Error("Browser-session encryption key must contain 32 bytes.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(associatedData(origin));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(state), "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    origin,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptStorageState(
  envelope: EncryptedEnvelope,
  expectedOrigin: string,
  key: Buffer,
): StorageState {
  if (envelope.version !== 1 || envelope.origin !== expectedOrigin) {
    throw new Error("Stored browser session belongs to a different Brightspace site.");
  }
  if (key.length !== 32) throw new Error("Invalid browser-session encryption key.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(associatedData(envelope.origin));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    const parsed = JSON.parse(plaintext.toString("utf8")) as StorageState;
    if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) throw new Error("invalid state");
    return parsed;
  } catch (error) {
    throw new Error("Stored browser session could not be decrypted or was modified.", { cause: error });
  }
}

async function getOrCreateKey(baseUrl: string): Promise<Buffer> {
  const stored = await keychain.getBrowserSessionKey(baseUrl);
  if (stored) {
    const key = Buffer.from(stored, "base64");
    if (key.length !== 32) throw new Error("The browser-session key in Keychain is invalid.");
    return key;
  }
  const key = randomBytes(32);
  await keychain.setBrowserSessionKey(baseUrl, key.toString("base64"));
  return key;
}

export async function saveBrowserSession(state: StorageState, baseUrl: string): Promise<void> {
  const origin = new URL(baseUrl).origin;
  const filtered = filterStorageState(state, origin);
  if (filtered.cookies.length === 0) {
    throw new Error("Login succeeded without a Brightspace cookie; no session was saved.");
  }
  const envelope = encryptStorageState(filtered, origin, await getOrCreateKey(origin));
  const dir = getStateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = sessionPath();
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function loadBrowserSession(baseUrl: string): Promise<StorageState> {
  const origin = new URL(baseUrl).origin;
  const storedKey = await keychain.getBrowserSessionKey(origin);
  if (!storedKey) throw new Error("Browser session key is missing. Run `usc-bs auth login`.");
  let raw: string;
  try {
    raw = await readFile(sessionPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Browser session is missing. Run `usc-bs auth login`.");
    }
    throw error;
  }
  const envelope = JSON.parse(raw) as EncryptedEnvelope;
  return decryptStorageState(envelope, origin, Buffer.from(storedKey, "base64"));
}

export async function hasBrowserSession(): Promise<boolean> {
  try {
    await access(sessionPath());
    return true;
  } catch {
    return false;
  }
}

export async function deleteBrowserSession(baseUrl: string): Promise<void> {
  await rm(sessionPath(), { force: true });
  await keychain.deleteBrowserSessionKey(baseUrl);
}
