import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { getStateDir } from "../config.js";

export interface TuiProfile {
  version: 1;
  courseDestinations: Record<string, string>;
}

function profilePath(): string {
  return path.join(getStateDir(), "tui-profile.json");
}

export function normalizeDestination(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return path.resolve(value);
}

export async function loadTuiProfile(): Promise<TuiProfile> {
  try {
    const parsed = JSON.parse(await readFile(profilePath(), "utf8")) as Partial<TuiProfile>;
    if (parsed.version !== 1 || !parsed.courseDestinations) throw new Error("Invalid TUI profile.");
    return { version: 1, courseDestinations: parsed.courseDestinations };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, courseDestinations: {} };
    }
    throw error;
  }
}

export async function saveTuiProfile(profile: TuiProfile): Promise<void> {
  const dir = getStateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = profilePath();
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
}
