# Multi-level TUI design

Status: implemented proof of concept on `tui-poc`.

## Isolation

The existing no-argument CLI remains the default full sync. `usc-bs tui` dynamically imports Ink only after the command is selected. CLI and TUI share the same application runtime and event-driven sync engine; the TUI does not access Playwright, OAuth, Keychain, path construction, or manifest persistence directly.

## Screens

1. Course list with per-course synced/new/remote-updated counts and destination.
2. Brightspace module/file tree with tri-state selection and status filters.
3. File detail with remote metadata, selection, force flag, and conflict policy.
4. Sync plan grouped by destination.
5. Concurrent progress and final counts.

## Primary status model

- `new`: no manifest entry or the recorded local file is missing.
- `remote-updated`: local file exists and `LastModifiedDate` differs from the manifest.
- `synced`: local file exists and remote metadata is unchanged.

Local modifications remain a conflict-handling concern in the sync engine rather than a fourth remote-sync status. The engine preserves the local file and writes the remote update separately.

## Safety

- No delete or move operation.
- No remote write request.
- Directory changes cause the target manifest to be evaluated independently; old files remain in place.
- Cancellation stops scheduling new files and lets active streams finish.
- Course destinations are stored separately in `tui-profile.json`; no credentials are stored there.
