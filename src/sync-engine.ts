import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { BrightspaceApi } from "./brightspace.js";
import { BrightspaceAuthenticationError } from "./brightspace.js";
import { loadManifest, manifestKey, saveManifest } from "./manifest.js";
import {
  conflictRelativePath,
  preferredFilename,
  safeResolve,
  uniqueRelativePath,
} from "./paths.js";
import type { FileTopic, Manifest, ManifestEntry } from "./types.js";

export interface PlannedTopic {
  topic: FileTopic;
  outputDir: string;
  force: boolean;
}

export interface SyncCounts {
  downloaded: number;
  updated: number;
  skipped: number;
  conflicts: number;
  failed: number;
}

export type SyncEvent =
  | { type: "file-started"; item: PlannedTopic }
  | { type: "file-skipped"; item: PlannedTopic }
  | { type: "file-conflict"; item: PlannedTopic }
  | { type: "file-saved"; item: PlannedTopic; localPath: string; outcome: "downloaded" | "updated" }
  | { type: "file-failed"; item: PlannedTopic; error: Error };

export interface ExecuteSyncOptions {
  concurrency: number;
  signal?: AbortSignal;
  onEvent?: (event: SyncEvent) => void;
}

interface OutputState {
  outputDir: string;
  manifest: Manifest;
  reserved: Set<string>;
  saveQueue: Promise<void>;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(target: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function entryIsCurrent(
  entry: ManifestEntry | undefined,
  topic: FileTopic,
  exists: boolean,
  force: boolean,
): boolean {
  return Boolean(!force && entry && exists && entry.remoteModified === topic.remoteModified);
}

async function createOutputState(outputDir: string): Promise<OutputState> {
  await mkdir(outputDir, { recursive: true });
  const manifest = await loadManifest(outputDir);
  return {
    outputDir,
    manifest,
    reserved: new Set(
      Object.values(manifest.files).map((entry) =>
        entry.localPath.normalize("NFC").toLocaleLowerCase("en-US"),
      ),
    ),
    saveQueue: Promise.resolve(),
  };
}

function persist(state: OutputState): Promise<void> {
  state.saveQueue = state.saveQueue.then(() => saveManifest(state.outputDir, state.manifest));
  return state.saveQueue;
}

export async function executeSyncPlan(
  client: BrightspaceApi,
  leVersion: string,
  items: PlannedTopic[],
  options: ExecuteSyncOptions,
): Promise<SyncCounts> {
  const outputDirs = [...new Set(items.map((item) => path.resolve(item.outputDir)))];
  const stateEntries = await Promise.all(
    outputDirs.map(async (outputDir) => [outputDir, await createOutputState(outputDir)] as const),
  );
  const states = new Map(stateEntries);
  const counts: SyncCounts = { downloaded: 0, updated: 0, skipped: 0, conflicts: 0, failed: 0 };
  let nextIndex = 0;
  let authenticationError: BrightspaceAuthenticationError | null = null;

  const downloadOne = async (item: PlannedTopic) => {
    const outputDir = path.resolve(item.outputDir);
    const state = states.get(outputDir);
    if (!state) throw new Error(`Missing output state for ${outputDir}.`);
    const topic = item.topic;
    const key = manifestKey(topic.course.id, topic.topicId);
    const previous = state.manifest.files[key];
    const previousAbsolute = previous ? safeResolve(outputDir, previous.localPath) : null;
    const exists = previousAbsolute ? await fileExists(previousAbsolute) : false;
    if (entryIsCurrent(previous, topic, exists, item.force)) {
      counts.skipped += 1;
      options.onEvent?.({ type: "file-skipped", item });
      return;
    }

    let localWasModified = false;
    if (previous && previousAbsolute && exists) {
      const details = await stat(previousAbsolute);
      if (details.size !== previous.size || (await hashFile(previousAbsolute)) !== previous.sha256) {
        localWasModified = true;
      }
    }

    const temporary = path.join(
      outputDir,
      `.usc-bs-download-${process.pid}-${topic.topicId}-${randomUUID()}.part`,
    );
    options.onEvent?.({ type: "file-started", item });
    try {
      const response = await client.downloadFile(
        leVersion,
        topic.course.id,
        topic.topicId,
        temporary,
      );
      const remoteName = preferredFilename(
        response.contentDisposition,
        response.suggestedFilename || topic.url,
        topic.title,
        response.contentType,
      );
      let relativePath = previous?.localPath ||
        uniqueRelativePath(topic.course, topic.modulePath, remoteName, topic.topicId, state.reserved);
      if (localWasModified) {
        relativePath = conflictRelativePath(relativePath, state.reserved);
        counts.conflicts += 1;
        options.onEvent?.({ type: "file-conflict", item });
      }

      const target = safeResolve(outputDir, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await rename(temporary, target);
      state.manifest.files[key] = {
        courseId: topic.course.id,
        topicId: topic.topicId,
        title: topic.title,
        remoteModified: topic.remoteModified,
        localPath: relativePath,
        sha256: response.sha256,
        size: response.size,
        etag: response.etag,
        downloadedAt: new Date().toISOString(),
      };
      const outcome = previous ? "updated" : "downloaded";
      if (outcome === "updated") counts.updated += 1;
      else counts.downloaded += 1;
      await persist(state);
      options.onEvent?.({ type: "file-saved", item, localPath: relativePath, outcome });
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  };

  const concurrency = Math.max(1, Math.min(8, options.concurrency));
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    while (!options.signal?.aborted && !authenticationError && nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      const item = items[current];
      if (!item) continue;
      try {
        await downloadOne(item);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        options.onEvent?.({ type: "file-failed", item, error: normalized });
        if (error instanceof BrightspaceAuthenticationError) authenticationError = error;
        else counts.failed += 1;
      }
    }
  });
  await Promise.all(workers);
  await Promise.all([...states.values()].map((state) => state.saveQueue));
  if (authenticationError) throw authenticationError;
  return counts;
}
