import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  dashboardSummary,
  projectLabelForTask,
  sessionStorageSummary,
  taskPageSummary,
  usageSummary,
  validateConfig,
  VERSION,
} from '../plugins/codex-task-control/app/ControlCenter.mjs';
import { localTaskHistoryFromRecords } from '../plugins/codex-task-control/app/CodexHostBridge.mjs';
import { sanitizeSpellingResult, validateSpellingRequest } from '../plugins/codex-task-control/app/SpellingService.mjs';

test('default config is bounded and loopback-friendly', () => {
  const config = validateConfig();
  assert.equal(config.port, 47651);
  assert.equal(config.recentTaskLimit, 20);
  assert.equal(config.analyticsWindowDays, 30);
  assert.equal(config.analyticsMaxSessions, 50);
  assert.equal(config.measurePromptSize, false);
  assert.equal(config.enableEndLocalWork, true);
});

test('invalid configuration is rejected', () => {
  assert.throws(() => validateConfig({ port: 80 }), /port/);
  assert.throws(() => validateConfig({ recentTaskLimit: 51 }), /recentTaskLimit/);
  assert.throws(() => validateConfig({ analyticsWindowDays: 0 }), /analyticsWindowDays/);
  assert.throws(() => validateConfig({ analyticsMaxSessions: 1001 }), /analyticsMaxSessions/);
  assert.throws(() => validateConfig({ measurePromptSize: 'yes' }), /measurePromptSize/);
  assert.throws(() => validateConfig({ taskTokenBudget: -1 }), /taskTokenBudget/);
  assert.throws(() => validateConfig({ modelPricingUsdPerMillion: { model: { input: 1, cachedInput: 1 } } }), /model\.output/);
  assert.throws(() => validateConfig({ enableEndLocalWork: 'yes' }), /enableEndLocalWork/);
});

test('usage summary omits account identifiers and computes remaining percentage', () => {
  const summary = usageSummary({
    accountId: 'private-account-id',
    ordinaryUsageAllowed: true,
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 37, windowDurationMins: 10080, resetsAt: 1800000000 },
        planType: 'example',
      },
    },
    rateLimitResetCredits: { availableCount: 1 },
  });
  assert.deepEqual(summary, {
    allowed: true,
    usedPercent: 37,
    remainingPercent: 63,
    windowDurationMins: 10080,
    resetsAt: 1800000000,
    planType: 'example',
    rateLimitReachedType: null,
    resetCreditsAvailable: 1,
  });
  assert.equal(JSON.stringify(summary).includes('private-account-id'), false);
});

test('dashboard keeps local Codex tasks, deduplicates pinned tasks, and sorts recent first', () => {
  const olderSeconds = 1_790_000_000;
  const newerMilliseconds = 1_790_000_100_000;
  const payload = {
    threads: [
      { id: '11111111-1111-1111-1111-111111111111', kind: 'codex', hostId: 'local', title: 'Older', status: 'idle', updatedAt: olderSeconds },
      { id: '22222222-2222-2222-2222-222222222222', kind: 'codex', hostId: 'local', title: 'Newer', status: 'active', updatedAt: newerMilliseconds },
      { id: '33333333-3333-3333-3333-333333333333', kind: 'chatgpt', title: 'Exclude chat', status: 'idle', updatedAt: newerMilliseconds + 1 },
    ],
    pinnedThreads: [
      { id: '11111111-1111-1111-1111-111111111111', kind: 'codex', hostId: 'local', title: 'Duplicate', status: 'notLoaded', updatedAt: olderSeconds - 1 },
    ],
  };
  const dashboard = dashboardSummary(payload, {}, 20);
  assert.deepEqual(dashboard.tasks.map((item) => item.title), ['Newer', 'Older']);
  assert.equal(dashboard.counts.active, 1);
  assert.equal(dashboard.counts.idle, 1);
  assert.equal(dashboard.counts.total, 2);
  assert.equal(dashboard.counts.shown, 2);
});

