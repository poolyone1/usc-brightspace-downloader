import assert from "node:assert/strict";
import test from "node:test";
import { collectFileTopics } from "../src/sync.js";
import type { TocModule } from "../src/types.js";

const course = { id: 42, code: "CSCI-999", name: "Test Course" };

function module(overrides: Partial<TocModule> = {}): TocModule {
  return {
    ModuleId: 1,
    Title: "Week 1",
    SortOrder: 1,
    IsHidden: false,
    IsLocked: false,
    Modules: [],
    Topics: [],
    ...overrides,
  };
}

test("collects only accessible file topics and preserves module hierarchy", () => {
  const modules = [
    module({
      Topics: [
        {
          TopicId: 10,
          Title: "Slides",
          Url: "/content/slides.pdf",
          SortOrder: 1,
          IsHidden: false,
          IsLocked: false,
          IsBroken: false,
          ActivityType: 1,
          LastModifiedDate: "2026-08-01T00:00:00Z",
        },
        {
          TopicId: 11,
          Title: "External",
          Url: "https://example.com",
          SortOrder: 2,
          IsHidden: false,
          IsLocked: false,
          IsBroken: false,
          ActivityType: 2,
          LastModifiedDate: null,
        },
      ],
      Modules: [module({ ModuleId: 2, Title: "Readings", Topics: [] })],
    }),
    module({ ModuleId: 3, Title: "Hidden", IsHidden: true }),
  ];
  const topics = collectFileTopics(course, modules);
  assert.equal(topics.length, 1);
  assert.deepEqual(topics[0]?.modulePath, ["Week 1"]);
  assert.equal(topics[0]?.topicId, 10);
});
