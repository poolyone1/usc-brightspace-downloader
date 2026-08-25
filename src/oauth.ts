import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:https";
import path from "node:path";
import { spawn } from "node:child_process";
import type { OAuthAppConfig, OAuthTokenResponse } from "./types.js";
import { REQUIRED_SCOPES } from "./types.js";
import { getStateDir, requireClientSecret } from "./config.js";
import { keychain } from "./keychain.js";

const AUTHORIZE_ENDPOINT = "https://auth.brightspace.com/oauth2/auth";
const TOKEN_ENDPOINT = "https://auth.brightspace.com/core/connect/token";

class OAuthError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function generateCertificate(certPath: string, keyPath: string): Promise<void> {
  await mkdir(path.dirname(certPath), { recursive: true, mode: 0o700 });
  const openssl = process.env.OPENSSL_PATH || "openssl";
  const args = [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "3650",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(openssl, args, { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (error += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Unable to generate localhost certificate: ${error.trim()}`));
    });
  });
  await chmod(certPath, 0o600);
  await chmod(keyPath, 0o600);
}

async function localCertificate(): Promise<{ cert: Buffer; key: Buffer }> {
  const tlsDir = path.join(getStateDir(), "tls");
  const certPath = path.join(tlsDir, "localhost.crt");
  const keyPath = path.join(tlsDir, "localhost.key");
  try {
    await Promise.all([access(certPath), access(keyPath)]);
  } catch {
    await generateCertificate(certPath, keyPath);
  }
  return { cert: await readFile(certPath), key: await readFile(keyPath) };
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "/usr/bin/open" : "xdg-open";
  const child = spawn(command, [url], { detached: true, stdio: "ignore" });
  child.unref();
}

async function receiveAuthorizationCode(config: OAuthAppConfig, state: string): Promise<string> {
  const redirect = new URL(config.auth.redirectUri);
  const certificate = await localCertificate();

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, code?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (error) reject(error);
      else if (code) resolve(code);
      else reject(new Error("OAuth callback did not contain an authorization code."));
    };

    const server = createServer(certificate, (request, response) => {
      const requestUrl = new URL(request.url || "/", config.auth.redirectUri);
      if (requestUrl.pathname !== redirect.pathname) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }

      const returnedState = requestUrl.searchParams.get("state");
      const code = requestUrl.searchParams.get("code");
      const oauthError = requestUrl.searchParams.get("error");
      const oauthDescription = requestUrl.searchParams.get("error_description");

      if (returnedState !== state) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Invalid OAuth state. You may close this tab.");
        finish(new Error("OAuth state mismatch; login was rejected."));
        return;
      }
      if (oauthError) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Brightspace authorization was not granted. You may close this tab.");
        finish(new OAuthError(oauthDescription || oauthError, oauthError));
        return;
      }
      if (!code) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing authorization code. You may close this tab.");
        finish(new Error("OAuth callback is missing the authorization code."));
        return;
      }

      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><meta charset=utf-8><title>USC Brightspace</title>" +
          "<h1>Authorization complete</h1><p>You can close this tab and return to the terminal.</p>",
      );
      finish(undefined, code);
    });

    server.on("error", (error) => finish(error));
    const timer = setTimeout(
      () => finish(new Error("OAuth login timed out after 10 minutes.")),
      10 * 60 * 1000,
    );
    timer.unref();

    server.listen(Number(redirect.port), redirect.hostname, () => {
      const authorizeUrl = new URL(AUTHORIZE_ENDPOINT);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("redirect_uri", config.auth.redirectUri);
      authorizeUrl.searchParams.set("client_id", config.auth.clientId);
      authorizeUrl.searchParams.set("scope", REQUIRED_SCOPES.join(" "));
      authorizeUrl.searchParams.set("state", state);
      console.log("Opening the USC login page in your browser…");
      console.log("The localhost certificate is self-signed; the browser may ask you to continue once.");
      openBrowser(authorizeUrl.toString());
    });
  });
}

function validateTokenResponse(value: unknown): OAuthTokenResponse {
  if (!value || typeof value !== "object") throw new Error("Invalid OAuth token response.");
  const token = value as Partial<OAuthTokenResponse>;
  if (
    typeof token.access_token !== "string" ||
    typeof token.token_type !== "string" ||
    typeof token.expires_in !== "number"
  ) {
    throw new Error("OAuth token response is missing required fields.");
  }
  if (token.scope) {
    const granted = new Set(token.scope.split(/\s+/).filter(Boolean));
    const missing = REQUIRED_SCOPES.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      throw new Error(`OAuth token is missing required scopes: ${missing.join(", ")}`);
    }
  }
  return token as OAuthTokenResponse;
}

async function requestToken(
  config: OAuthAppConfig,
  form: URLSearchParams,
): Promise<OAuthTokenResponse> {
  const clientSecret = await requireClientSecret(config);
  const basic = Buffer.from(`${config.auth.clientId}:${clientSecret}`, "utf8").toString("base64");
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: form,
  });

  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const errorBody = body as { error?: string; error_description?: string } | null;
    throw new OAuthError(
      errorBody?.error_description || `OAuth token request failed (${response.status}).`,
      errorBody?.error,
    );
  }
  return validateTokenResponse(body);
}

async function saveRotatedRefreshToken(
  config: OAuthAppConfig,
  token: OAuthTokenResponse,
): Promise<void> {
  if (!token.refresh_token) {
    throw new Error(
      "Brightspace did not return a refresh token. Confirm that the OAuth app has refresh tokens enabled.",
    );
  }
  await keychain.setRefreshToken(config.baseUrl, config.auth.clientId, token.refresh_token);
}

export async function login(config: OAuthAppConfig): Promise<OAuthTokenResponse> {
  const state = randomBytes(32).toString("base64url");
  const code = await receiveAuthorizationCode(config, state);
  const token = await requestToken(
    config,
    new URLSearchParams({
      grant_type: "authorization_code",
      redirect_uri: config.auth.redirectUri,
      code,
    }),
  );
  await saveRotatedRefreshToken(config, token);
  return token;
}

export async function refresh(config: OAuthAppConfig): Promise<OAuthTokenResponse> {
  const refreshToken = await keychain.getRefreshToken(config.baseUrl, config.auth.clientId);
  if (!refreshToken) throw new OAuthError("No refresh token is stored.", "missing_refresh_token");
  const token = await requestToken(
    config,
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  );
  await saveRotatedRefreshToken(config, token);
  return token;
}

export async function getAccessToken(config: OAuthAppConfig): Promise<OAuthTokenResponse> {
  try {
    return await refresh(config);
  } catch (error) {
    if (
      error instanceof OAuthError &&
      (error.code === "invalid_grant" || error.code === "missing_refresh_token") &&
      process.stdin.isTTY
    ) {
      console.log("A fresh Brightspace authorization is required.");
      return login(config);
    }
    throw error;
  }
}

export async function createAccessTokenProvider(
  config: OAuthAppConfig,
): Promise<() => Promise<string>> {
  let token = await getAccessToken(config);
  let expiresAt = Date.now() + token.expires_in * 1000;
  let pendingRefresh: Promise<void> | null = null;

  return async () => {
    if (Date.now() < expiresAt - 60_000) return token.access_token;
    pendingRefresh ??= refresh(config)
      .then((next) => {
        token = next;
        expiresAt = Date.now() + next.expires_in * 1000;
      })
      .finally(() => {
        pendingRefresh = null;
      });
    await pendingRefresh;
    return token.access_token;
  };
}

export async function authStatus(config: OAuthAppConfig): Promise<boolean> {
  return Boolean(await keychain.getRefreshToken(config.baseUrl, config.auth.clientId));
}

export async function logout(config: OAuthAppConfig): Promise<void> {
  await keychain.deleteRefreshToken(config.baseUrl, config.auth.clientId);
}