test('task picker pages through the complete local task history twenty at a time', () => {
  const history = Array.from({ length: 45 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    title: `Task ${index}`,
    status: 'notLoaded',
    updatedAt: 10_000 - index,
    cwd: null,
    projectId: null,
  }));
  const first = dashboardSummary({ threads: [], pinnedThreads: [] }, {}, 20, null, history, history[44].id);
  assert.equal(first.tasks.length, 21);
  assert.equal(first.tasks.at(-1).id, history[44].id);
  assert.deepEqual(first.taskPage, {
    offset: 0,
    pageSize: 20,
    returned: 20,
    nextOffset: 20,
    total: 45,
    hasMore: true,
  });

  const second = taskPageSummary({ threads: [], pinnedThreads: [] }, history, null, 20, 20);
  const final = taskPageSummary({ threads: [], pinnedThreads: [] }, history, null, 40, 20);
  assert.equal(second.tasks.length, 20);
  assert.equal(second.taskPage.nextOffset, 40);
  assert.equal(second.taskPage.hasMore, true);
  assert.equal(final.tasks.length, 5);
  assert.equal(final.taskPage.nextOffset, 45);
  assert.equal(final.taskPage.hasMore, false);
});

test('local task history excludes archived and subagent sessions while keeping untitled user tasks', () => {
  const namedId = '11111111-1111-4111-8111-111111111111';
  const untitledId = '22222222-2222-4222-8222-222222222222';
  const archivedId = '33333333-3333-4333-8333-333333333333';
  const subagentId = '44444444-4444-4444-8444-444444444444';
  const tasks = localTaskHistoryFromRecords([
    { id: namedId, thread_name: 'Old title', updated_at: '2026-09-23T00:00:00Z' },
    { id: namedId, thread_name: 'Renamed task', updated_at: '2026-09-24T00:00:00Z' },
    { id: archivedId, thread_name: 'Archived task', updated_at: '2026-09-24T00:00:00Z' },
  ], [
    { threadId: namedId, updatedAt: 100, archived: false, metadata: { cwd: 'C:\\work', thread_source: 'user' } },
    { threadId: untitledId, updatedAt: 200, archived: false, metadata: { cwd: 'C:\\scratch', thread_source: 'user' } },
    { threadId: archivedId, updatedAt: 300, archived: true, metadata: { thread_source: 'user' } },
    { threadId: subagentId, updatedAt: 400, archived: false, metadata: { thread_source: 'subagent', source: { subagent: {} } } },
  ], {
    'thread-project-assignments': { [namedId]: { projectKind: 'local', projectId: 'project-1' } },
    'local-projects': { 'project-1': { id: 'project-1', name: 'Example project' } },
    'pinned-thread-ids': [namedId],
  });
  assert.deepEqual(tasks.map((task) => task.id), [namedId, untitledId]);
  assert.equal(tasks[0].title, 'Renamed task');
  assert.equal(tasks[0].projectLabel, 'Example project');
  assert.equal(tasks[0].pinned, true);
  assert.equal(tasks[1].title, 'Task 22222222');
});

test('project labels resolve by project id, workspace path, or projectless fallback', () => {
  const projects = {
    projects: [
      { projectId: 'project-1', label: 'Alpha project', path: 'C:\\work\\alpha' },
      { projectId: 'project-2', label: 'Beta project', path: 'C:\\work\\beta' },
    ],
  };
  assert.equal(projectLabelForTask({ projectId: 'project-2', cwd: 'C:\\elsewhere' }, projects), 'Beta project');
  assert.equal(projectLabelForTask({ cwd: 'c:/work/alpha/' }, projects), 'Alpha project');
  assert.equal(projectLabelForTask({ cwd: 'C:\\scratch' }, projects), 'Projectless');
});

test('storage summary aggregates session files without reading prompt content', () => {
  const now = Date.UTC(2026, 8, 24, 12);
  const firstId = '11111111-1111-1111-1111-111111111111';
  const secondId = '22222222-2222-2222-2222-222222222222';
  const summary = sessionStorageSummary([
    { threadId: firstId, bytes: 100, updatedAt: now - 1000, archived: false },
    { threadId: firstId, bytes: 50, updatedAt: now - 2000, archived: false },
    { threadId: secondId, bytes: 500, updatedAt: now - (10 * 86400000), archived: true },
  ], {
    threads: [{ id: firstId, kind: 'codex', hostId: 'local', title: 'Known task', status: 'idle', updatedAt: now, cwd: 'C:\\work' }],
  }, now, { projects: [{ projectId: 'project-1', label: 'Test project', path: 'C:\\work' }] });
  assert.equal(summary.taskCount, 2);
  assert.equal(summary.sessionFileCount, 3);
  assert.equal(summary.totalBytes, 650);
  assert.equal(summary.currentBytes, 150);
  assert.equal(summary.archivedBytes, 500);
  assert.equal(summary.averageBytes, 325);
  assert.equal(summary.medianBytes, 325);
  assert.equal(summary.p95Bytes, 500);
  assert.equal(summary.p99Bytes, 500);
  assert.equal(summary.recent.day, 1);
  assert.equal(summary.recent.week, 1);
  assert.equal(summary.recent.month, 2);
  assert.equal(summary.knownWorkspaceCount, 1);
  assert.equal(summary.largest[0].threadId, secondId);
  assert.equal(summary.largest[1].title, 'Known task');
  assert.equal(summary.largest[1].projectLabel, 'Test project');
});

