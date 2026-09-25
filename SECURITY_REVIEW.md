# Security review for 0.3.1

Review date: 2026-09-25

This is a maintainer review of the public source package, not an independent penetration test or a guarantee that the software is vulnerability-free.

## Result

No known critical, high, or medium-severity issue remains open in the reviewed 0.3.1 package.

The review covered the loopback HTTP server, browser page, Codex named-pipe bridge, installer, uninstaller, start and stop scripts, local-work shutdown, usage parser and reporter, annotations store, Windows spelling bridge, plugin manifest, documentation, tests, and GitHub Actions workflow.

## Controls checked

- The server binds to `127.0.0.1`; the listen host is not configurable.
- API requests require the exact loopback origin, JSON content type, and a fresh 256-bit launch token embedded only in the nonce-protected local page.
- The page uses a restrictive Content Security Policy, does not load remote scripts or styles, and inserts variable task, project, reply, and spelling text with text-only DOM APIs.
- Request bodies and follow-up size are bounded. Task and turn identifiers are validated as UUIDs.
- A follow-up is sent only after a fresh Codex status check says the exact task is idle and its latest turn has finished.
- The private Codex pipe name is allow-listed and tool names are fixed by the application.
- PowerShell and Node child processes use fixed executable and script paths with argument arrays. No shell-string evaluation or user-controlled command interpolation is used.
- The spelling helper accepts a single bounded word, reads at most 4096 input bytes, caps output and runtime, validates input twice, sanitizes suggestions, and contacts only the Windows Spell Checking API.
- Usage reports are produced from an allow-listed numeric and categorical schema. Tests confirm that prompts, replies, hidden reasoning, command text, file paths, tool arguments, tool outputs, and account identifiers are absent.
- Public showcase mode replaces visible task titles, project labels and task IDs with neutral examples and disables JSON export.
- Annotation input is bounded and its local store has a 4 MiB read limit. Writes use a same-directory temporary file followed by rename.
- Stop and uninstall operations resolve and check their targets. The full local-work stop requires an exact confirmation phrase and matches executable paths rather than process names alone.
- The repository has no runtime package dependencies. GitHub Actions dependencies are pinned to full commit hashes with read-only repository permission.
- Package tests reject all-interface binds, private development paths, known task IDs, and unresolved placeholders.

## Hardening completed during this review

- Replaced the editor's generic context menu with a text-only custom menu, preventing unrelated browser entries while retaining explicit clipboard access only when the user chooses Paste.
- Changed the spelling helper from an unbounded read followed by a size check to a genuinely bounded standard-input read.
- Removed locale-sensitive cache-key construction that could reject syntactically accepted language tags inside Node's locale functions.
- Added a maximum annotation-store size.
- Kept the 50-history default and full-history action streaming, locally initiated, and bounded to the chosen time and archive scope.
- Pinned the GitHub Actions checkout and Node setup actions to full commit hashes.
- Added unit, package, PowerShell syntax, local spelling, inline-script, and privacy regression checks.
- Split server startup from Codex app activation so the loopback service becomes healthy before a cold app launch, retained the installer-validated Node.js path for stale desktop environments, and kept runtime validation at Node.js 20 or later.
- Added a bounded local startup-error report and visible shortcut failure message without changing the loopback bind, request-token, origin, or sending boundaries.

## Residual risks and trust boundaries

- The app relies on a private Codex desktop named-pipe interface. A future Codex update may break compatibility or change returned data.
- Any process already running as the same Windows user can generally inspect that user's local files, processes, and loopback traffic. The launch token and origin checks defend against ordinary cross-site requests; they are not a sandbox against local malware.
- The source and PowerShell scripts are not code-signed. Users should install from a release they trust and review updates before running them.
- Spelling quality and language availability depend on the dictionaries installed in Windows.
- **End all local Codex work** is intentionally disruptive. It can interrupt unsaved local work after its typed confirmation, though it does not delete histories or project files and does not cancel cloud tasks.
- **Analyze all** can read several gigabytes of local history and may take time on large installations. It is explicit, read-only, streaming, and limited to the selected analysis scope.
- Task titles, project labels, usage patterns, and task IDs appear in the local page and content-free reporter. Users should not publish screenshots or redirected reports without reviewing them.

Security reports should be sent privately to the repository maintainer. Do not put prompts, tokens, task IDs, local paths, or sensitive logs in a public issue.
