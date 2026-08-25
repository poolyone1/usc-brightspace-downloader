import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { saveManifest } from "../../src/manifest.js";
import { loadCourseStatuses } from "../../src/tui/catalog.js";
import type { CourseCatalog } from "../../src/tui/catalog.js";

const course = { id: 42, code: "CSCI-999", name: "Test Course" };
const topic = (topicId: number, remoteModified: string) => ({
  course,
  topicId,
  title: `File ${topicId}.pdf`,
  url: `/file-${topicId}.pdf`,
  modulePath: ["Week 1"],
  remoteModified,
});

test("classifies synced, new and remote-updated files", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "usc-bs-status-"));
  try {
    const catalog: CourseCatalog = {
      course,
      modules: [],
      topics: [topic(1, "2026-01-01"), topic(2, "2026-02-02"), topic(3, "2026-03-03")],
      warning: null,
    };
    await writeFile(path.join(outputDir, "one.pdf"), "one");
    await writeFile(path.join(outputDir, "two.pdf"), "two");
    await saveManifest(outputDir, {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      files: {
        "42:1": {
          courseId: 42, topicId: 1, title: "one", remoteModified: "2026-01-01",
          localPath: "one.pdf", sha256: "", size: 3, etag: null, downloadedAt: "2026-01-01",
        },
        "42:2": {
          courseId: 42, topicId: 2, title: "two", remoteModified: "2026-01-15",
          localPath: "two.pdf", sha256: "", size: 3, etag: null, downloadedAt: "2026-01-15",
        },
      },
    });
    const statuses = await loadCourseStatuses(catalog, outputDir);
    assert.equal(statuses.get(1), "synced");
    assert.equal(statuses.get(2), "remote-updated");
    assert.equal(statuses.get(3), "new");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
