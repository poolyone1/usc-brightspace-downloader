import { mkdir } from "node:fs/promises";
import type { BrightspaceApi } from "./brightspace.js";
import { BrightspaceHttpError } from "./brightspace.js";
import { confirm } from "./prompt.js";
import { executeSyncPlan } from "./sync-engine.js";
import type { SyncCounts, SyncEvent } from "./sync-engine.js";
import type { AppConfig, Course, FileTopic, SyncOptions, TocModule } from "./types.js";

export interface ScanResult {
  courses: Course[];
  topics: FileTopic[];
  warnings: string[];
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
      if (topic.ActivityType !== 1 || topic.IsHidden || topic.IsLocked || topic.IsBroken) continue;
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
      const reason = error instanceof BrightspaceHttpError && error.status === 403
        ? "no permission to read content"
        : (error as Error).message;
      warnings.push(`${course.code}: ${reason}`);
      return [];
    }
  });
  return { courses, topics: nested.flat(), warnings };
}

function displayCourse(course: Course): string {
  return course.code === String(course.id) ? course.name : `${course.code} — ${course.name}`;
}

function reportToConsole(event: SyncEvent): void {
  const topic = event.item.topic;
  if (event.type === "file-conflict") {
    console.warn(`Conflict: kept local copy and saved remote update separately for ${topic.title}`);
  } else if (event.type === "file-saved") {
    console.log(`Saved: ${event.localPath}`);
  } else if (event.type === "file-failed") {
    console.error(`Failed: ${topic.course.code} / ${topic.title}: ${event.error.message}`);
  }
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
  if (!options.assumeYes && process.stdin.isTTY && !(await confirm("Download/update all listed file topics?", true))) {
    console.log("Cancelled.");
    return { downloaded: 0, updated: 0, skipped: 0, conflicts: 0, failed: 0 };
  }

  const controller = new AbortController();
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
    controller.abort();
    console.warn("\nStopping after active downloads finish…");
  };
  process.once("SIGINT", onInterrupt);
  let counts: SyncCounts;
  try {
    await mkdir(config.outputDir, { recursive: true });
    counts = await executeSyncPlan(
      client,
      versions.le,
      found.topics.map((topic) => ({ topic, outputDir: config.outputDir, force: options.force })),
      { concurrency: config.concurrency, signal: controller.signal, onEvent: reportToConsole },
    );
  } finally {
    process.off("SIGINT", onInterrupt);
  }
  console.log(
    `\nDone: ${counts.downloaded} new, ${counts.updated} updated, ${counts.skipped} unchanged, ` +
      `${counts.conflicts} conflicts, ${counts.failed} failed.`,
  );
  if (interrupted) process.exitCode = 130;
  return counts;
}
