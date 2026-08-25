import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { getStateDir } from "./config.js";

interface LockData {
  pid: number;
  createdAt: string;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function withAppLock<T>(work: () => Promise<T>): Promise<T> {
  const stateDir = getStateDir();
  const lockPath = path.join(stateDir, "run.lock");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() } satisfies LockData),
      );
      await handle.close();
      try {
        return await work();
      } finally {
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const data = JSON.parse(await readFile(lockPath, "utf8")) as LockData;
        const age = Date.now() - new Date(data.createdAt).getTime();
        if (!processExists(data.pid) || age > 30 * 60 * 1000) {
          await unlink(lockPath);
          continue;
        }
        throw new Error(`Another usc-bs process is running (PID ${data.pid}).`);
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        if (readError instanceof SyntaxError) {
          await unlink(lockPath);
          continue;
        }
        throw readError;
      }
    }
  }
  throw new Error("Unable to acquire application lock.");
}
