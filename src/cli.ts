#!/usr/bin/env node

import path from "node:path";
import { configure, loadConfig, saveConfig } from "./config.js";
import type { AuthMethod } from "./config.js";
import type { BrightspaceApi } from "./brightspace.js";
import { BrightspaceClient } from "./brightspace.js";
import {
  deleteChromeLoginProfile,
  hasChromeLoginProfile,
  loginBrowserSession,
} from "./browser-session.js";
import { deleteBrowserSession, hasBrowserSession } from "./browser-session-store.js";
import { isBrowserConfig, resolveConfig, useConfiguredClient } from "./app-runtime.js";
import { authStatus, login, logout } from "./oauth.js";
import { withAppLock } from "./lock.js";
import { scan, syncAll } from "./sync.js";
import type { AppConfig, SyncOptions } from "./types.js";

type Command =
  | "sync"
  | "tui"
  | "configure"
  | "login"
  | "logout"
  | "forget-password"
  | "status"
  | "doctor"
  | "help";

interface ParsedArguments {
  command: Command;
  sync: SyncOptions;
  outputDir?: string;
  method?: AuthMethod;
  rememberPassword: boolean;
}

function usage(): void {
  console.log(`USC Brightspace file downloader (read-only proof of concept)

Usage:
  usc-bs                              Scan and sync all accessible courses
  usc-bs sync [options]               Same as the default command
  usc-bs tui                          Open the multi-level course/file manager
  usc-bs configure [--method METHOD]  Configure browser-session (default) or OAuth
  usc-bs auth login                   Manual USC NetID + Duo login
  usc-bs auth login --remember-password
                                      Use a dedicated Chrome profile for autofill
  usc-bs auth forget-password         Delete the dedicated Chrome password profile
  usc-bs auth status                  Show local configuration/auth status
  usc-bs doctor                       Test enrollment and content access
  usc-bs auth logout                  Remove the stored session

The shorter login/status/logout commands are also accepted.

Options:
  --method browser-session|oauth      Select authentication method
  --remember-password                 Let dedicated Chrome save/autofill the password
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
    if (!authCommand || !["login", "logout", "forget-password", "status"].includes(authCommand)) {
      throw new Error("`usc-bs auth` requires login, logout, forget-password, or status.");
    }
    command = authCommand as Command;
    index = 2;
  } else if (first && !first.startsWith("-")) {
    const known = [
      "sync", "tui", "configure", "login", "logout", "forget-password", "status", "doctor", "help",
    ];
    if (!known.includes(first)) throw new Error(`Unknown command: ${first}`);
    command = first as Command;
    index = 1;
  }

  const sync: SyncOptions = { assumeYes: false, dryRun: false, force: false, courseFilters: [] };
  let outputDir: string | undefined;
  let method: AuthMethod | undefined;
  let rememberPassword = false;
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
    } else if (argument === "--remember-password") {
      rememberPassword = true;
    } else throw new Error(`Unknown option: ${argument}`);
    index += 1;
  }
  return {
    command,
    sync,
    rememberPassword,
    ...(outputDir === undefined ? {} : { outputDir }),
    ...(method === undefined ? {} : { method }),
  };
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

async function showStatus(config: AppConfig): Promise<void> {
  console.log(`Brightspace: ${config.baseUrl}`);
  console.log(`Authentication: ${config.auth.method}`);
  console.log(`Download directory: ${config.outputDir}`);
  if (isBrowserConfig(config)) {
    console.log(`Encrypted browser session: ${(await hasBrowserSession()) ? "stored" : "not found"}`);
    if (config.auth.loginProfile === "persistent-chrome") {
      console.log(
        `Password autofill: enabled (${(await hasChromeLoginProfile()) ? "Chrome profile stored" : "profile not created"})`,
      );
    } else {
      console.log("Password autofill: disabled");
    }
  } else {
    console.log(`OAuth client ID: ${config.auth.clientId}`);
    console.log(`Refresh token: ${(await authStatus(config)) ? "stored in Keychain" : "not found"}`);
  }
}

async function explicitLogin(config: AppConfig, rememberPassword: boolean): Promise<void> {
  if (isBrowserConfig(config)) {
    const loginConfig = rememberPassword
      ? { ...config, auth: { method: "browser-session" as const, loginProfile: "persistent-chrome" as const } }
      : config;
    if (rememberPassword) {
      await saveConfig(loginConfig);
      console.log("Password autofill enabled with a dedicated local Chrome profile.");
    }
    await loginBrowserSession(loginConfig);
    await useConfiguredClient(loginConfig, async (client) => {
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
  if (rememberPassword) throw new Error("--remember-password is available only with browser-session authentication.");
  const token = await login(config);
  const client = new BrightspaceClient(config.baseUrl, async () => token.access_token);
  const versions = await client.versions();
  const courses = await client.courses(versions.lp);
  console.log(`OAuth login succeeded. Found ${courses.length} accessible course offerings.`);
}

async function forgetPassword(config: AppConfig): Promise<void> {
  if (!isBrowserConfig(config)) {
    throw new Error("No browser-session password profile is configured.");
  }
  await deleteChromeLoginProfile();
  await saveConfig({ ...config, auth: { method: "browser-session" } });
  console.log("Dedicated Chrome login profile and its saved password data were removed.");
  console.log("The encrypted Brightspace session and downloaded files were kept.");
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
  if (parsed.rememberPassword && parsed.command !== "login") {
    throw new Error("--remember-password can be used only with `usc-bs auth login`.");
  }
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
    if (parsed.command === "forget-password") return forgetPassword(config);
    if (parsed.command === "login") return explicitLogin(config, parsed.rememberPassword);
    if (parsed.command === "doctor") {
      await useConfiguredClient(config, (client) => doctor(client, config));
      return;
    }
    if (parsed.command === "tui") {
      await useConfiguredClient(config, async (client) => {
        const { runTui } = await import("./tui/run.js");
        await runTui(client, effectiveConfig);
      });
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
