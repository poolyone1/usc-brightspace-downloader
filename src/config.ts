import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AppConfig } from "./types.js";
import { ask, askHidden } from "./prompt.js";
import { keychain } from "./keychain.js";

const DEFAULT_BASE_URL = "https://brightspace.usc.edu";
const DEFAULT_REDIRECT_URI = "https://localhost:3001/oauth/callback";
const DEFAULT_OUTPUT_DIR = path.join(homedir(), "Documents", "USC Brightspace");

export function getStateDir(): string {
  return (
    process.env.USC_BS_STATE_DIR ||
    path.join(homedir(), "Library", "Application Support", "usc-bs")
  );
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

function validateConfig(value: unknown): AppConfig {
  if (!value || typeof value !== "object") throw new Error("Invalid config file.");
  const raw = value as Record<string, unknown>;
  if (typeof raw.clientId !== "string" || raw.clientId.length === 0) {
    throw new Error("Config is missing clientId.");
  }
  return {
    baseUrl: normalizeBaseUrl(String(raw.baseUrl || DEFAULT_BASE_URL)),
    clientId: raw.clientId,
    redirectUri: normalizeRedirectUri(String(raw.redirectUri || DEFAULT_REDIRECT_URI)),
    outputDir: normalizeOutputDir(String(raw.outputDir || DEFAULT_OUTPUT_DIR)),
    concurrency:
      Number.isInteger(raw.concurrency) && Number(raw.concurrency) > 0
        ? Math.min(Number(raw.concurrency), 8)
        : 3,
  };
}

export async function loadConfig(): Promise<AppConfig | null> {
  try {
    const raw = JSON.parse(await readFile(getConfigPath(), "utf8")) as unknown;
    const config = validateConfig(raw);
    return applyEnvironment(config);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function applyEnvironment(config: AppConfig): AppConfig {
  return validateConfig({
    ...config,
    clientId: process.env.USC_BS_CLIENT_ID || config.clientId,
    redirectUri: process.env.USC_BS_REDIRECT_URI || config.redirectUri,
    outputDir: process.env.USC_BS_OUTPUT || config.outputDir,
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

export async function configure(): Promise<AppConfig> {
  if (!process.stdin.isTTY) {
    throw new Error("Interactive configuration requires a terminal.");
  }

  const existing = await loadConfig();
  const baseUrl = normalizeBaseUrl(
    await ask("Brightspace URL", existing?.baseUrl || DEFAULT_BASE_URL),
  );
  const clientId = await ask("OAuth client ID", existing?.clientId);
  if (!clientId) throw new Error("OAuth client ID is required.");
  const redirectUri = normalizeRedirectUri(
    await ask("Registered redirect URI", existing?.redirectUri || DEFAULT_REDIRECT_URI),
  );
  const outputDir = normalizeOutputDir(
    await ask("Download directory", existing?.outputDir || DEFAULT_OUTPUT_DIR),
  );
  const concurrencyText = await ask("Concurrent downloads", String(existing?.concurrency || 3));
  const concurrency = Math.max(1, Math.min(8, Number.parseInt(concurrencyText, 10) || 3));

  const config: AppConfig = { baseUrl, clientId, redirectUri, outputDir, concurrency };
  await saveConfig(config);

  const suppliedSecret = process.env.USC_BS_CLIENT_SECRET || (await askHidden("OAuth client secret"));
  if (!suppliedSecret) throw new Error("OAuth client secret is required.");
  await keychain.setClientSecret(clientId, suppliedSecret);
  return config;
}

export async function requireConfig(): Promise<AppConfig> {
  return (await loadConfig()) || configure();
}

export async function requireClientSecret(config: AppConfig): Promise<string> {
  const secret =
    process.env.USC_BS_CLIENT_SECRET || (await keychain.getClientSecret(config.clientId));
  if (!secret) {
    throw new Error("OAuth client secret is missing. Run `usc-bs configure`.");
  }
  return secret;
}
