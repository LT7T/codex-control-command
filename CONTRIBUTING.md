# Contributing

Issues and pull requests are welcome. Keep changes Windows-focused, dependency-light, and compatible with PowerShell 5.1 and Node.js 20 or later.

Before submitting a change:

1. Run `npm test`.
2. Run `powershell -NoProfile -ExecutionPolicy Bypass -File tests/Test-Package.ps1` on Windows.
3. Confirm that the server still binds only to `127.0.0.1`.
4. Do not commit task IDs, usernames, personal paths, logs, prompts, tokens, or account identifiers.
5. Exercise the real Send path only with an explicitly provided test task and message.

Changes to process shutdown matching must retain executable-path checks against the installed OpenAI Codex package or known Codex runtime directories.
