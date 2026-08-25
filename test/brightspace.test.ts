import assert from "node:assert/strict";
import test from "node:test";
import { BrightspaceClient } from "../src/brightspace.js";

test("discovers versions and follows enrollment bookmarks using bearer auth", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: URL; authorization: string | null }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers);
    requests.push({ url, authorization: headers.get("authorization") });
    if (url.pathname === "/d2l/api/versions/") {
      return Response.json([
        { ProductCode: "lp", LatestVersion: "1.63", SupportedVersions: ["1.63"] },
        { ProductCode: "le", LatestVersion: "1.97", SupportedVersions: ["1.97"] },
      ]);
    }
    if (url.pathname.endsWith("/enrollments/myenrollments/")) {
      const second = url.searchParams.get("bookmark") === "10";
      return Response.json({
        PagingInfo: { Bookmark: second ? "20" : "10", HasMoreItems: !second },
        Items: second
          ? []
          : [
              {
                OrgUnit: {
                  Id: 10,
                  Type: { Id: 3, Code: "Course Offering", Name: "Course Offering" },
                  Name: "Algorithms",
                  Code: "CSCI-570",
                  HomeUrl: "/d2l/home/10",
                },
                Access: {
                  IsActive: true,
                  CanAccess: true,
                  StartDate: null,
                  EndDate: null,
                },
                PinDate: null,
              },
            ],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    const client = new BrightspaceClient("https://example.edu", async () => "token");
    assert.deepEqual(await client.versions(), { lp: "1.63", le: "1.97" });
    assert.deepEqual(await client.courses("1.63"), [
      { id: 10, code: "CSCI-570", name: "Algorithms" },
    ]);
    assert.equal(requests[0]?.authorization, null);
    assert.equal(requests[1]?.authorization, "Bearer token");
    assert.equal(requests[2]?.url.searchParams.get("bookmark"), "10");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("strips bearer auth when a file redirects to an external HTTPS origin", async () => {
  const originalFetch = globalThis.fetch;
  const authorizations: Array<string | null> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    authorizations.push(new Headers(init?.headers).get("authorization"));
    if (url.origin === "https://example.edu") {
      return new Response(null, {
        status: 302,
        headers: { location: "https://cdn.example.net/file.pdf" },
      });
    }
    return new Response("pdf", {
      status: 200,
      headers: { "content-type": "application/pdf" },
    });
  }) as typeof fetch;

  try {
    const client = new BrightspaceClient("https://example.edu", async () => "secret-token");
    const response = await client.file("1.97", 10, 20);
    assert.equal(await response.text(), "pdf");
    assert.deepEqual(authorizations, ["Bearer secret-token", null]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
