# USC Brightspace Downloader

English | [简体中文](README.zh-CN.md)

A read-only, local-first CLI and TUI for downloading visible course files from USC Brightspace. It preserves the Brightspace module tree, performs incremental updates, and supports an encrypted browser-session login without asking the CLI for your USC password.

> This is an unofficial proof of concept and is not affiliated with USC or D2L.

## What it does

- Scans every active, accessible Course Offering by default.
- Recursively preserves course and module directories.
- Downloads only visible Brightspace topics with `ActivityType=File`.
- Uses topic IDs, remote modification times, and a local manifest for incremental sync.
- Streams downloads through temporary files, verifies SHA-256, then moves them atomically.
- Preserves local edits by saving a separate remote version instead of overwriting the local file.
- Downloads in parallel; the configurable concurrency defaults to 3 and is capped at 8.
- Provides a multi-level TUI for courses, file trees, file details, sync plans, and progress.
- Distinguishes **Synced**, **New**, and **Remote updated** files.
- Keeps the OAuth + refresh-token backend available as an explicit alternative.

The standard CLI and TUI share the same authentication, sync engine, path rules, and manifest format.

## Requirements

- macOS
- Node.js 24 or newer
- Google Chrome only if you enable password save/autofill

## Install

```bash
git clone https://github.com/poolyone1/usc-brightspace-downloader.git
cd usc-brightspace-downloader
npm install
npx playwright install chromium
npm run check
npm link
```

## Quick start

Configure the default browser-session authentication method:

```bash
usc-bs configure --method browser-session
usc-bs auth login
```

A fresh, isolated Chromium window opens:

1. Complete USC NetID authentication in that window.
2. Approve Duo manually.
3. Wait until Brightspace loads; do not copy cookies or tokens.
4. The CLI verifies the login using a read-only enrollment request, closes the window, and encrypts the Brightspace-only session locally.

Verify access and preview the sync:

```bash
usc-bs auth status
usc-bs doctor
usc-bs --dry-run
```

Sync every accessible course and confirm before downloading:

```bash
usc-bs
```

Sync every accessible course without the confirmation prompt:

```bash
usc-bs -y
```

If USC or D2L expires the saved session, an interactive run opens the login window again.

## Optional Chrome password save and autofill

This flow has been tested with USC's login page. It uses a dedicated Google Chrome profile owned by this tool, never your normal Chrome profile:

```bash
usc-bs auth login --remember-password
```

On the first login:

1. Enter your USC NetID and password normally.
2. Choose **Save** if Chrome offers to save the password.
3. Complete Duo manually.
4. After the CLI reports a successful login, leave the window open for 15 seconds.

On later reauthentication attempts, Chrome can autofill the stored USC credentials. Duo still requires manual approval.

The CLI never reads password fields or Chrome's saved password value. After capturing the encrypted Brightspace session, it clears website cookies and site storage from the dedicated Chrome profile while retaining the Chrome password-manager entry. Do not sign this dedicated profile into a Google account.

Check or remove the feature:

```bash
usc-bs auth status
usc-bs auth forget-password
```

`auth forget-password` deletes the entire dedicated Chrome profile and disables autofill. It keeps the encrypted Brightspace session and downloaded files.

## Multi-level TUI

```bash
usc-bs tui
```

Navigation flow:

```text
Course list → Course file tree → File details
      └────→ Sync plan → Sync progress → Sync result
```

Main controls:

```text
↑/↓       Move
Enter     Open a course, expand a module, or inspect a file
Space     Select a course, module, or file
d         Set the download root for the current course
f         Force-download the current file
1/2/3     Show all / new / remote-updated files
s         Review the sync plan
r         Refresh local sync status
Esc       Go back
q         Quit; during sync, request a safe stop
```

Status rules:

- **New**: no manifest entry exists, or the local file is missing.
- **Remote updated**: the local file exists, but the Brightspace modification time changed.
- **Synced**: the local file exists and its recorded remote modification time is unchanged.

## Common commands

```bash
usc-bs                              # Scan and sync all accessible courses
usc-bs -y                           # Sync all without confirmation
usc-bs --course CSCI-570            # Limit by course ID, code, or name
usc-bs --output "/path/to/courses"  # Override the download root
usc-bs --force                      # Download even when metadata is unchanged
usc-bs tui                          # Open the course/file manager
usc-bs auth status                  # Show local authentication status
usc-bs auth logout                  # Remove the encrypted Brightspace session
usc-bs auth forget-password         # Remove the dedicated Chrome profile
```

`auth logout` removes the encrypted session file and its macOS Keychain key. It preserves downloaded files and the optional Chrome password profile.

## Local data

```text
~/Library/Application Support/usc-bs/config.json
~/Library/Application Support/usc-bs/browser-session.enc
~/Library/Application Support/usc-bs/chrome-login-profile/  # only with password autofill
~/Library/Application Support/usc-bs/tui-profile.json
<download directory>/.usc-bs-manifest.json
```

The browser session is encrypted with AES-256-GCM. Its random key is stored in macOS Keychain, and no plaintext session file is written to disk. Only exact `brightspace.usc.edu` cookies and origin storage are retained in the encrypted session; Microsoft and Duo session data are excluded. The manifest contains no authentication data.

See [the browser-session security design](docs/browser-session-design.md) for implementation details and proof criteria.

## OAuth authentication (optional)

Choose OAuth only if you have a Brightspace application registered by USC and its `client_id` and `client_secret`:

```bash
usc-bs configure --method oauth
usc-bs auth login
```

Required scopes:

- `enrollment:own_enrollment:read`
- `content:toc:read`
- `content:file:read`

The application must also be allowed to issue refresh tokens.

## Safety and current scope

- Downloader course/content requests are read-only.
- The tool does not submit assignments, modify courses, or bypass permissions, release conditions, hidden content, or date restrictions.
- Only visible `ActivityType=File` topics are downloaded.
- Authentication pages perform their normal USC, Microsoft, and Duo login requests.
- USC or D2L may revoke sessions at any time, requiring reauthentication.
