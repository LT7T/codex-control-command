# Human guide

Codex Command and Control is a local Windows workaround for a Codex task that has finished but will not accept another prompt through its normal **Send** button. It does not repair or replace Codex. It gives you a separate, local control page that can safely send a follow-up to a finished task.

## The easy way to install it

1. Open a new task in the Codex desktop app.
2. Copy the installation request from the **Easiest installation: ask Codex** section of [README.md](README.md) into that task.
3. Let Codex inspect the project, install the local app, and perform the checks in [CODEX_INSTALL.md](CODEX_INSTALL.md).
4. Codex should open the control centre inside that same task with the correct task already selected.

The installation creates **Start Codex Command and Control** and **End All Local Codex Work** shortcuts. The Start shortcut can also be opened with `Ctrl+Alt+Shift+R`; the End shortcut uses `Ctrl+Alt+Shift+X`.

## Send a follow-up

1. Start Codex Command and Control while the Codex desktop app is open.
2. Check the task title shown in **Codex Task Selection**. If you opened the bare local address yourself, choose the intended task from the list.
3. Wait until the task is no longer marked active.
4. Write the follow-up and select **Send through Codex**.
5. Leave the page open while it checks for the response, or use **Refresh reply** later.

The page never guesses which task you mean when it does not receive an exact task ID. A Codex agent can open a task-aware link so the current task is selected automatically.

## Spelling and the right-click menu

Misspelled words still receive the browser's red underline. Right-click a word in the follow-up box to see spelling suggestions and the normal Undo, Redo, Cut, Copy, Paste, and Select all actions.

Spelling is checked with Windows on the same computer. Only the single word under the cursor is passed from the local page to the local server, and suggestions are kept in memory for up to ten minutes. No spelling text is sent to this repository, its maintainers, or a remote spelling service.

If Windows does not have a suitable spelling language installed, the menu says that suggestions are unavailable. You can still edit and send normally.

## The two stop controls

- **Stop control centre** stops only the local control page. Codex stays open.
- **End all local Codex work** is deliberately broader. After a typed confirmation, it interrupts local Codex work and closes the supported desktop app and local Codex runtimes. It does not delete task history, projects, app data, or caches, and it does not cancel cloud tasks.

## Update

Open the repository folder, get the latest release, and run the installer again. Your existing `config.json` is preserved.

```powershell
git pull --ff-only
& '.\plugins\codex-task-control\scripts\Install-CodexTaskControl.ps1' -Start
```

## Uninstall

Choose **Uninstall Codex Command and Control** from the Start Menu. Uninstall removes the installed local control app and its shortcuts. It does not remove this source repository or any Codex task history.

## If it does not open

1. Confirm the Codex desktop app is open.
2. Run **Start Codex Command and Control** again.
3. Open `http://127.0.0.1:47651/health`. A healthy installation returns a small JSON response naming `codex-task-control` and `127.0.0.1`.
4. If the port was changed in `%LOCALAPPDATA%\CodexTaskControl\config.json`, use that port instead.
5. If the health page works but the task list does not, a Codex desktop update may have changed the private local interface this workaround relies on. Stop using the send function until the project is updated.

For the security boundaries, see [SECURITY.md](SECURITY.md). For exactly what the app reads and retains, see [PRIVACY.md](PRIVACY.md).
