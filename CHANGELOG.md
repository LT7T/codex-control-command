# Changelog

## 0.3.0 - 2026-09-24

- Renamed the product to **Codex Command and Control** while retaining the existing internal IDs and installation path for upgrade compatibility.
- Migrated the Start Menu and desktop shortcut branding and removed legacy branded shortcuts during installation.
- Added a privacy-safe public showcase mode that replaces visible task titles, project labels and task IDs with neutral examples.
- Changed recent Usage Intelligence to analyze the 50 most recently updated eligible histories regardless of their combined size.
- Added an explicit **Analyze all** action for every eligible non-archived history in the configured time window.
- Added clearer coverage reporting for analyzed files, remaining files, time window and scanned storage.
- Updated installation instructions and repository links for `LT7T/codex-control-command`.
- Added approved screenshots for all three application tabs.

## 0.2.2 - 2026-09-24

- Replaced the follow-up editor's generic browser context menu with a focused writing menu.
- Added Windows-local spelling suggestions while preserving red misspelling underlines.
- Added Undo, Redo, Cut, Copy, Paste, and Select all without the unrelated `Select password` entry.
- Bounded and validated spelling requests, helper output, execution time, and in-memory caching.
- Added a plain-language human guide, expanded Codex-agent verification steps, and documented the release security review.

## 0.2.1 - 2026-09-24

- Expanded the task picker beyond the Codex host's 50-result ceiling by combining live task state with the local current-task index.
- Load the first 20 tasks immediately and append 20 more near the bottom of the picker or when **Load more** is selected.
- Preserve exact task-aware URL selection even when the requested task is older than the first page.
- Exclude archived tasks and delegated subagent sessions from the follow-up picker.
- Added pagination, history-merging, duplicate-title-update, archive-filter, and browser-script regression tests.

## 0.2.0 - 2026-09-24

- Added privacy-safe per-turn token accounting for input, cached input, uncached input, output, reasoning and aggregate totals.
- Added model-generation counts, model and reasoning-effort breakdowns, context occupancy, compactions, task timing, tool actions, failures and file-change counts.
- Added a Usage Intelligence dashboard with turn-cost trends, project/model/tool breakdowns, a detailed turn ledger and evidence-based observations.
- Added Prompt Lab side-by-side turn comparison and optional local outcome tags for quality, acceptance, corrections, task category, strategy and review time.
- Added a bounded streaming parser with in-memory caching, configurable analysis windows, file-count limits and byte limits.
- Added `Get-CodexUsageStats.ps1` and JSON output so a Codex task can inspect raw privacy-safe statistics and advise on efficiency.
- Added JSON export from the dashboard and numeric prompt-size capture for follow-ups sent through the control centre.
- Kept prompt text, command text, file paths, tool arguments, tool outputs and account identifiers out of statistics and exports.

## 0.1.4 - 2026-09-24

- Resolve abbreviated largest-history entries through Codex when their titles are no longer in the recent-task list.
- Added project names to task choices and statistics, with a consistent colour for each project.
- Replaced the native task selector with a project-aware picker.
- Removed the bare-page task-context explanation from the control screen.

## 0.1.3 - 2026-09-24

- Added **Top 5% locally** and **Top 1% locally** markers to the largest-history table.
- Added locally calculated 95th- and 99th-percentile storage reference points.
- Explicitly states that local history size is not a proven task-failure threshold.

## 0.1.2 - 2026-09-24

- Renamed the task selector to **Codex Task Selection**.
- Removed the extra task-confirmation checkbox; Send remains disabled until a task is selected and while that task is active.
- Added an Advanced Stats page for local task-history counts, current and archived storage, largest histories, recent activity, six-month storage activity, known workspaces, and signed-in Codex usage limits.
- Kept bare localhost pages unselected by default and exact task-aware links preselected.

## 0.1.1 - 2026-09-24

- Removed unsafe most-recent-task auto-selection when the panel is opened at a bare localhost URL.
- Added an explicit task confirmation gate before Send can be enabled.
- Kept exact automatic selection when Codex opens a task-aware URL containing `?threadId=<id>`.

## 0.1.0 - 2026-09-24

- Added the loopback-only Codex Command and Control centre for Windows.
- Added safe recent-task discovery so a copied task deep link is normally unnecessary.
- Added follow-up preflight checks, duplicate-send protection, task status, and reply refresh.
- Added Codex usage and local task statistics.
- Added start, stop, install, uninstall, and full local-work shutdown controls.
- Added a portable Codex plugin and agent-facing installation workflow.
