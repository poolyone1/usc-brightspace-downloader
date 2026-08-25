import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Manifest } from "./types.js";

const MANIFEST_NAME = ".usc-bs-manifest.json";

export function manifestKey(courseId: number, topicId: number): string {
  return `${courseId}:${topicId}`;
}

export function emptyManifest(): Manifest {
  return { version: 1, updatedAt: new Date(0).toISOString(), files: {} };
}

export async function loadManifest(outputDir: string): Promise<Manifest> {
  const target = path.join(outputDir, MANIFEST_NAME);
  try {
    const value = JSON.parse(await readFile(target, "utf8")) as Partial<Manifest>;
    if (value.version !== 1 || !value.files || typeof value.files !== "object") {
      throw new Error(`Unsupported manifest format in ${target}.`);
    }
    return value as Manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyManifest();
    throw error;
  }
}

export async function saveManifest(outputDir: string, manifest: Manifest): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  manifest.updatedAt = new Date().toISOString();
  const target = path.join(outputDir, MANIFEST_NAME);
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
}
