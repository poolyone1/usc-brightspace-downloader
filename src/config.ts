import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AppConfig, OAuthAppConfig } from "./types.js";
import { ask, askHidden } from "./prompt.js";
import { keychain } from "./keychain.js";

const DEFAULT_BASE_URL = "https://brightspace.usc.edu";
const DEFAULT_REDIRECT_URI = "https://localhost:3001/oauth/callback";
const DEFAULT_OUTPUT_DIR = path.join(homedir(), "Documents", "USC Brightspace Downloads");

export type AuthMethod = AppConfig["auth"]["method"];

export function getStateDir(): string {
  return process.env.USC_BS_STATE_DIR || path.join(homedir(), "Library", "Application Support", "usc-bs");
}

export function getConfigPath(): string {
  return path.join(getStateDir(), "config.json");
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Brightspace base URL must use HTTPS.");
  return url.origin;
}

function normalizeRedirectUri(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("OAuth redirect URI must use HTTPS.");
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("The proof-of-concept redirect URI must point to localhost.");
  }
  if (!url.port) throw new Error("OAuth redirect URI must contain an explicit port.");
  return url.toString();
}

function normalizeOutputDir(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return path.resolve(value);
}

export function validateConfig(value: unknown): AppConfig {
  if (!value || typeof value !== "object") throw new Error("Invalid config file.");
  const raw = value as Record<string, unknown>;
  const common = {
    baseUrl: normalizeBaseUrl(String(raw.baseUrl || DEFAULT_BASE_URL)),
    outputDir: normalizeOutputDir(String(raw.outputDir || DEFAULT_OUTPUT_DIR)),
    concurrency: Number.isInteger(raw.concurrency) && Number(raw.concurrency) > 0
      ? Math.min(Number(raw.concurrency), 8)
      : 3,
  };

  // Migrate the original OAuth-only config format in memory.
  const auth = raw.auth as Record<string, unknown> | undefined;
  const method = auth?.method || (typeof raw.clientId === "string" ? "oauth" : "browser-session");
  if (method === "browser-session") return { ...common, auth: { method } };
  if (method !== "oauth") throw new Error(`Unknown authentication method: ${String(method)}.`);
  const clientId = String(auth?.clientId || raw.clientId || "");
  if (!clientId) throw new Error("OAuth config is missing clientId.");
  return {
    ...common,
    auth: {
      method,
      clientId,
      redirectUri: normalizeRedirectUri(String(auth?.redirectUri || raw.redirectUri || DEFAULT_REDIRECT_URI)),
    },
  };
}

export async function loadConfig(): Promise<AppConfig | null> {
  try {
    const raw = JSON.parse(await readFile(getConfigPath(), "utf8")) as unknown;
    return applyEnvironment(validateConfig(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function applyEnvironment(config: AppConfig): AppConfig {
  const common = { ...config, outputDir: process.env.USC_BS_OUTPUT || config.outputDir };
  if (config.auth.method === "browser-session") return validateConfig(common);
  return validateConfig({
    ...common,
    auth: {
      ...config.auth,
      clientId: process.env.USC_BS_CLIENT_ID || config.auth.clientId,
      redirectUri: process.env.USC_BS_REDIRECT_URI || config.auth.redirectUri,
    },
  });
}

export async function saveConfig(config: AppConfig): Promise<void> {
  const dir = getStateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = getConfigPath();
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function configure(preferredMethod?: AuthMethod): Promise<AppConfig> {
  if (!process.stdin.isTTY) throw new Error("Interactive configuration requires a terminal.");
  const existing = await loadConfig();
  const methodText = preferredMethod ||
    (await ask("Authentication method (browser-session/oauth)", existing?.auth.method || "browser-session"));
  if (methodText !== "browser-session" && methodText !== "oauth") {
    throw new Error("Authentication method must be browser-session or oauth.");
  }
  const baseUrl = normalizeBaseUrl(await ask("Brightspace URL", existing?.baseUrl || DEFAULT_BASE_URL));
  const outputDir = normalizeOutputDir(await ask("Download directory", existing?.outputDir || DEFAULT_OUTPUT_DIR));
  const concurrencyText = await ask("Concurrent downloads", String(existing?.concurrency || 3));
  const concurrency = Math.max(1, Math.min(8, Number.parseInt(concurrencyText, 10) || 3));

  if (methodText === "browser-session") {
    const config: AppConfig = { baseUrl, outputDir, concurrency, auth: { method: methodText } };
    await saveConfig(config);
    return config;
  }

  const previousOAuth = existing?.auth.method === "oauth" ? existing.auth : null;
  const clientId = await ask("OAuth client ID", previousOAuth?.clientId);
  if (!clientId) throw new Error("OAuth client ID is required.");
  const redirectUri = normalizeRedirectUri(
    await ask("Registered redirect URI", previousOAuth?.redirectUri || DEFAULT_REDIRECT_URI),
  );
  const config: OAuthAppConfig = {
    baseUrl,
    outputDir,
    concurrency,
    auth: { method: "oauth", clientId, redirectUri },
  };
  await saveConfig(config);
  const suppliedSecret = process.env.USC_BS_CLIENT_SECRET || (await askHidden("OAuth client secret"));
  if (!suppliedSecret) throw new Error("OAuth client secret is required.");
  await keychain.setClientSecret(clientId, suppliedSecret);
  return config;
}

export async function requireConfig(preferredMethod?: AuthMethod): Promise<AppConfig> {
  return (await loadConfig()) || configure(preferredMethod);
}

export async function requireClientSecret(config: OAuthAppConfig): Promise<string> {
  const secret = process.env.USC_BS_CLIENT_SECRET || (await keychain.getClientSecret(config.auth.clientId));
  if (!secret) throw new Error("OAuth client secret is missing. Run `usc-bs configure --method oauth`.");
  return secret;
}
