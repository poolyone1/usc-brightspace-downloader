import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BrightspaceApi } from "../src/brightspace.js";
import type { DownloadedFile } from "../src/brightspace.js";
import { executeSyncPlan } from "../src/sync-engine.js";

class FakeClient extends BrightspaceApi {
  downloads = 0;
  constructor() { super("https://example.edu"); }
  async json<T>(): Promise<T> { throw new Error("not used"); }
  async downloadFile(
    _leVersion: string,
    _courseId: number,
    _topicId: number,
    target: string,
  ): Promise<DownloadedFile> {
    this.downloads += 1;
    const value = Buffer.from("hello");
    await writeFile(target, value);
    return {
      sha256: createHash("sha256").update(value).digest("hex"),
      size: value.length,
      suggestedFilename: "hello.pdf",
      contentDisposition: null,
      contentType: "application/pdf",
      etag: null,
    };
  }
}

test("downloads a planned topic then skips it when metadata is unchanged", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "usc-bs-engine-"));
  const client = new FakeClient();
  const topic = {
    course: { id: 1, code: "CSCI-1", name: "Test" },
    topicId: 2,
    title: "Hello",
    url: "/hello.pdf",
    modulePath: ["Week 1"],
    remoteModified: "2026-01-01",
  };
  try {
    const first = await executeSyncPlan(client, "1.0", [{ topic, outputDir, force: false }], { concurrency: 3 });
    assert.equal(first.downloaded, 1);
    assert.equal(client.downloads, 1);
    const second = await executeSyncPlan(client, "1.0", [{ topic, outputDir, force: false }], { concurrency: 3 });
    assert.equal(second.skipped, 1);
    assert.equal(client.downloads, 1);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
