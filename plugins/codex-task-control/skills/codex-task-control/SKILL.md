---
name: codex-task-control
description: Install, open, update, or operate Codex Command and Control on Windows; recover an idle finished Codex task whose Send button is disabled; inspect or analyze privacy-safe token, context, timing, tool, outcome, storage, activity, and usage statistics; advise on Codex efficiency; or deliberately stop all local Codex work. Do not use it to bypass an active turn, approval request, or usage limit.
---

# Codex Command and Control

Use the local control centre as a bounded workaround for a disabled follow-up composer. It does not repair or modify the signed Codex desktop UI.

## Route the request

- For first installation or an update from GitHub, read [references/install-and-update.md](references/install-and-update.md).
- To open the installed control centre, run `%LOCALAPPDATA%\CodexTaskControl\Start-ControlCenter.ps1 -NoOpen`, verify `http://127.0.0.1:47651/health`, and open the panel in the current Codex browser. When the current task ID is known, append `?threadId=<id>` so selection is exact; otherwise open the base URL and require the user to choose by title. The picker loads 20 current user tasks at a time and appends more as it is scrolled; archived and delegated subagent sessions are not follow-up targets.
- For a stuck follow-up, confirm the selected title and that Codex reports the task idle with a latest turn of completed, interrupted, or failed. Send only the user's supplied message. Never manufacture a live test prompt.
- The follow-up editor has a custom right-click menu backed by the local Windows spell checker. If asked to verify it, use disposable text, require the expected suggestion, clear the editor afterward, and never inspect or select Paste because that could request access to the user's clipboard.
- For usage or task status, use the panel overview. Use **Usage intelligence** for per-turn tokens, cached input, model calls, context occupancy, timing, tools, compactions, comparisons, and outcome tags. Use **Advanced stats** for local history storage, largest tasks, and recent activity.
- When the user asks Codex to inspect or advise on usage, first identify the exact local task when task-specific advice is wanted. Then run the installed privacy-safe reporter:

  ```powershell
  & "$env:LOCALAPPDATA\CodexTaskControl\Get-CodexUsageStats.ps1" -ThreadId <task-id> -Pretty
  ```

  For a bounded cross-task view, run:

  ```powershell
  & "$env:LOCALAPPDATA\CodexTaskControl\Get-CodexUsageStats.ps1" -Days 30 -MaxSessions 50 -Pretty
  ```

  Base recommendations on reported numeric evidence. Compare like-for-like work and separate turn model tokens, subscription usage, storage, duration, and user-rated outcomes. Do not describe fewer tokens as automatically better.
- Treat unavailable values as unavailable. Raw token totals are not necessarily subscription credits or billed API cost. Reasoning tokens are included within output tokens. Never infer quota, tokens, cost, or active context from local file size.
- Only invoke **End all local Codex work** when the user explicitly asks. Explain that it interrupts local work and closes Codex plus the control centre; it does not cancel cloud tasks.

## Invariants

- Keep the service on `127.0.0.1`; never expose it through a proxy or non-loopback bind.
- Preserve the user's existing tasks and session files. Do not clear caches, reset app data, delete sessions, or patch the AppX package.
- A grey Send control is not proof that a task is active, blocked, or rate-limited. Keep status, approval, error, and usage checks distinct.
- Never infer the focused sidebar task from recency. A bare localhost URL must require manual selection; only an explicit `threadId` URL may preselect.
- After starting the service for an in-app request, both verify health and open the panel; do not merely print its URL.
- The raw-statistics reporter must remain local and content-free. Do not modify it to emit prompt text, command text, file paths, tool arguments, tool outputs, account identifiers, or hidden reasoning.
- Spelling must remain local and single-word only. Do not replace it with a remote spelling service or log checked words or suggestions.
- Optional outcome annotations are user-supplied metadata. Do not invent ratings, acceptance, corrections, categories, strategies, or review time.
