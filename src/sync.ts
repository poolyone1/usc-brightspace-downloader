import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { BrightspaceApi } from "./brightspace.js";
import { BrightspaceAuthenticationError, BrightspaceHttpError } from "./brightspace.js";
import { confirm } from "./prompt.js";
import {
  conflictRelativePath,
  preferredFilename,
  safeResolve,
  uniqueRelativePath,
} from "./paths.js";
import { loadManifest, manifestKey, saveManifest } from "./manifest.js";
import type {
  AppConfig,
  Course,
  FileTopic,
  Manifest,
  ManifestEntry,
  SyncOptions,
  TocModule,
} from "./types.js";

interface ScanResult {
  courses: Course[];
  topics: FileTopic[];
  warnings: string[];
}

interface SyncCounts {
  downloaded: number;
  updated: number;
  skipped: number;
  conflicts: number;
  failed: number;
}

function matchesCourse(course: Course, filters: string[]): boolean {
  if (filters.length === 0) return true;
  const fields = [String(course.id), course.code, course.name].map((value) => value.toLowerCase());
  return filters.some((filter) => fields.some((field) => field.includes(filter.toLowerCase())));
}

export function collectFileTopics(course: Course, modules: TocModule[]): FileTopic[] {
  const result: FileTopic[] = [];

  const visit = (module: TocModule, parents: string[]) => {
    if (module.IsHidden || module.IsLocked) return;
    const modulePath = [...parents, module.Title];
    for (const topic of [...(module.Topics || [])].sort((a, b) => a.SortOrder - b.SortOrder)) {
      if (
        topic.ActivityType !== 1 ||
        topic.IsHidden ||
        topic.IsLocked ||
        topic.IsBroken
      ) {
        continue;
      }
      result.push({
        course,
        topicId: topic.TopicId,
        title: topic.Title,
        url: topic.Url,
        modulePath,
        remoteModified: topic.LastModifiedDate,
      });
    }
    for (const child of [...(module.Modules || [])].sort((a, b) => a.SortOrder - b.SortOrder)) {
      visit(child, modulePath);
    }
  };

  for (const module of [...modules].sort((a, b) => a.SortOrder - b.SortOrder)) visit(module, []);
  return result;
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, Math.max(values.length, 1)) }, async () => {
    while (index < values.length) {
      const current = index;
      index += 1;
      const value = values[current];
      if (value !== undefined) results[current] = await worker(value);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function scan(
  client: BrightspaceApi,
  versions: { lp: string; le: string },
  options: SyncOptions,
  concurrency: number,
): Promise<ScanResult> {
  const available = await client.courses(versions.lp);
  const courses = available.filter((course) => matchesCourse(course, options.courseFilters));
  if (options.courseFilters.length > 0 && courses.length === 0) {
    throw new Error(`No course matched: ${options.courseFilters.join(", ")}`);
  }

  const warnings: string[] = [];
  const nested = await mapConcurrent(courses, concurrency, async (course) => {
    try {
      const toc = await client.toc(versions.le, course.id);
      return collectFileTopics(course, toc.Modules || []);
    } catch (error) {
      const reason =
        error instanceof BrightspaceHttpError && error.status === 403
          ? "no permission to read content"
          : (error as Error).message;
      warnings.push(`${course.code}: ${reason}`);
      return [];
    }
  });
  return { courses, topics: nested.flat(), warnings };
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
  return Boolean(
    !force && entry && exists && entry.remoteModified === topic.remoteModified,
  );
}

function displayCourse(course: Course): string {
  return course.code === String(course.id) ? course.name : `${course.code} — ${course.name}`;
}

export async function syncAll(
  client: BrightspaceApi,
  config: AppConfig,
  versions: { lp: string; le: string },
  options: SyncOptions,
): Promise<SyncCounts> {
  console.log("Scanning currently accessible courses…");
  const found = await scan(client, versions, options, config.concurrency);
  console.log(`\nCourses (${found.courses.length}):`);
  for (const course of found.courses) console.log(`  • ${displayCourse(course)}`);
  console.log(`File topics: ${found.topics.length}`);
  console.log(`Destination: ${config.outputDir}`);
  for (const warning of found.warnings) console.warn(`Warning: ${warning}`);

  if (options.dryRun) {
    console.log("Dry run complete; no files were downloaded.");
    return { downloaded: 0, updated: 0, skipped: 0, conflicts: 0, failed: 0 };
  }
  if (
    !options.assumeYes &&
    process.stdin.isTTY &&
    !(await confirm("Download/update all listed file topics?", true))
  ) {
    console.log("Cancelled.");
    return { downloaded: 0, updated: 0, skipped: 0, conflicts: 0, failed: 0 };
  }

  await mkdir(config.outputDir, { recursive: true });
  const manifest = await loadManifest(config.outputDir);
  const reserved = new Set(
    Object.values(manifest.files).map((entry) =>
      entry.localPath.normalize("NFC").toLocaleLowerCase("en-US"),
    ),
  );
  const counts: SyncCounts = { downloaded: 0, updated: 0, skipped: 0, conflicts: 0, failed: 0 };
  let nextIndex = 0;
  let stopping = false;
  let fatalAuthenticationError: BrightspaceAuthenticationError | null = null;
  let saveQueue = Promise.resolve();

  const persist = async () => {
    saveQueue = saveQueue.then(() => saveManifest(config.outputDir, manifest));
    await saveQueue;
  };
  const onInterrupt = () => {
    if (stopping) process.exitCode = 130;
    stopping = true;
    console.warn("\nStopping after active downloads finish…");
  };
  process.once("SIGINT", onInterrupt);

  const downloadOne = async (topic: FileTopic) => {
    const key = manifestKey(topic.course.id, topic.topicId);
    const previous = manifest.files[key];
    const previousAbsolute = previous ? safeResolve(config.outputDir, previous.localPath) : null;
    const exists = previousAbsolute ? await fileExists(previousAbsolute) : false;
    if (entryIsCurrent(previous, topic, exists, options.force)) {
      counts.skipped += 1;
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
      config.outputDir,
      `.usc-bs-download-${process.pid}-${topic.topicId}-${randomUUID()}.part`,
    );
    try {
      const response = await client.downloadFile(
        versions.le,
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
      let relativePath =
        previous?.localPath ||
        uniqueRelativePath(topic.course, topic.modulePath, remoteName, topic.topicId, reserved);
      if (localWasModified) {
        relativePath = conflictRelativePath(relativePath, reserved);
        counts.conflicts += 1;
        console.warn(`Conflict: kept local copy and saved remote update separately for ${topic.title}`);
      }

      const target = safeResolve(config.outputDir, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await rename(temporary, target);
      manifest.files[key] = {
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
      if (previous) counts.updated += 1;
      else counts.downloaded += 1;
      await persist();
      console.log(`Saved: ${relativePath}`);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  };

  const workers = Array.from({ length: Math.min(config.concurrency, Math.max(1, found.topics.length)) }, async () => {
    while (!stopping && nextIndex < found.topics.length) {
      const current = nextIndex;
      nextIndex += 1;
      const topic = found.topics[current];
      if (!topic) continue;
      try {
        await downloadOne(topic);
      } catch (error) {
        if (error instanceof BrightspaceAuthenticationError) {
          fatalAuthenticationError = error;
          stopping = true;
        } else {
          counts.failed += 1;
        }
        console.error(`Failed: ${topic.course.code} / ${topic.title}: ${(error as Error).message}`);
      }
    }
  });

  try {
    await Promise.all(workers);
    await saveQueue;
  } finally {
    process.off("SIGINT", onInterrupt);
  }

  if (fatalAuthenticationError) throw fatalAuthenticationError;

  console.log(
    `\nDone: ${counts.downloaded} new, ${counts.updated} updated, ${counts.skipped} unchanged, ` +
      `${counts.conflicts} conflicts, ${counts.failed} failed.`,
  );
  if (stopping) process.exitCode = 130;
  return counts;
}
