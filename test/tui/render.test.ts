import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "ink";
import type { BrightspaceApi } from "../../src/brightspace.js";
import { TuiApp } from "../../src/tui/app.js";
import type { FileSyncStatus } from "../../src/tui/catalog.js";

test("renders the first-level course screen with status counts", () => {
  const course = { id: 1, code: "CSCI-1", name: "Demo Course" };
  const catalog = {
    course,
    modules: [],
    topics: [{
      course,
      topicId: 10,
      title: "Slides.pdf",
      url: "/slides.pdf",
      modulePath: ["Week 1"],
      remoteModified: "2026-01-01",
    }],
    warning: null,
  };
  const output = renderToString(createElement(TuiApp, {
    client: {} as BrightspaceApi,
    config: {
      baseUrl: "https://example.edu",
      outputDir: "/tmp/courses",
      concurrency: 3,
      auth: { method: "browser-session" },
    },
    leVersion: "1.0",
    initialCourses: [{
      catalog,
      outputDir: "/tmp/courses",
      statuses: new Map<number, FileSyncStatus>([[10, "new"]]),
    }],
    initialProfile: { version: 1, courseDestinations: {} },
  }));
  assert.match(output, /课程列表/);
  assert.match(output, /CSCI-1/);
  assert.match(output, /新文件 1/);
});
