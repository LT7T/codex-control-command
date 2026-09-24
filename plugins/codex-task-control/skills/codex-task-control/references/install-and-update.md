# Install and update

Repository: `https://github.com/LT7T/codex-control-command`

## First installation

1. Confirm the host is Windows and the OpenAI Codex desktop package is installed.
2. Confirm Node.js 20 or later is available. If Node.js is missing, explain the requirement and ask before installing unrelated system software.
3. Clone the repository to a bounded source directory such as `%LOCALAPPDATA%\CodexTaskControlSource`. If that directory already exists, verify its Git remote before updating it; never overwrite an unrelated folder.
4. Review `SECURITY.md`, the installer, the loopback server, the spelling bridge and helper, and the local-work shutdown script before execution.
5. Run:

   ```powershell
   & '.\plugins\codex-task-control\scripts\Install-CodexTaskControl.ps1' -Start -NoBrowser
   ```

6. Verify `http://127.0.0.1:47651/health` reports `app: codex-task-control`.
7. Verify the installed privacy-safe reporter without exposing its full output:

   ```powershell
   & "$env:LOCALAPPDATA\CodexTaskControl\Get-CodexUsageStats.ps1" -Days 1 -MaxSessions 1 | ConvertFrom-Json | Select-Object app, report, schemaVersion
   ```

8. In the internal browser, verify the editor menu using `This is speling.`. Right-click `speling`, require a `spelling` suggestion and the standard edit actions, choose the suggestion, confirm the corrected text, and clear the editor. Do not choose Paste or inspect the user's clipboard.
9. Identify the exact current Codex task with the Codex task-list tool. Open `http://127.0.0.1:47651/?threadId=<current-id>` in the current task's internal browser. If the current ID cannot be established confidently, open the base URL and leave selection to the user.
10. Report the installed location, shortcuts, health result, reporter result, spelling result, and the selected task title. Do not send a test follow-up and do not stop any task during installation.

## Update

1. Verify the existing source checkout remote is the repository above and that no local changes would be overwritten.
2. Pull the requested release or default branch.
3. Rerun the installer. It stops the old control-centre server, replaces application files, and preserves `config.json`.
4. Start without an external browser, verify health, and open the internal panel as described above.

## Optional plugin marketplace installation

The repository also contains a repo marketplace and a portable skill. To make the skill available across supported Codex projects:

```powershell
codex plugin marketplace add LT7T/codex-control-command
codex plugin add codex-task-control@codex-task-control
```

Start a new Codex task after plugin installation or update so the skill is loaded cleanly.
