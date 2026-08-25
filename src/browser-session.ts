import { access, chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { APIResponse, Browser, BrowserContext } from "playwright";
import { chromium } from "playwright";
import {
  BrightspaceApi,
  BrightspaceAuthenticationError,
  BrightspaceHttpError,
} from "./brightspace.js";
import type { DownloadedFile } from "./brightspace.js";
import { streamToFile } from "./download.js";
import type { BrowserSessionAppConfig, ProductVersions } from "./types.js";
import { loadBrowserSession, saveBrowserSession } from "./browser-session-store.js";
import { getStateDir } from "./config.js";

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const PASSWORD_SAVE_GRACE_MS = 15_000;

export function getChromeLoginProfileDir(): string {
  return path.join(getStateDir(), "chrome-login-profile");
}

export async function hasChromeLoginProfile(): Promise<boolean> {
  try {
    await access(getChromeLoginProfileDir());
    return true;
  } catch {
    return false;
  }
}

export async function deleteChromeLoginProfile(): Promise<void> {
  await rm(getChromeLoginProfileDir(), { recursive: true, force: true });
}

export class BrowserSessionExpiredError extends BrightspaceAuthenticationError {
  constructor(message = "The saved Brightspace browser session has expired. Run `usc-bs auth login`.") {
    super(message);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function contentType(response: APIResponse): string {
  return response.headers()["content-type"] || "";
}

async function apiJson<T>(
  context: BrowserContext,
  baseUrl: string,
  pathname: string,
  authenticated: boolean,
): Promise<T> {
  const url = new URL(pathname, baseUrl);
  if (url.origin !== new URL(baseUrl).origin) throw new Error("Invalid Brightspace API URL.");
  const response = await context.request.get(url.toString(), {
    failOnStatusCode: false,
    maxRedirects: 0,
    headers: { accept: "application/json" },
  });
  if ([301, 302, 303, 307, 308, 401].includes(response.status())) {
    throw new BrowserSessionExpiredError();
  }
  if (!response.ok()) {
    throw new BrightspaceHttpError(response.status(), `Brightspace request failed (${response.status()}).`);
  }
  if (!contentType(response).toLowerCase().includes("json")) {
    if (authenticated) throw new BrowserSessionExpiredError("Brightspace returned a login page instead of JSON.");
    throw new Error(`Expected Brightspace JSON, received ${contentType(response) || "unknown content"}.`);
  }
  return await response.json() as T;
}

async function browserSessionIsReady(context: BrowserContext, baseUrl: string): Promise<boolean> {
  try {
    const products = await apiJson<ProductVersions[]>(context, baseUrl, "/d2l/api/versions/", false);
    const lp = products.find((product) => product.ProductCode.toLowerCase() === "lp")?.LatestVersion;
    if (!lp) return false;
    const path = `/d2l/api/lp/${encodeURIComponent(lp)}/enrollments/myenrollments/?isActive=true&canAccess=true`;
    await apiJson<unknown>(context, baseUrl, path, true);
    return true;
  } catch (error) {
    if (error instanceof BrowserSessionExpiredError || error instanceof BrightspaceHttpError) return false;
    return false;
  }
}

interface LoginEnvironment {
  context: BrowserContext;
  browser: Browser | null;
  persistent: boolean;
  close: () => Promise<void>;
}

async function launchLoginEnvironment(config: BrowserSessionAppConfig): Promise<LoginEnvironment> {
  if (config.auth.loginProfile === "persistent-chrome") {
    const profileDir = getChromeLoginProfileDir();
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await chmod(profileDir, 0o700);
    try {
      const context = await chromium.launchPersistentContext(profileDir, {
        channel: "chrome",
        headless: false,
        acceptDownloads: true,
        viewport: null,
        // Chrome suppresses password-save UI under Playwright's automation flag. The other
        // two defaults bypass the native password store/keychain, so omit all three only for
        // this dedicated, opt-in login profile.
        ignoreDefaultArgs: [
          "--enable-automation",
          "--password-store=basic",
          "--use-mock-keychain",
        ],
      });
      return {
        context,
        browser: context.browser(),
        persistent: true,
        close: () => context.close(),
      };
    } catch (error) {
      throw new Error(
        "Unable to start the dedicated Google Chrome login profile. Install Google Chrome or run `usc-bs auth forget-password` to return to the temporary browser.",
        { cause: error },
      );
    }
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ acceptDownloads: true });
  return { context, browser, persistent: false, close: () => browser.close() };
}

function recordOrigin(origins: Set<string>, value: string): void {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") origins.add(url.origin);
  } catch {
    // Browser-internal and incomplete navigation URLs have no site storage to clear.
  }
}

function trackVisitedOrigins(context: BrowserContext, origins: Set<string>): void {
  const attach = (page: import("playwright").Page) => {
    for (const frame of page.frames()) recordOrigin(origins, frame.url());
    page.on("framenavigated", (frame) => recordOrigin(origins, frame.url()));
  };
  for (const page of context.pages()) attach(page);
  context.on("page", attach);
}

async function clearPersistentWebsiteState(
  context: BrowserContext,
  origins: Set<string>,
): Promise<void> {
  await context.clearCookies();
  const page = context.pages()[0];
  if (!page) return;
  const session = await context.newCDPSession(page);
  try {
    for (const origin of origins) {
      await session.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
    }
  } finally {
    await session.detach();
  }
}

export async function loginBrowserSession(config: BrowserSessionAppConfig): Promise<void> {
  const environment = await launchLoginEnvironment(config);
  const { browser, context } = environment;
  const page = context.pages()[0] || await context.newPage();
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  const visitedOrigins = new Set<string>();
  let disconnected = false;
  context.on("close", () => (disconnected = true));
  browser?.on("disconnected", () => (disconnected = true));
  trackVisitedOrigins(context, visitedOrigins);
  if (environment.persistent) {
    console.log("A dedicated Google Chrome profile has opened. Complete USC NetID and Duo there.");
    console.log("Chrome may offer to save the password. Click Save, then leave the window open;");
    console.log("after login is verified the tool will wait briefly, clear website sessions, and close it.");
    console.log("Do not sign this dedicated profile into a Google account.");
  } else {
    console.log("A private Chromium window has opened. Complete USC NetID and Duo there.");
  }
  console.log("The CLI never reads or stores your password or Duo response.");

  try {
    await page.goto(new URL("/d2l/login", config.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    while (Date.now() < deadline) {
      if (disconnected || context.pages().length === 0) {
        throw new Error("Login window was closed before Brightspace authentication completed.");
      }
      if (await browserSessionIsReady(context, config.baseUrl)) {
        const state = await context.storageState();
        await saveBrowserSession(state, config.baseUrl);
        console.log("Brightspace session verified and encrypted locally.");
        if (environment.persistent) {
          console.log("If Chrome shows Save password, click it now. Closing automatically in 15 seconds…");
          await sleep(PASSWORD_SAVE_GRACE_MS);
          if (!disconnected) {
            for (const entry of state.origins) recordOrigin(visitedOrigins, entry.origin);
            await clearPersistentWebsiteState(context, visitedOrigins);
            console.log("Website cookies and site storage were cleared from the Chrome login profile.");
          } else {
            console.warn("Chrome was closed early, so its website session data could not be cleared.");
          }
        }
        return;
      }
      await sleep(2_000);
    }
    throw new Error("Browser login timed out after 10 minutes.");
  } finally {
    if (!disconnected) await environment.close();
  }
}

type DownloadMode = "unknown" | "browser" | "cookie";

export class BrowserSessionBrightspaceClient extends BrightspaceApi {
  private downloadMode: DownloadMode = "unknown";

  private constructor(
    baseUrl: string,
    private readonly browser: Browser,
    private readonly context: BrowserContext,
  ) {
    super(baseUrl);
  }

  static async create(config: BrowserSessionAppConfig): Promise<BrowserSessionBrightspaceClient> {
    const state = await loadBrowserSession(config.baseUrl);
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ storageState: state, acceptDownloads: true });
      return new BrowserSessionBrightspaceClient(config.baseUrl, browser, context);
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  async json<T>(pathname: string, authenticated = true): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await apiJson<T>(this.context, this.baseUrl.origin, pathname, authenticated);
      } catch (error) {
        if (error instanceof BrowserSessionExpiredError) throw error;
        lastError = error;
        const status = error instanceof BrightspaceHttpError ? error.status : 0;
        if (attempt === 4 || (status !== 429 && status < 500)) throw error;
        await sleep(Math.min(1000 * 2 ** attempt, 15_000));
      }
    }
    throw lastError;
  }

  private fileUrl(leVersion: string, courseId: number, topicId: number): URL {
    return this.apiUrl(
      `/d2l/api/le/${encodeURIComponent(leVersion)}/${courseId}/content/topics/${topicId}/file`,
    );
  }

  private async browserDownload(url: URL, target: string): Promise<DownloadedFile> {
    const page = await this.context.newPage();
    try {
      const pending = page.waitForEvent("download", { timeout: 4_000 });
      await page.goto(url.toString(), { waitUntil: "commit", timeout: 15_000 }).catch(() => undefined);
      const download = await pending;
      const failure = await download.failure();
      if (failure) throw new Error(`Browser download failed: ${failure}`);
      const source = await download.createReadStream();
      const streamed = await streamToFile(source, target);
      return {
        ...streamed,
        suggestedFilename: download.suggestedFilename(),
        contentDisposition: null,
        contentType: null,
        etag: null,
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async cookieDownload(url: URL, target: string): Promise<DownloadedFile> {
    let current = new URL(url);
    let includeCookies = true;
    for (let redirectCount = 0; redirectCount < 6; redirectCount += 1) {
      const cookies = includeCookies ? await this.context.cookies(current.toString()) : [];
      const headers = new Headers({ accept: "*/*", "user-agent": "usc-bs/0.1" });
      if (cookies.length > 0) {
        headers.set("cookie", cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "));
      }
      let response: Response | null = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        response = await fetch(current, { method: "GET", headers, redirect: "manual" });
        if (response.status !== 429 && response.status < 500) break;
        if (attempt === 4) break;
        await sleep(Math.min(1000 * 2 ** attempt, 15_000));
      }
      if (!response) throw new Error("Brightspace file request did not return a response.");
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Brightspace redirect did not include a location.");
        const next = new URL(location, current);
        if (next.protocol !== "https:") throw new Error("Refusing a non-HTTPS file redirect.");
        includeCookies = next.origin === this.baseUrl.origin;
        current = next;
        continue;
      }
      if ([401, 403].includes(response.status)) throw new BrowserSessionExpiredError();
      if (!response.ok) throw new BrightspaceHttpError(response.status, `File download failed (${response.status}).`);
      if (!response.body) throw new Error("File response did not contain a body.");
      const length = Number.parseInt(response.headers.get("content-length") || "", 10);
      const streamed = await streamToFile(
        response.body as unknown as AsyncIterable<Uint8Array>,
        target,
        Number.isFinite(length) ? length : undefined,
      );
      return {
        ...streamed,
        suggestedFilename: null,
        contentDisposition: response.headers.get("content-disposition"),
        contentType: response.headers.get("content-type"),
        etag: response.headers.get("etag"),
      };
    }
    throw new Error("Too many redirects from the Brightspace file endpoint.");
  }

  async downloadFile(
    leVersion: string,
    courseId: number,
    topicId: number,
    targetPartPath: string,
  ): Promise<DownloadedFile> {
    const url = this.fileUrl(leVersion, courseId, topicId);
    if (this.downloadMode !== "cookie") {
      try {
        const result = await this.browserDownload(url, targetPartPath);
        this.downloadMode = "browser";
        return result;
      } catch (error) {
        if (this.downloadMode === "browser") throw error;
        this.downloadMode = "cookie";
      }
    }
    return this.cookieDownload(url, targetPartPath);
  }
}
