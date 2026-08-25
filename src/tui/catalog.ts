import { access } from "node:fs/promises";
import path from "node:path";
import type { BrightspaceApi, ApiVersions } from "../brightspace.js";
import { BrightspaceHttpError } from "../brightspace.js";
import { loadManifest, manifestKey } from "../manifest.js";
import { safeResolve } from "../paths.js";
import { collectFileTopics } from "../sync.js";
import type { Course, FileTopic, TocModule } from "../types.js";

export type FileSyncStatus = "synced" | "new" | "remote-updated";

export interface CourseCatalog {
  course: Course;
  modules: TocModule[];
  topics: FileTopic[];
  warning: string | null;
}

export interface CatalogSnapshot {
  versions: ApiVersions;
  courses: CourseCatalog[];
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, values.length)) }, async () => {
    while (next < values.length) {
      const index = next++;
      const value = values[index];
      if (value !== undefined) result[index] = await worker(value);
    }
  });
  await Promise.all(workers);
  return result;
}

export async function loadCatalog(
  client: BrightspaceApi,
  concurrency: number,
): Promise<CatalogSnapshot> {
  const versions = await client.versions();
  const courses = await client.courses(versions.lp);
  const catalogs = await mapConcurrent(courses, concurrency, async (course): Promise<CourseCatalog> => {
    try {
      const toc = await client.toc(versions.le, course.id);
      const modules = toc.Modules || [];
      return { course, modules, topics: collectFileTopics(course, modules), warning: null };
    } catch (error) {
      const warning = error instanceof BrightspaceHttpError && error.status === 403
        ? "No permission to read content"
        : (error as Error).message;
      return { course, modules: [], topics: [], warning };
    }
  });
  return { versions, courses: catalogs };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function loadCourseStatuses(
  catalog: CourseCatalog,
  outputDir: string,
): Promise<Map<number, FileSyncStatus>> {
  const manifest = await loadManifest(outputDir);
  const entries = await Promise.all(catalog.topics.map(async (topic) => {
    const entry = manifest.files[manifestKey(topic.course.id, topic.topicId)];
    if (!entry) return [topic.topicId, "new"] as const;
    const localPath = safeResolve(path.resolve(outputDir), entry.localPath);
    if (!(await exists(localPath))) return [topic.topicId, "new"] as const;
    if (entry.remoteModified !== topic.remoteModified) {
      return [topic.topicId, "remote-updated"] as const;
    }
    return [topic.topicId, "synced"] as const;
  }));
  return new Map(entries);
}

export function countStatuses(statuses: Iterable<FileSyncStatus>): Record<FileSyncStatus, number> {
  const counts: Record<FileSyncStatus, number> = { synced: 0, new: 0, "remote-updated": 0 };
  for (const status of statuses) counts[status] += 1;
  return counts;
}
