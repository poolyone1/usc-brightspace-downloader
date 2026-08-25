import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { BrightspaceApi } from "../brightspace.js";
import { executeSyncPlan } from "../sync-engine.js";
import type { PlannedTopic, SyncCounts, SyncEvent } from "../sync-engine.js";
import type { AppConfig, FileTopic, TocModule } from "../types.js";
import type { CourseCatalog, FileSyncStatus } from "./catalog.js";
import { countStatuses, loadCourseStatuses } from "./catalog.js";
import {
  buildTreeRows,
  initialSelection,
  toggleTopicKeys,
  topicKey,
} from "./model.js";
import type { StatusFilter, TreeRow } from "./model.js";
import { normalizeDestination, saveTuiProfile } from "./profile.js";
import type { TuiProfile } from "./profile.js";

export interface TuiCourse {
  catalog: CourseCatalog;
  outputDir: string;
  statuses: Map<number, FileSyncStatus>;
}

interface TuiAppProps {
  client: BrightspaceApi;
  config: AppConfig;
  leVersion: string;
  initialCourses: TuiCourse[];
  initialProfile: TuiProfile;
}

type Screen = "courses" | "tree" | "detail" | "plan" | "progress" | "result";

interface ProgressState {
  total: number;
  completed: number;
  active: Record<string, string>;
  recent: string[];
  failures: string[];
  cancelling: boolean;
}

interface ResultState {
  counts: SyncCounts | null;
  error: string | null;
  cancelled: boolean;
}

function allModuleKeys(catalog: CourseCatalog): Set<string> {
  const keys = new Set<string>();
  const visit = (modules: TocModule[]) => {
    for (const module of modules) {
      keys.add(`module:${catalog.course.id}:${module.ModuleId}`);
      visit(module.Modules || []);
    }
  };
  visit(catalog.modules);
  return keys;
}

function marker(keys: string[], selection: Set<string>): string {
  if (keys.length === 0) return "[ ]";
  const selected = keys.filter((key) => selection.has(key)).length;
  return selected === 0 ? "[ ]" : selected === keys.length ? "[✓]" : "[~]";
}

function statusBadge(status: FileSyncStatus): { text: string; color: string } {
  if (status === "synced") return { text: "[Synced]", color: "green" };
  if (status === "remote-updated") return { text: "[Remote updated]", color: "yellow" };
  return { text: "[New]", color: "cyan" };
}

function formatDate(value: string | null): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-US");
}

function shortPath(value: string, width = 64): string {
  if (value.length <= width) return value;
  return `…${value.slice(-(width - 1))}`;
}

function selectedLabel(row: TreeRow, selection: Set<string>, courseId: number): string {
  const keys = row.kind === "file"
    ? [topicKey(courseId, row.topic.topicId)]
    : row.topicIds.map((id) => topicKey(courseId, id));
  return marker(keys, selection);
}

function Header({ children }: { children: string }) {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">USC Brightspace</Text>
      <Text> › {children}</Text>
    </Box>
  );
}

function Footer({ children }: { children: string }) {
  return (
    <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
      <Text dimColor>{children}</Text>
    </Box>
  );
}

