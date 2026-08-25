import type { CourseCatalog, FileSyncStatus } from "./catalog.js";
import type { FileTopic, TocModule } from "../types.js";

export type StatusFilter = "all" | "new" | "remote-updated";

export type TreeRow =
  | {
      kind: "module";
      key: string;
      moduleId: number;
      title: string;
      depth: number;
      topicIds: number[];
      expanded: boolean;
    }
  | {
      kind: "file";
      key: string;
      topic: FileTopic;
      depth: number;
      status: FileSyncStatus;
    };

export function topicKey(courseId: number, topicId: number): string {
  return `${courseId}:${topicId}`;
}

export function initialSelection(courses: CourseCatalog[]): Set<string> {
  return new Set(courses.flatMap((catalog) =>
    catalog.topics.map((topic) => topicKey(topic.course.id, topic.topicId))
  ));
}

export function toggleTopicKeys(selection: Set<string>, keys: string[]): Set<string> {
  const next = new Set(selection);
  const allSelected = keys.length > 0 && keys.every((key) => next.has(key));
  for (const key of keys) {
    if (allSelected) next.delete(key);
    else next.add(key);
  }
  return next;
}

function moduleTopicIds(module: TocModule, available: Set<number>): number[] {
  if (module.IsHidden || module.IsLocked) return [];
  return [
    ...(module.Topics || []).filter((topic) => available.has(topic.TopicId)).map((topic) => topic.TopicId),
    ...(module.Modules || []).flatMap((child) => moduleTopicIds(child, available)),
  ];
}

export function buildTreeRows(
  catalog: CourseCatalog,
  statuses: Map<number, FileSyncStatus>,
  expanded: Set<string>,
  filter: StatusFilter,
): TreeRow[] {
  const topicById = new Map(catalog.topics.map((topic) => [topic.topicId, topic]));
  const available = new Set(topicById.keys());
  const rows: TreeRow[] = [];
  const visit = (module: TocModule, depth: number) => {
    if (module.IsHidden || module.IsLocked) return;
    const allTopicIds = moduleTopicIds(module, available);
    const visibleTopicIds = allTopicIds.filter((id) => {
      const status = statuses.get(id) || "new";
      return filter === "all" || status === filter;
    });
    if (visibleTopicIds.length === 0) return;
    const key = `module:${catalog.course.id}:${module.ModuleId}`;
    const isExpanded = expanded.has(key);
    rows.push({
      kind: "module",
      key,
      moduleId: module.ModuleId,
      title: module.Title,
      depth,
      topicIds: allTopicIds,
      expanded: isExpanded,
    });
    if (!isExpanded) return;
    for (const rawTopic of [...(module.Topics || [])].sort((a, b) => a.SortOrder - b.SortOrder)) {
      const topic = topicById.get(rawTopic.TopicId);
      if (!topic) continue;
      const status = statuses.get(topic.topicId) || "new";
      if (filter !== "all" && status !== filter) continue;
      rows.push({
        kind: "file",
        key: `file:${catalog.course.id}:${topic.topicId}`,
        topic,
        depth: depth + 1,
        status,
      });
    }
    for (const child of [...(module.Modules || [])].sort((a, b) => a.SortOrder - b.SortOrder)) {
      visit(child, depth + 1);
    }
  };
  for (const module of [...catalog.modules].sort((a, b) => a.SortOrder - b.SortOrder)) visit(module, 0);
  return rows;
}
