# Security

Codex Command and Control is a local Windows utility. It binds only to `127.0.0.1`, creates a fresh in-memory request token on every launch, checks request origins and content types, limits request sizes, and does not store prompt text.

The editor's spelling route accepts one bounded Unicode word and a validated language tag. The Node service launches a fixed helper path with a fixed PowerShell executable and passes JSON through standard input; no user-controlled text is placed in a command line. The helper independently validates its input, caps input and output, has a timeout, and uses the Windows Spell Checking API locally. Suggestions are sanitized before they reach the page. No remote spelling service is contacted.

Usage Intelligence reads local Codex session files with a streaming parser and emits an allow-listed report schema. Content-bearing fields such as messages, reasoning text, command strings, file paths, tool arguments, and tool results are ignored. Browser usage and annotation routes require the same launch-specific request token and loopback origin checks as the follow-up route. Outcome annotations are written atomically to the dedicated local installation directory.

Recent cross-task analysis is bounded by configurable age, file count, and byte limits. Task-specific analysis may read every local session file matching the exact validated task UUID so archived continuations can be included. The command-line reporter is local-only and prints to standard output; users and agents should avoid redirecting it into public repositories because it still contains local task IDs, titles, project labels, and usage patterns.

The tool connects to the running Codex desktop host through a private local named pipe. That interface is not a stable public API and can change in a later Codex release. Review a new release before installing it, and stop using the tool if its host-connection checks fail.

The **End all local Codex work** action closes the supported Codex desktop package and its known local runtimes. The control centre requires an explicit confirmation phrase before it starts that action. It does not target processes by name alone.

Do not expose the loopback server through port forwarding, a reverse proxy, firewall rule, or a non-loopback bind. Please report security issues privately to the repository maintainer rather than opening a public issue with sensitive logs or task identifiers.

This project is not independently security audited. See [SECURITY_REVIEW.md](SECURITY_REVIEW.md) for the release maintainer's current review scope, checks, and residual risks.
