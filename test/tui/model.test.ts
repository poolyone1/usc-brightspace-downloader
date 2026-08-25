import assert from "node:assert/strict";
import test from "node:test";
import { buildTreeRows, initialSelection, toggleTopicKeys, topicKey } from "../../src/tui/model.js";
import type { CourseCatalog } from "../../src/tui/catalog.js";
import type { TocModule } from "../../src/types.js";

const course = { id: 7, code: "CSCI-7", name: "Trees" };
const rawTopic = (id: number, title: string) => ({
  TopicId: id, Title: title, Url: `/${id}.pdf`, SortOrder: id,
  IsHidden: false, IsLocked: false, IsBroken: false, ActivityType: 1,
  LastModifiedDate: `2026-01-0${id}`,
});
const module: TocModule = {
  ModuleId: 10, Title: "Week 1", SortOrder: 1, IsHidden: false, IsLocked: false,
  Topics: [rawTopic(1, "One"), rawTopic(2, "Two")], Modules: [],
};
const catalog: CourseCatalog = {
  course,
  modules: [module],
  topics: [
    { course, topicId: 1, title: "One", url: "/1.pdf", modulePath: ["Week 1"], remoteModified: "2026-01-01" },
    { course, topicId: 2, title: "Two", url: "/2.pdf", modulePath: ["Week 1"], remoteModified: "2026-01-02" },
  ],
  warning: null,
};

test("builds module/file rows and filters to remote updates", () => {
  const statuses = new Map([[1, "synced"], [2, "remote-updated"]] as const);
  const expanded = new Set(["module:7:10"]);
  assert.equal(buildTreeRows(catalog, statuses, expanded, "all").length, 3);
  const updated = buildTreeRows(catalog, statuses, expanded, "remote-updated");
  assert.equal(updated.length, 2);
  assert.equal(updated[1]?.kind, "file");
  if (updated[1]?.kind === "file") assert.equal(updated[1].topic.topicId, 2);
});

test("selection defaults to all and supports tri-state group toggles", () => {
  const selection = initialSelection([catalog]);
  assert.deepEqual([...selection], [topicKey(7, 1), topicKey(7, 2)]);
  const partial = toggleTopicKeys(selection, [topicKey(7, 1)]);
  assert.deepEqual([...partial], [topicKey(7, 2)]);
  const allAgain = toggleTopicKeys(partial, [topicKey(7, 1), topicKey(7, 2)]);
  assert.equal(allAgain.size, 2);
});
