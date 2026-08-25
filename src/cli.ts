#!/usr/bin/env node

import path from "node:path";
import { configure, loadConfig, requireConfig } from "./config.js";
import type { AuthMethod } from "./config.js";
import type { BrightspaceApi } from "./brightspace.js";
import { BrightspaceClient, BrightspaceHttpError } from "./brightspace.js";
import {
  BrowserSessionBrightspaceClient,
  BrowserSessionExpiredError,
  loginBrowserSession,
} from "./browser-session.js";
import { deleteBrowserSession, hasBrowserSession } from "./browser-session-store.js";
import { authStatus, createAccessTokenProvider, login, logout } from "./oauth.js";
import { withAppLock } from "./lock.js";
import { scan, syncAll } from "./sync.js";
import type { AppConfig, BrowserSessionAppConfig, SyncOptions } from "./types.js";

type Command = "sync" | "configure" | "login" | "logout" | "status" | "doctor" | "help";

interface ParsedArguments {
  command: Command;
  sync: SyncOptions;
  outputDir?: string;
  method?: AuthMethod;
}

function isBrowserConfig(config: AppConfig): config is BrowserSessionAppConfig {
  return config.auth.method === "browser-session";
}

function usage(): void {
  console.log(`USC Brightspace file downloader (read-only proof of concept)

Usage:
  usc-bs                              Scan and sync all accessible courses
  usc-bs sync [options]               Same as the default command
  usc-bs configure [--method METHOD]  Configure browser-session (default) or OAuth
  usc-bs auth login                   One-time manual USC NetID + Duo login
  usc-bs auth status                  Show local configuration/auth status
  usc-bs doctor                       Test enrollment and content access
  usc-bs auth logout                  Remove the stored session

The shorter login/status/logout commands are also accepted.

Options:
  --method browser-session|oauth      Select authentication method
  -y, --yes                           Do not ask before downloading
  --dry-run                           Scan only; do not download
  --force                             Download even if metadata is unchanged
  --course <id|code|name>             Limit to a course (repeatable)
  --output <directory>                Override the download directory
  -h, --help                          Show this help
`);
}

function parseMethod(value: string): AuthMethod {
  if (value === "browser") return "browser-session";
  if (value === "browser-session" || value === "oauth") return value;
  throw new Error("--method must be browser-session (or browser) or oauth.");
}

function parseArguments(argv: string[]): ParsedArguments {
  let command: Command = "sync";
  let index = 0;
  const first = argv[0];
  if (first === "auth") {
    const authCommand = argv[1];
    if (!authCommand || !["login", "logout", "status"].includes(authCommand)) {
      throw new Error("`usc-bs auth` requires login, status, or logout.");
    }
    command = authCommand as Command;
    index = 2;
  } else if (first && !first.startsWith("-")) {
    const known = ["sync", "configure", "login", "logout", "status", "doctor", "help"];
    if (!known.includes(first)) throw new Error(`Unknown command: ${first}`);
    command = first as Command;
    index = 1;
  }

  const sync: SyncOptions = { assumeYes: false, dryRun: false, force: false, courseFilters: [] };
  let outputDir: string | undefined;
  let method: AuthMethod | undefined;
  while (index < argv.length) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") command = "help";
    else if (argument === "-y" || argument === "--yes") sync.assumeYes = true;
    else if (argument === "--dry-run") sync.dryRun = true;
    else if (argument === "--force") sync.force = true;
    else if (argument === "--course") {
      const value = argv[index + 1];
      if (!value) throw new Error("--course requires a value.");
      sync.courseFilters.push(value);
      index += 1;
    } else if (argument === "--output") {
      const value = argv[index + 1];
      if (!value) throw new Error("--output requires a directory.");
      outputDir = path.resolve(value);
      index += 1;
    } else if (argument === "--method") {
      const value = argv[index + 1];
      if (!value) throw new Error("--method requires a value.");
      method = parseMethod(value);
      index += 1;
    } else throw new Error(`Unknown option: ${argument}`);
    index += 1;
  }
  return {
    command,
    sync,
    ...(outputDir === undefined ? {} : { outputDir }),
    ...(method === undefined ? {} : { method }),
  };
}

async function resolveConfig(method?: AuthMethod): Promise<AppConfig> {
  const existing = await loadConfig();
  if (existing && method && existing.auth.method !== method) return configure(method);
  return existing || requireConfig(method || "browser-session");
}