test('release version is semantic', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('spelling requests accept a single bounded word and sanitize helper output', () => {
  assert.deepEqual(validateSpellingRequest({ word: 'mother-in-law', language: 'en-AU', limit: 4 }), {
    word: 'mother-in-law',
    language: 'en-AU',
    limit: 4,
  });
  assert.deepEqual(validateSpellingRequest({ word: 'l’été', language: 'fr-FR' }), {
    word: 'l’été',
    language: 'fr-FR',
    limit: 6,
  });
  assert.throws(() => validateSpellingRequest({ word: 'two words', language: 'en-AU' }), /one word/);
  assert.throws(() => validateSpellingRequest({ word: 'spelling', language: '../bad' }), /language/);
  assert.throws(() => validateSpellingRequest({ word: 'spelling', language: 'en-AU', limit: 99 }), /limit/);

  assert.deepEqual(sanitizeSpellingResult({
    available: true,
    language: 'en-AU',
    misspelled: true,
    suggestions: ['spelling', 'spelling', 'spellings', 'bad\u0000value'],
  }, 2), {
    available: true,
    language: 'en-AU',
    misspelled: true,
    suggestions: ['spelling', 'spellings'],
  });
});

test('bare panel requires a task selection and exposes advanced stats', () => {
  const html = fs.readFileSync(new URL('../plugins/codex-task-control/app/public/index.html', import.meta.url), 'utf8');
  assert.match(html, /Choose a Codex task/);
  assert.match(html, /Codex Task Selection/);
  assert.match(html, /id="send" class="primary" disabled/);
  assert.match(html, /Advanced stats/);
  assert.match(html, /Usage intelligence/);
  assert.match(html, /Prompt Lab/);
  assert.match(html, /Turn-cost ledger/);
  assert.match(html, /Get-CodexUsageStats\.ps1/);
  assert.match(html, /api\/intelligence/);
  assert.match(html, /api\/annotations/);
  assert.match(html, /Top 5% locally/);
  assert.match(html, /No proven file-size threshold/);
  assert.match(html, /taskPickerButton/);
  assert.match(html, /loadMoreTasks/);
  assert.match(html, /api\/tasks/);
  assert.match(html, /All \$\{taskPaging\.total/);
  assert.match(html, /project-pill/);
  assert.match(html, /spellcheck="true"/);
  assert.match(html, /editorContextMenu/);
  assert.match(html, /contextmenu/);
  assert.match(html, /addEventListener\('input', closeEditorContextMenu\)/);
  assert.match(html, /api\/spelling/);
  assert.match(html, /Spelling looks correct/);
  assert.match(html, /showcaseMode/);
  assert.match(html, /showcase=public|query\.get\('showcase'\) === 'public'/);
  assert.match(html, /Local task ·/);
  assert.match(html, /Example project/);
  assert.match(html, /id="analyzeAllUsage"/);
  assert.match(html, /Analyze all \$\{eligibleFiles\}/);
  assert.match(html, /50 most recent local records/);
  assert.match(html, /Codex Command and Control/);
  assert.doesNotMatch(html, /Codex Task Control/);
  assert.doesNotMatch(html, /Select password/);
  assert.doesNotMatch(html, /This page was opened without task context/);
  assert.match(html, /api\/stats/);
  assert.doesNotMatch(html, /confirmTask/);
  assert.doesNotMatch(html, /confirmed: true/);
  assert.doesNotMatch(html, /localStorage/);
  assert.doesNotMatch(html, /tasks\[0\]\.id/);
});

test('dashboard inline script parses and element ids are unique', () => {
  const html = fs.readFileSync(new URL('../plugins/codex-task-control/app/public/index.html', import.meta.url), 'utf8');
  const marker = '<script nonce="__TASK_CONTROL_NONCE__">';
  const start = html.indexOf(marker) + marker.length;
  const script = html.slice(start, html.indexOf('</script>', start)).replace('__TASK_CONTROL_TOKEN__', '"test-token"');
  assert.doesNotThrow(() => new Function(script));
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});
