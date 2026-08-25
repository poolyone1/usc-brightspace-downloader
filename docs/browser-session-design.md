# Browser-session authentication design

Status: implementation proposal for `browser-session-poc`.

This branch explores a fallback for users who cannot obtain a USC-registered OAuth application. The user signs in to USC Brightspace manually in a dedicated browser window, completes Duo, and lets the CLI reuse only the resulting Brightspace session. The tool never collects or stores the USC username, password, Microsoft session, or Duo data.

## Scope and constraints

- macOS first; Node.js 24 and Playwright Chromium.
- Read-only Brightspace content access. Authentication pages naturally perform their own login requests, but the downloader exposes only GET operations for course data.
- Download only visible `ActivityType=File` topics through the existing sync engine.
- Do not bypass hidden content, date restrictions, release conditions, or access controls.
- "Log in once" means once per server-side Brightspace session lifetime. USC or D2L can expire or revoke the session at any time.
- Do not attach to the user's normal Chrome profile. Use an isolated Playwright context so unrelated browser cookies and history never enter the tool.

## User experience

```text
usc-bs auth login --method browser
usc-bs auth status
usc-bs doctor
usc-bs
usc-bs auth logout
```

Default flow when no valid authentication exists:

1. Launch a headed, isolated Chromium window at `https://brightspace.usc.edu/d2l/login`.
2. The user completes USC NetID and Duo manually.
3. Detect return to `brightspace.usc.edu`, then verify the session with a small read-only API request.
4. Filter and encrypt the Brightspace-only session state.
5. Close the login browser and continue the scan/download with the same authenticated context.
6. On later runs, load the encrypted state into a headless context. Reopen the login window only after the server rejects that state.

No password prompt is added to the CLI.

## Session capture

Playwright's `browserContext.storageState()` returns cookies and origin-local storage. Before persistence, apply an allowlist:

```text
Allowed cookie domains:
  brightspace.usc.edu
  .brightspace.usc.edu

Allowed origin:
  https://brightspace.usc.edu

Rejected:
  login.microsoftonline.com
  *.duosecurity.com
  all other domains and origins
```

Do not persist IndexedDB unless a live proof shows that Brightspace requires it. The smallest working session has the lowest exposure.

### Encryption at rest

Store a random 256-bit AES-GCM key in macOS Keychain under service `usc-bs.browser-session-key`. Store only encrypted session data on disk:

```text
~/Library/Application Support/usc-bs/browser-session.enc
```

Envelope format:

```json
{
  "version": 1,
  "createdAt": "ISO-8601 timestamp",
  "origin": "https://brightspace.usc.edu",
  "iv": "base64",
  "tag": "base64",
  "ciphertext": "base64"
}
```

File and parent-directory modes are `0600` and `0700`. Decrypt directly into memory and pass the object to `browser.newContext({ storageState })`; never write plaintext storage state to a temporary file. Logout removes both the encrypted file and its Keychain key.

## Login completion and validation

Avoid DOM selectors tied to USC or Microsoft login pages. They are brittle and could accidentally capture credentials.

Completion test:

1. Wait for a page on the `https://brightspace.usc.edu` origin.
2. Call `/d2l/api/versions/` to confirm the tenant is reachable.
3. Call `/d2l/api/lp/{version}/enrollments/myenrollments/?isActive=true&canAccess=true` inside the browser context.
4. Treat a JSON `200` response as authenticated. Redirects to login, HTML responses, `401`, and `403` mean the session is not ready.

The login command has a ten-minute timeout and supports Ctrl-C. Closing the browser without a valid API response saves nothing.

## Transport architecture

The current `BrightspaceClient` assumes a Bearer token. Refactor it behind a small read-only transport interface:

```ts
interface ReadOnlyTransport {
  json<T>(url: URL): Promise<T>;
  download(url: URL, targetPartPath: string): Promise<DownloadMetadata>;
  close(): Promise<void>;
}
```

Implementations:

- `OAuthTransport`: current native `fetch` implementation with Bearer authorization.
- `BrowserSessionTransport`: Playwright browser context using Brightspace session cookies.

Course discovery, TOC traversal, path sanitization, hashing, manifests, conflict handling, retries, and the future TUI remain transport-independent.

## API and file requests

### JSON APIs

Use `browserContext.request.get()` for the small JSON responses used by version discovery, enrollments, and TOC. Reject login HTML and cross-origin redirects. Never log request cookies or response `Set-Cookie` headers.

### File downloads

Do not use `APIResponse.body()` for course files because it buffers the full file in memory.

Preferred implementation:

1. Open the official read-only file route in an authenticated page:
   `/d2l/api/le/{version}/{courseId}/content/topics/{topicId}/file`.
2. Wait for Playwright's `download` event.
3. Pipe `download.createReadStream()` to the existing `.part` file while calculating SHA-256.
4. Verify the reported size when available and atomically rename on success.

This lets Chromium own cookie handling and large-file streaming. Limit active browser download pages to three.

Fallback experiment, only if the download event is not emitted:

- Export only Brightspace cookies from the context and make a Node `fetch` request with a synthesized `Cookie` header.
- Follow same-origin redirects with cookies; follow external HTTPS redirects without cookies.
- Do not depend on undocumented D2L frontend bearer tokens.

## Expiration and error behavior

- Before every sync, validate the restored session with `myenrollments`.
- On a login redirect, HTML response, `401`, or session-specific `403`, stop scheduling new work and request manual login.
- A course-specific `403` is a permission result, not necessarily session expiration; continue with other courses.
- Do not repeatedly retry invalid sessions.
- Do not silently fall back from OAuth to browser-session auth. The configured authentication method is explicit.

## Configuration changes

Extend the config with a versioned authentication block:

```json
{
  "auth": {
    "method": "browser-session"
  }
}
```

OAuth configuration remains supported as `"method": "oauth"`. Existing OAuth configs are migrated in memory and rewritten only after explicit configuration changes.

## Logging and telemetry

- No telemetry.
- Redact `Cookie`, `Set-Cookie`, authorization headers, OAuth codes, tokens, and session-state contents.
- Normal logs may include course IDs, topic IDs, local paths, response status, and retry timing.
- Debug mode must still redact secrets.

## Proof gate before full implementation

The browser-session approach is accepted only after all five checks succeed against USC:

1. Manual NetID + Duo login completes in headed Playwright Chromium.
2. A new process restores the encrypted session and lists enrollments without opening a browser.
3. It retrieves the TOC for one accessible course.
4. It streams one File Topic to disk through the official file endpoint and verifies SHA-256.
5. An expired or deliberately corrupted session fails closed and reopens manual login without exposing credentials.

If cookie-authenticated API calls fail after login, stop and document the result before using any undocumented Brightspace token mechanism.

## Implementation sequence

1. Add Playwright and install Chromium.
2. Introduce `ReadOnlyTransport` and keep OAuth tests passing.
3. Add session filtering, AES-GCM encryption, and Keychain storage tests.
4. Implement headed login and API validation.
5. Implement browser download streaming and the five-step live proof.
6. Add browser-session commands and documentation.
7. Reuse the transport in the default sync command; build the TUI only after the live proof passes.

## Main risks

- USC may shorten or bind Brightspace sessions, requiring more frequent manual login.
- Microsoft or Duo may refuse an automated Chromium build; the tool must not attempt to evade those controls.
- A D2L deployment may accept browser cookies for the UI but require another request token for APIs.
- Browser downloads may behave differently for inline HTML/PDF content; both attachment and inline responses need live tests.
- Session state is a password-equivalent credential even after filtering, so encryption and redaction are release blockers.