async function doctor(client: BrightspaceApi, config: AppConfig): Promise<void> {
  const versions = await client.versions();
  console.log(`API versions: LP ${versions.lp}, LE ${versions.le}`);
  const result = await scan(
    client,
    versions,
    { assumeYes: true, dryRun: true, force: false, courseFilters: [] },
    config.concurrency,
  );
  console.log(`Enrollment access: ${result.courses.length} accessible course offerings`);
  console.log(`Content access: ${result.topics.length} visible file topics`);
  for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
  console.log("Authentication, enrollment and TOC access succeeded. A sync exercises file downloads.");
}

function browserAuthFailure(error: unknown): boolean {
  return error instanceof BrowserSessionExpiredError ||
    (error instanceof BrightspaceHttpError && [401, 403].includes(error.status)) ||
    /browser session (is missing|key is missing|could not be decrypted)/i.test((error as Error).message);
}

async function useBrowserClient<T>(
  config: BrowserSessionAppConfig,
  action: (client: BrowserSessionBrightspaceClient) => Promise<T>,
): Promise<T> {
  let retried = false;
  while (true) {
    let client: BrowserSessionBrightspaceClient | null = null;
    try {
      client = await BrowserSessionBrightspaceClient.create(config);
      const versions = await client.versions();
      await client.courses(versions.lp); // Explicitly validate restored authentication.
      return await action(client);
    } catch (error) {
      if (retried || !process.stdin.isTTY || !browserAuthFailure(error)) throw error;
      retried = true;
      console.warn("Saved Brightspace session is missing or expired; manual login is required.");
      await loginBrowserSession(config);
    } finally {
      await client?.close().catch(() => undefined);
    }
  }
}

async function useConfiguredClient<T>(
  config: AppConfig,
  action: (client: BrightspaceApi) => Promise<T>,
): Promise<T> {
  if (isBrowserConfig(config)) return useBrowserClient(config, action);
  const tokenProvider = await createAccessTokenProvider(config);
  const client = new BrightspaceClient(config.baseUrl, tokenProvider);
  try {
    return await action(client);
  } finally {
    await client.close();
  }
}

async function showStatus(config: AppConfig): Promise<void> {
  console.log(`Brightspace: ${config.baseUrl}`);
  console.log(`Authentication: ${config.auth.method}`);
  console.log(`Download directory: ${config.outputDir}`);
  if (isBrowserConfig(config)) {
    console.log(`Encrypted browser session: ${(await hasBrowserSession()) ? "stored" : "not found"}`);
  } else {
    console.log(`OAuth client ID: ${config.auth.clientId}`);
    console.log(`Refresh token: ${(await authStatus(config)) ? "stored in Keychain" : "not found"}`);
  }
}

async function explicitLogin(config: AppConfig): Promise<void> {
  if (isBrowserConfig(config)) {
    await loginBrowserSession(config);
    await useBrowserClient(config, async (client) => {
      const versions = await client.versions();
      const courses = await client.courses(versions.lp);
      console.log(`Browser-session login succeeded. Found ${courses.length} accessible course offerings.`);
      if (courses[0]) {
        await client.toc(versions.le, courses[0].id);
        console.log(`TOC read succeeded for ${courses[0].code}.`);
      }
    });
    return;
  }
  const token = await login(config);
  const client = new BrightspaceClient(config.baseUrl, async () => token.access_token);
  const versions = await client.versions();
  const courses = await client.courses(versions.lp);
  console.log(`OAuth login succeeded. Found ${courses.length} accessible course offerings.`);
}

async function explicitLogout(config: AppConfig): Promise<void> {
  if (isBrowserConfig(config)) {
    await deleteBrowserSession(config.baseUrl);
    console.log("Encrypted browser session and its Keychain key were removed. Downloaded files were kept.");
  } else {
    await logout(config);
    console.log("Stored refresh token removed. The client secret and downloaded files were kept.");
  }
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.command === "help") return usage();
  if (parsed.command === "configure") {
    await withAppLock(async () => {
      const config = await configure(parsed.method);
      console.log(`Configuration saved for ${config.auth.method}. Run \`usc-bs auth login\` next.`);
    });
    return;
  }

  const existing = await loadConfig();
  if (parsed.command === "status" && !existing) {
    console.log("Not configured.");
    return;
  }
  const config = await resolveConfig(parsed.method);
  if (parsed.command === "status") return showStatus(config);
  const effectiveConfig: AppConfig = parsed.outputDir ? { ...config, outputDir: parsed.outputDir } : config;

  await withAppLock(async () => {
    if (parsed.command === "logout") return explicitLogout(config);
    if (parsed.command === "login") return explicitLogin(config);
    if (parsed.command === "doctor") {
      await useConfiguredClient(config, (client) => doctor(client, config));
      return;
    }
    await useConfiguredClient(config, async (client) => {
      const versions = await client.versions();
      await syncAll(client, effectiveConfig, versions, parsed.sync);
    });
  });
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
