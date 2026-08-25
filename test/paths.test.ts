import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  filenameFromDisposition,
  preferredFilename,
  safeResolve,
  sanitizeComponent,
  uniqueRelativePath,
} from "../src/paths.js";

test("sanitizes path traversal and filesystem punctuation", () => {
  assert.equal(sanitizeComponent(" ../../Week: 1/Slides? "), "..-..-Week- 1-Slides-");
  assert.equal(sanitizeComponent(".."), "untitled");
});

test("parses RFC 5987 and quoted content-disposition filenames", () => {
  assert.equal(
    filenameFromDisposition("attachment; filename*=UTF-8''Lecture%20One.pdf"),
    "Lecture One.pdf",
  );
  assert.equal(filenameFromDisposition('attachment; filename="week 2.pdf"'), "week 2.pdf");
});

test("adds an extension from content type when needed", () => {
  assert.equal(preferredFilename(null, "/content/no-name", "Syllabus", "application/pdf"), "no-name.pdf");
});

test("rejects paths outside the output root", () => {
  const root = path.resolve("/tmp/usc-bs-test");
  assert.throws(() => safeResolve(root, "../outside"));
  assert.equal(safeResolve(root, "course/file.pdf"), path.join(root, "course/file.pdf"));
});

test("uses stable topic IDs to resolve filename collisions", () => {
  const reserved = new Set<string>();
  const course = { id: 10, code: "CSCI-570", name: "Analysis" };
  const first = uniqueRelativePath(course, ["Week 1"], "slides.pdf", 100, reserved);
  const second = uniqueRelativePath(course, ["Week 1"], "slides.pdf", 101, reserved);
  assert.match(first, /slides\.pdf$/);
  assert.match(second, /slides \[101\]\.pdf$/);
});