export function TuiApp({
  client,
  config,
  leVersion,
  initialCourses,
  initialProfile,
}: TuiAppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [screen, setScreen] = useState<Screen>("courses");
  const [courses, setCourses] = useState(initialCourses);
  const [profile, setProfile] = useState(initialProfile);
  const [selection, setSelection] = useState(() => initialSelection(initialCourses.map((item) => item.catalog)));
  const [forceKeys, setForceKeys] = useState<Set<string>>(() => new Set());
  const [courseCursor, setCourseCursor] = useState(0);
  const [activeCourseId, setActiveCourseId] = useState<number | null>(null);
  const [treeCursor, setTreeCursor] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const all = new Set<string>();
    for (const course of initialCourses) for (const key of allModuleKeys(course.catalog)) all.add(key);
    return all;
  });
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [detailTopicId, setDetailTopicId] = useState<number | null>(null);
  const [directoryInput, setDirectoryInput] = useState<{ courseId: number; value: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [result, setResult] = useState<ResultState | null>(null);
  const cancelRef = useRef<AbortController | null>(null);
  const syncStartedRef = useRef(false);

  const activeCourse = courses.find((item) => item.catalog.course.id === activeCourseId) || null;
  const treeRows = useMemo(
    () => activeCourse
      ? buildTreeRows(activeCourse.catalog, activeCourse.statuses, expanded, filter)
      : [],
    [activeCourse, expanded, filter],
  );
  const selectedItems = useMemo(() => courses.flatMap((course) =>
    course.catalog.topics
      .filter((topic) => selection.has(topicKey(topic.course.id, topic.topicId)))
      .map((topic): PlannedTopic => ({
        topic,
        outputDir: course.outputDir,
        force: forceKeys.has(topicKey(topic.course.id, topic.topicId)),
      })),
  ), [courses, selection, forceKeys]);

  useEffect(() => {
    setCourseCursor((current) => Math.max(0, Math.min(current, courses.length - 1)));
  }, [courses.length]);
  useEffect(() => {
    setTreeCursor((current) => Math.max(0, Math.min(current, treeRows.length - 1)));
  }, [treeRows.length]);

  const refreshStatuses = async () => {
    const refreshed = await Promise.all(courses.map(async (course) => ({
      ...course,
      statuses: await loadCourseStatuses(course.catalog, course.outputDir),
    })));
    setCourses(refreshed);
  };

  const changeDestination = async (courseId: number, value: string) => {
    try {
      const outputDir = normalizeDestination(value);
      const target = courses.find((course) => course.catalog.course.id === courseId);
      if (!target) return;
      const statuses = await loadCourseStatuses(target.catalog, outputDir);
      const nextProfile: TuiProfile = {
        version: 1,
        courseDestinations: {
          ...profile.courseDestinations,
          [String(courseId)]: outputDir,
        },
      };
      await saveTuiProfile(nextProfile);
      setProfile(nextProfile);
      setCourses((current) => current.map((course) =>
        course.catalog.course.id === courseId ? { ...course, outputDir, statuses } : course
      ));
      setNotice(`Download directory set to ${outputDir}`);
    } catch (error) {
      setNotice(`Unable to set download directory: ${(error as Error).message}`);
    } finally {
      setDirectoryInput(null);
    }
  };

  const handleSyncEvent = (event: SyncEvent) => {
    const label = `${event.item.topic.course.code} / ${event.item.topic.title}`;
    const identity = topicKey(event.item.topic.course.id, event.item.topic.topicId);
    setProgress((current) => {
      if (!current) return current;
      const active = { ...current.active };
      let completed = current.completed;
      let recent = current.recent;
      let failures = current.failures;
      if (event.type === "file-started") active[identity] = label;
      if (event.type === "file-skipped") {
        delete active[identity];
        completed += 1;
        recent = [`Skipped ${label}`, ...recent].slice(0, 5);
      }
      if (event.type === "file-saved") {
        delete active[identity];
        completed += 1;
        recent = [`Saved ${label}`, ...recent].slice(0, 5);
      }
      if (event.type === "file-failed") {
        delete active[identity];
        completed += 1;
        failures = [`${label}: ${event.error.message}`, ...failures].slice(0, 5);
      }
      return { ...current, active, completed, recent, failures };
    });
  };

  useEffect(() => {
    if (screen !== "progress" || syncStartedRef.current) return;
    syncStartedRef.current = true;
    const controller = new AbortController();
    cancelRef.current = controller;
    setProgress({
      total: selectedItems.length,
      completed: 0,
      active: {},
      recent: [],
      failures: [],
      cancelling: false,
    });
    void executeSyncPlan(client, leVersion, selectedItems, {
      concurrency: config.concurrency,
      signal: controller.signal,
      onEvent: handleSyncEvent,
    }).then(async (counts) => {
      await refreshStatuses();
      setResult({ counts, error: null, cancelled: controller.signal.aborted });
      setScreen("result");
    }).catch((error) => {
      setResult({ counts: null, error: (error as Error).message, cancelled: controller.signal.aborted });
      setScreen("result");
    }).finally(() => {
      cancelRef.current = null;
    });
  }, [screen]);

  useInput((input, key) => {
    setNotice(null);
    if (directoryInput) {
      if (key.escape || (key.ctrl && input === "c")) setDirectoryInput(null);
      else if (key.return) void changeDestination(directoryInput.courseId, directoryInput.value);
      else if (key.backspace || key.delete) {
        setDirectoryInput({ ...directoryInput, value: directoryInput.value.slice(0, -1) });
      } else if (input && !key.ctrl && !key.meta) {
        setDirectoryInput({ ...directoryInput, value: directoryInput.value + input });
      }
      return;
    }

    if (key.ctrl && input === "c" && screen !== "progress") {
      exit();
      return;
    }

    if (screen === "progress") {
      if (input === "q" || key.escape || (key.ctrl && input === "c")) {
        cancelRef.current?.abort();
        setProgress((current) => current ? { ...current, cancelling: true } : current);
      }
      return;
    }
    if (screen === "result") {
      if (key.return || key.escape) {
        syncStartedRef.current = false;
        setScreen("courses");
      } else if (input === "q") exit();
      return;
    }
    if (screen === "plan") {
      if (key.escape) setScreen(activeCourseId === null ? "courses" : "tree");
      else if (key.return && selectedItems.length > 0) setScreen("progress");
      return;
    }
    if (screen === "detail") {
      if (key.escape) setScreen("tree");
      else if (input === " " && activeCourse && detailTopicId !== null) {
        setSelection((current) => toggleTopicKeys(current, [topicKey(activeCourse.catalog.course.id, detailTopicId)]));
      } else if (input === "f" && activeCourse && detailTopicId !== null) {
        const keyValue = topicKey(activeCourse.catalog.course.id, detailTopicId);
        setForceKeys((current) => {
          const next = new Set(current);
          if (next.has(keyValue)) next.delete(keyValue);
          else next.add(keyValue);
          return next;
        });
      }
      return;
    }
    if (screen === "courses") {
      if (key.upArrow) setCourseCursor((value) => Math.max(0, value - 1));
      else if (key.downArrow) setCourseCursor((value) => Math.min(courses.length - 1, value + 1));
      else if (key.return) {
        const selected = courses[courseCursor];
        if (selected) {
          setActiveCourseId(selected.catalog.course.id);
          setTreeCursor(0);
          setScreen("tree");
        }
      } else if (input === " " && courses[courseCursor]) {
        const course = courses[courseCursor];
        if (course) {
          setSelection((current) => toggleTopicKeys(
            current,
            course.catalog.topics.map((topic) => topicKey(topic.course.id, topic.topicId)),
          ));
        }
      } else if (input === "d" && courses[courseCursor]) {
        const course = courses[courseCursor];
        if (course) setDirectoryInput({ courseId: course.catalog.course.id, value: course.outputDir });
      } else if (input === "s") {
        setActiveCourseId(null);
        setScreen("plan");
      } else if (input === "r") void refreshStatuses();
      else if (input === "q" || key.escape) exit();
      return;
    }
    if (screen === "tree" && activeCourse) {
      if (key.upArrow) setTreeCursor((value) => Math.max(0, value - 1));
      else if (key.downArrow) setTreeCursor((value) => Math.min(treeRows.length - 1, value + 1));
      else if (key.escape) setScreen("courses");
      else if (input === "1") setFilter("all");
      else if (input === "2") setFilter("new");
      else if (input === "3") setFilter("remote-updated");
      else if (input === "d") {
        setDirectoryInput({ courseId: activeCourse.catalog.course.id, value: activeCourse.outputDir });
      } else if (input === "s") setScreen("plan");
      else {
        const row = treeRows[treeCursor];
        if (!row) return;
        if (key.return) {
          if (row.kind === "module") {
            setExpanded((current) => {
              const next = new Set(current);
              if (next.has(row.key)) next.delete(row.key);
              else next.add(row.key);
              return next;
            });
          } else {
            setDetailTopicId(row.topic.topicId);
            setScreen("detail");
          }
        } else if (input === " ") {
          const keys = row.kind === "file"
            ? [topicKey(activeCourse.catalog.course.id, row.topic.topicId)]
            : row.topicIds.map((id) => topicKey(activeCourse.catalog.course.id, id));
          setSelection((current) => toggleTopicKeys(current, keys));
        } else if (input === "f" && row.kind === "file") {
          const keyValue = topicKey(activeCourse.catalog.course.id, row.topic.topicId);
          setForceKeys((current) => {
            const next = new Set(current);
            if (next.has(keyValue)) next.delete(keyValue);
            else next.add(keyValue);
            return next;
          });
        }
      }
    }
  });

  const height = Math.max(8, (stdout.rows || 30) - 8);

  if (directoryInput) {
    return (
      <Box flexDirection="column">
        <Header>Set course download directory</Header>
        <Box marginTop={1} flexDirection="column">
          <Text>Enter an absolute path or a path beginning with ~/:</Text>
          <Box borderStyle="round" borderColor="yellow" paddingX={1}>
            <Text>{directoryInput.value}</Text><Text inverse> </Text>
          </Box>
        </Box>
        <Footer>Enter Save  Esc Cancel</Footer>
      </Box>
    );
  }

  if (screen === "courses") {
    const start = Math.max(0, Math.min(courseCursor - Math.floor(height / 2), courses.length - height));
    const visible = courses.slice(start, start + height);
    return (
      <Box flexDirection="column">
        <Header>Course list</Header>
        <Box flexDirection="column" marginTop={1}>
          {visible.map((item, offset) => {
            const index = start + offset;
            const keys = item.catalog.topics.map((topic) => topicKey(topic.course.id, topic.topicId));
            const counts = countStatuses(item.statuses.values());
            return (
              <Box key={item.catalog.course.id} flexDirection="column" marginBottom={1}>
                <Text inverse={index === courseCursor}>
                  {index === courseCursor ? "›" : " "} {marker(keys, selection)} {item.catalog.course.code} — {item.catalog.course.name}
                </Text>
                <Text dimColor>
                  {"    "}Synced {counts.synced} · New {counts.new} · Remote updated {counts["remote-updated"]}
                </Text>
                <Text dimColor>{"    "}{shortPath(item.outputDir)}</Text>
                {item.catalog.warning ? <Text color="red">{"    "}{item.catalog.warning}</Text> : null}
              </Box>
            );
          })}
          {courses.length === 0 ? <Text color="yellow">No accessible courses.</Text> : null}
        </Box>
        {notice ? <Text color="yellow">{notice}</Text> : null}
        <Footer>↑↓ Move  Enter File tree  Space Select course  d Directory  s Sync plan  r Refresh  q Quit</Footer>
      </Box>
    );
  }

  if (screen === "tree" && activeCourse) {
    const start = Math.max(0, Math.min(treeCursor - Math.floor(height / 2), treeRows.length - height));
    const visible = treeRows.slice(start, start + height);
    return (
      <Box flexDirection="column">
        <Header>{`${activeCourse.catalog.course.code} › File tree`}</Header>
        <Text dimColor>Directory: {shortPath(activeCourse.outputDir)} · Filter: {filter === "all" ? "All" : filter === "new" ? "New" : "Remote updated"}</Text>
        <Box flexDirection="column" marginTop={1}>
          {visible.map((row, offset) => {
            const index = start + offset;
            const indent = "  ".repeat(row.depth);
            const selectionMark = selectedLabel(row, selection, activeCourse.catalog.course.id);
            if (row.kind === "module") {
              return (
                <Text key={row.key} inverse={index === treeCursor}>
                  {index === treeCursor ? "›" : " "} {indent}{row.expanded ? "▼" : "▶"} {selectionMark} {row.title}
                </Text>
              );
            }
            const badge = statusBadge(row.status);
            const forced = forceKeys.has(topicKey(row.topic.course.id, row.topic.topicId));
            return (
              <Box key={row.key}>
                <Text inverse={index === treeCursor}>
                  {index === treeCursor ? "›" : " "} {indent}  {selectionMark} {row.topic.title}{forced ? " [Forced]" : ""}
                </Text>
                <Text color={badge.color}> {badge.text}</Text>
              </Box>
            );
          })}
          {treeRows.length === 0 ? <Text color="yellow">No files match the current filter.</Text> : null}
        </Box>
        <Footer>↑↓ Move  Enter Expand/Details  Space Select  f Force  1 All  2 New  3 Updated  d Directory  s Sync  Esc Back</Footer>
      </Box>
    );
  }

  if (screen === "detail" && activeCourse && detailTopicId !== null) {
    const topic = activeCourse.catalog.topics.find((item) => item.topicId === detailTopicId);
    if (!topic) return <Text color="red">File not found.</Text>;
    const status = activeCourse.statuses.get(topic.topicId) || "new";
    const badge = statusBadge(status);
    const keyValue = topicKey(topic.course.id, topic.topicId);
    return (
      <Box flexDirection="column">
        <Header>{`${activeCourse.catalog.course.code} › ${topic.modulePath.join(" › ")} › ${topic.title}`}</Header>
        <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
          <Text>Status            <Text color={badge.color}>{badge.text}</Text></Text>
          <Text>Course            {topic.course.code} — {topic.course.name}</Text>
          <Text>Module            {topic.modulePath.join(" / ") || "Course root"}</Text>
          <Text>Destination       {activeCourse.outputDir}</Text>
          <Text>Remote modified   {formatDate(topic.remoteModified)}</Text>
          <Text>Topic ID          {topic.topicId}</Text>
          <Text>Selected          {selection.has(keyValue) ? "Yes" : "No"}</Text>
          <Text>Force download    {forceKeys.has(keyValue) ? "Yes" : "No"}</Text>
          <Text>Conflict handling Keep local file; save remote version separately</Text>
        </Box>
        <Footer>Space Select/Deselect  f Toggle force download  Esc Back</Footer>
      </Box>
    );
  }

  if (screen === "plan") {
    const byStatus = { synced: 0, new: 0, "remote-updated": 0 };
    for (const item of selectedItems) {
      const course = courses.find((value) => value.catalog.course.id === item.topic.course.id);
      const status = course?.statuses.get(item.topic.topicId) || "new";
      byStatus[status] += 1;
    }
    const destinations = new Map<string, number>();
    for (const item of selectedItems) destinations.set(item.outputDir, (destinations.get(item.outputDir) || 0) + 1);
    return (
      <Box flexDirection="column">
        <Header>Sync plan</Header>
        <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
          <Text>Selected       {selectedItems.length} files</Text>
          <Text color="cyan">New            {byStatus.new}</Text>
          <Text color="yellow">Remote updated {byStatus["remote-updated"]}</Text>
          <Text color="green">Synced         {byStatus.synced}</Text>
          <Text>Forced         {selectedItems.filter((item) => item.force).length}</Text>
          <Text>Concurrency    {config.concurrency}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text bold>Destinations</Text>
            {[...destinations].map(([destination, count]) => (
              <Text key={destination}>  {count} files → {shortPath(destination)}</Text>
            ))}
          </Box>
        </Box>
        <Footer>Enter Start sync  Esc Edit selection</Footer>
      </Box>
    );
  }

  if (screen === "progress" && progress) {
    return (
      <Box flexDirection="column">
        <Header>Syncing</Header>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Progress {progress.completed}/{progress.total}</Text>
          <Text>Active downloads {Object.keys(progress.active).length}/{config.concurrency}</Text>
          {Object.entries(progress.active).map(([identity, value]) => (
            <Text key={identity} color="cyan">↓ {value}</Text>
          ))}
          {progress.recent.length > 0 ? <Text bold>Recently completed</Text> : null}
          {progress.recent.map((value, index) => <Text key={`${index}:${value}`} color="green">✓ {value}</Text>)}
          {progress.failures.map((value, index) => <Text key={`${index}:${value}`} color="red">✗ {value}</Text>)}
          {progress.cancelling ? <Text color="yellow">Stopping safely; waiting for active downloads…</Text> : null}
        </Box>
        <Footer>q / Esc / Ctrl-C Safe stop</Footer>
      </Box>
    );
  }

  if (screen === "result" && result) {
    return (
      <Box flexDirection="column">
        <Header>Sync result</Header>
        <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
          {result.error ? <Text color="red">Error: {result.error}</Text> : null}
          {result.cancelled ? <Text color="yellow">Sync stopped safely.</Text> : null}
          {result.counts ? (
            <>
              <Text>Downloaded {result.counts.downloaded}</Text>
              <Text>Updated    {result.counts.updated}</Text>
              <Text>Skipped    {result.counts.skipped}</Text>
              <Text>Conflicts  {result.counts.conflicts}</Text>
              <Text>Failed     {result.counts.failed}</Text>
            </>
          ) : null}
        </Box>
        <Footer>Enter / Esc Return to course list  q Quit</Footer>
      </Box>
    );
  }

  return <Text color="red">Unknown screen state.</Text>;
}
