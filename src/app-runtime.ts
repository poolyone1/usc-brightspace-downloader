import type { BrightspaceApi } from "./brightspace.js";
import { BrightspaceClient, BrightspaceHttpError } from "./brightspace.js";
import {
  BrowserSessionBrightspaceClient,
  BrowserSessionExpiredError,
  loginBrowserSession,
} from "./browser-session.js";
import { configure, loadConfig, requireConfig } from "./config.js";
import type { AuthMethod } from "./config.js";
import { createAccessTokenProvider } from "./oauth.js";
import type { AppConfig, BrowserSessionAppConfig } from "./types.js";

export function isBrowserConfig(config: AppConfig): config is BrowserSessionAppConfig {
  return config.auth.method === "browser-session";
}

export async function resolveConfig(method?: AuthMethod): Promise<AppConfig> {
  const existing = await loadConfig();
  if (existing && method && existing.auth.method !== method) return configure(method);
  return existing || requireConfig(method || "browser-session");
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
      await client.courses(versions.lp);
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

export async function useConfiguredClient<T>(
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
