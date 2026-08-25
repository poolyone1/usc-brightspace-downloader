import { spawn } from "node:child_process";

const SECURITY = "/usr/bin/security";
const CLIENT_SECRET_SERVICE = "usc-bs.client-secret";
const REFRESH_TOKEN_SERVICE = "usc-bs.refresh-token";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runSecurity(args: string[]): Promise<CommandResult> {
  if (process.platform !== "darwin") {
    throw new Error("This proof of concept currently requires macOS Keychain.");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(SECURITY, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let error = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.stderr.on("data", (chunk: string) => (error += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: out, stderr: error }));
  });
}

async function getPassword(service: string, account: string): Promise<string | null> {
  const result = await runSecurity([
    "find-generic-password",
    "-s",
    service,
    "-a",
    account,
    "-w",
  ]);
  if (result.code !== 0) return null;
  return result.stdout.replace(/[\r\n]+$/, "");
}

async function setPassword(service: string, account: string, value: string): Promise<void> {
  const result = await runSecurity([
    "add-generic-password",
    "-U",
    "-s",
    service,
    "-a",
    account,
    "-w",
    value,
  ]);
  if (result.code !== 0) {
    throw new Error(`Unable to update macOS Keychain: ${result.stderr.trim() || "unknown error"}`);
  }
}

async function deletePassword(service: string, account: string): Promise<void> {
  await runSecurity(["delete-generic-password", "-s", service, "-a", account]);
}

export function refreshTokenAccount(baseUrl: string, clientId: string): string {
  return `${new URL(baseUrl).origin}|${clientId}`;
}

export const keychain = {
  getClientSecret: (clientId: string) => getPassword(CLIENT_SECRET_SERVICE, clientId),
  setClientSecret: (clientId: string, value: string) =>
    setPassword(CLIENT_SECRET_SERVICE, clientId, value),
  deleteClientSecret: (clientId: string) => deletePassword(CLIENT_SECRET_SERVICE, clientId),
  getRefreshToken: (baseUrl: string, clientId: string) =>
    getPassword(REFRESH_TOKEN_SERVICE, refreshTokenAccount(baseUrl, clientId)),
  setRefreshToken: (baseUrl: string, clientId: string, value: string) =>
    setPassword(REFRESH_TOKEN_SERVICE, refreshTokenAccount(baseUrl, clientId), value),
  deleteRefreshToken: (baseUrl: string, clientId: string) =>
    deletePassword(REFRESH_TOKEN_SERVICE, refreshTokenAccount(baseUrl, clientId)),
};
