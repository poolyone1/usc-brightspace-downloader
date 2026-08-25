#!/usr/bin/env node

import path from "node:path";
import { configure, loadConfig, requireConfig } from "./config.js";
import { BrightspaceClient } from "./brightspace.js";
import {
  authStatus,
  createAccessTokenProvider,
  login,
  logout,
} from "./oauth.js";
import { withAppLock } from "./lock.js";
import { scan, syncAll } from "./sync.js";
import type { AppConfig, SyncOptions } from "./types.js";

interface ParsedArguments {
  command: "sync" | "configure" | "login" | "logout" | "status" | "doctor" | "help";
  sync: SyncOptions;
  outputDir?: string;
}

function usage(): void {
  console.log(`USC Brightspace file downloader (read-only proof of concept)

Usage:
  usc-bs                         Scan and sync all accessible courses
  usc-bs sync [options]          Same as the default command
  usc-bs configure               Store OAuth app settings and secret
  usc-bs login                   Complete the one-time USC OAuth login
  usc-bs status                  Show local configuration/auth status
  usc-bs doctor                  Test OAuth, enrollment and content access
  usc-bs logout                  Remove the stored refresh token

Sync options:
  -y, --yes                      Do not ask before downloading
  --dry-run                      Scan only; do not download
  --force                        Download even if metadata is unchanged
  --course <id|code|name>        Limit to a course (repeatable)
  --output <directory>           Override the configured download directory
  -h, --help                     Show this help
`);
}

function parseArguments(argv: string[]): ParsedArguments {
  let command: ParsedArguments["command"] = "sync";
  let index = 0;
  const first = argv[0];
  if (first && !first.startsWith("-")) {
    const known = ["sync", "configure", "login", "logout", "status", "doctor", "help"];
    if (!known.includes(first)) throw new Error(`Unknown command: ${first}`);
    command = first as ParsedArguments["command"];
    index = 1;
  }

  const sync: SyncOptions = {
    assumeYes: false,
    dryRun: false,
    force: false,
    courseFilters: [],
  };
  let outputDir: string | undefined;

  while (index < argv.length) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") {
      command = "help";
    } else if (argument === "-y" || argument === "--yes") {
      sync.assumeYes = true;
    } else if (argument === "--dry-run") {
      sync.dryRun = true;
    } else if (argument === "--force") {
      sync.force = true;
    } else if (argument === "--course") {
      const value = argv[index + 1];
      if (!value) throw new Error("--course requires a value.");
      sync.courseFilters.push(value);
      index += 1;
    } else if (argument === "--output") {
      const value = argv[index + 1];
      if (!value) throw new Error("--output requires a directory.");
      outputDir = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
    index += 1;
  }
  return outputDir === undefined ? { command, sync } : { command, sync, outputDir };
}

async function doctor(config: AppConfig): Promise<void> {
  const tokenProvider = await createAccessTokenProvider(config);
  const client = new BrightspaceClient(config.baseUrl, tokenProvider);
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
  console.log(
    "OAuth, enrollment and TOC access succeeded. content:file:read is exercised by the first download.",
  );
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.command === "help") {
    usage();
    return;
  }
  if (parsed.command === "configure") {
    await withAppLock(async () => {
      await configure();
      console.log("Configuration saved. Run `usc-bs login` next.");
    });
    return;
  }

  const existing = await loadConfig();
  if (parsed.command === "status") {
    if (!existing) {
      console.log("Not configured.");
      return;
    }
    console.log(`Brightspace: ${existing.baseUrl}`);
    console.log(`Client ID: ${existing.clientId}`);
    console.log(`Download directory: ${existing.outputDir}`);
    console.log(`Refresh token: ${(await authStatus(existing)) ? "stored in Keychain" : "not found"}`);
    return;
  }

  const config = await requireConfig();
  const effectiveConfig = parsed.outputDir
    ? { ...config, outputDir: parsed.outputDir }
    : config;

  await withAppLock(async () => {
    if (parsed.command === "logout") {
      await logout(config);
      console.log("Stored refresh token removed. The client secret and files were kept.");
      return;
    }
    if (parsed.command === "login") {
      const token = await login(config);
      const client = new BrightspaceClient(config.baseUrl, async () => token.access_token);
      const versions = await client.versions();
      const courses = await client.courses(versions.lp);
      console.log(`OAuth login succeeded. Found ${courses.length} accessible course offerings.`);
      if (courses[0]) {
        await client.toc(versions.le, courses[0].id);
        console.log(`TOC read succeeded for ${courses[0].code}.`);
      }
      return;
    }
    if (parsed.command === "doctor") {
      await doctor(config);
      return;
    }

    const tokenProvider = await createAccessTokenProvider(config);
    const client = new BrightspaceClient(config.baseUrl, tokenProvider);
    const versions = await client.versions();
    await syncAll(client, effectiveConfig, versions, parsed.sync);
  });
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
