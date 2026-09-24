# Instructions for a Codex agent

Use this procedure when a user asks you to install Codex Command and Control for them. The outcome is an installed, healthy local control centre opened inside the user's current Codex task. Installation does not authorize sending a test prompt or interrupting other tasks.

## 1. Preflight

1. Confirm the computer is running Windows.
2. Confirm the `OpenAI.Codex` desktop package is installed.
3. Confirm Node.js 20 or later is available.
4. Read `SECURITY.md`, `PRIVACY.md`, `plugins/codex-task-control/scripts/Install-CodexTaskControl.ps1`, `plugins/codex-task-control/app/ControlCenter.mjs`, and `plugins/codex-task-control/app/Stop-AllLocalCodexWork.ps1` before running the installer.
   Review `SpellingService.mjs` and `Get-SpellingSuggestions.ps1` as security-sensitive input-handling code. Confirm the helper path is fixed, the request is passed through standard input rather than command interpolation, input and output are bounded, and the helper uses the local Windows spell checker without a network request.
   Also review `UsageIntelligence.mjs`, `UsageAnnotations.mjs`, and `Get-CodexUsageStats.mjs`; these files define which local session fields are read and which fields are allowed into reports.
5. If Node.js is absent, stop and ask before installing additional system software. Do not silently download an executable.

## 2. Acquire safely

Clone `https://github.com/LT7T/codex-control-command` into a dedicated bounded directory, preferably `%LOCALAPPDATA%\CodexTaskControlSource`.

If that directory already exists:

- confirm it is a Git repository;
- confirm its `origin` is this repository;
- preserve local changes;
- use a fast-forward-only pull.

Never recursively replace an unrelated directory.

## 3. Install

From the repository root, run:

```powershell
& '.\plugins\codex-task-control\scripts\Install-CodexTaskControl.ps1' -Start -NoBrowser
```

The installer should report `%LOCALAPPDATA%\CodexTaskControl`, the config path, and the shortcuts it created.

## 4. Verify

Read `http://127.0.0.1:47651/health`. Require all of the following:

- HTTP 200;
- `app` equals `codex-task-control`;
- the expected release version;
- host `127.0.0.1`.

Open the task picker once and confirm it reports the full current-task total. When there are more than 20 tasks, scroll to the bottom and confirm the next page is appended rather than replacing the first page.

Verify the agent-readable report shape without printing a complete report into the conversation:

```powershell
$report = & "$env:LOCALAPPDATA\CodexTaskControl\Get-CodexUsageStats.ps1" -Days 1 -MaxSessions 1 | ConvertFrom-Json
$report | Select-Object app, report, schemaVersion, @{Name='PromptTextIncluded';Expression={$_.privacy.promptTextIncluded}}
```

Require `app: codex-task-control`, `report: usage-intelligence`, the expected schema version, and `promptTextIncluded: false`.

Verify spelling without sending anything:

1. Open the installed page in the internal browser.
2. Put the disposable text `This is speling.` in the follow-up box.
3. Place the caret in `speling`, right-click it, and require a custom menu containing `spelling` plus Undo, Redo, Cut, Copy, Paste, and Select all. The unrelated `Select password` entry must not be present.
4. Choose `spelling`, confirm the box now reads `This is spelling.`, and then clear the box.
5. Do not select Paste during verification and do not inspect or expose the user's clipboard.

Do not treat a listening port alone as proof that the expected app owns it.

## 5. Open it in the correct Codex task

Use the Codex task-list capability to identify the exact task making the installation request. Prefer a direct match on the current task's title, host, and workspace. Do not assume the first active task is always the caller when more than one task is running.

When the ID is confidently identified, open this URL in the current task's internal Codex browser:

```text
http://127.0.0.1:47651/?threadId=<current-task-id>
```

If the ID is ambiguous, open `http://127.0.0.1:47651/` and tell the user to choose the intended task by title. A bare URL intentionally selects nothing. Do not guess and send.

## 6. Report completion

Tell the user:

- where the app was installed;
- that the health check passed;
- which task title is selected, or that selection needs confirmation;
- that the Start and End All Local Codex Work shortcuts were created;
- that the privacy-safe raw usage reporter passed its shape check;
- that the local spelling menu passed without reading the clipboard or sending a message;
- that no test message was sent and no task was stopped.

Do not claim the built-in Codex Send button was repaired. This tool is a local workaround.
