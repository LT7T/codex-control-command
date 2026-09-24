import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aggregateUsageTasks,
  buildUsageIntelligence,
  durationToMilliseconds,
  estimateApiEquivalentCost,
  parseSessionUsage,
  selectUsageFiles,
} from '../plugins/codex-task-control/app/UsageIntelligence.mjs';
import {
  deleteTurnAnnotation,
  readUsageAnnotations,
  recordPendingPromptMeasurement,
  saveTurnAnnotation,
} from '../plugins/codex-task-control/app/UsageAnnotations.mjs';

const threadId = '11111111-1111-1111-1111-111111111111';
const turnId = '22222222-2222-2222-2222-222222222222';

function fixtureEntries() {
  return [
    { timestamp: '2026-09-24T00:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id: threadId, cwd: 'C:\\private\\workspace' } },
    { timestamp: '2026-09-24T00:00:01.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: turnId, root_turn_id: turnId, started_at: 1790208001, model_context_window: 1000, collaboration_mode_kind: 'default' } },
    { timestamp: '2026-09-24T00:00:01.100Z', ordinal: 2, type: 'turn_context', payload: { turn_id: turnId, root_turn_id: turnId, model: 'example-model', effort: 'high', summary: 'PRIVATE SUMMARY' } },
    { timestamp: '2026-09-24T00:00:01.200Z', ordinal: 3, type: 'event_msg', payload: { type: 'item_completed', turn_id: turnId, item: { type: 'UserMessage', content: [{ type: 'input_text', text: 'TOP_SECRET_PROMPT' }] } } },
    { timestamp: '2026-09-24T00:00:02.000Z', ordinal: 4, type: 'token_usage_record', payload: { turn_id: turnId, root_turn_id: turnId, response_id: 'response-1', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10, reasoning_output_tokens: 3, total_tokens: 110 }, turn_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10, reasoning_output_tokens: 3, total_tokens: 110 }, thread_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10, reasoning_output_tokens: 3, total_tokens: 110 } } },
    { timestamp: '2026-09-24T00:00:03.000Z', ordinal: 5, type: 'event_msg', payload: { type: 'item_completed', turn_id: turnId, item: { type: 'CommandExecution', status: 'failed', command: 'PRIVATE COMMAND', duration: { secs: 1, nanos: 500000000 } } } },
    { timestamp: '2026-09-24T00:00:04.000Z', ordinal: 6, type: 'event_msg', payload: { type: 'item_completed', turn_id: turnId, item: { type: 'McpToolCall', status: 'completed', server: 'example', tool: 'lookup', arguments: { secret: true }, result: 'PRIVATE OUTPUT', duration: { secs: 0, nanos: 250000000 } } } },
    { timestamp: '2026-09-24T00:00:05.000Z', ordinal: 7, type: 'event_msg', payload: { type: 'item_completed', turn_id: turnId, item: { type: 'FileChange', status: 'completed', changes: [{ path: 'PRIVATE FILE' }] } } },
    { timestamp: '2026-09-24T00:00:06.000Z', ordinal: 8, type: 'compacted', payload: {} },
    { timestamp: '2026-09-24T00:00:07.000Z', ordinal: 9, type: 'token_usage_record', payload: { turn_id: turnId, root_turn_id: turnId, response_id: 'response-2', usage: { input_tokens: 60, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 2, total_tokens: 70 }, turn_token_usage: { input_tokens: 160, cached_input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 180 }, thread_token_usage: { input_tokens: 160, cached_input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 180 } } },
    { timestamp: '2026-09-24T00:00:08.000Z', ordinal: 10, type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, started_at: 1790208001, completed_at: 1790208008, duration_ms: 7000, time_to_first_token_ms: 900, last_agent_message: 'PRIVATE REPLY' } },
  ];
}

async function withFixture(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-test-'));
  const filePath = path.join(directory, `rollout-${threadId}.jsonl`);
  fs.writeFileSync(filePath, `${fixtureEntries().map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  const stat = fs.statSync(filePath);
  try {
    return await callback({ filePath, threadId, bytes: stat.size, updatedAt: stat.mtimeMs, archived: false }, directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('duration objects convert to milliseconds', () => {
  assert.equal(durationToMilliseconds({ secs: 1, nanos: 500000000 }), 1500);
  assert.equal(durationToMilliseconds(null), 0);
});

test('API-equivalent estimate prices cached input separately and does not double-count reasoning', () => {
  const value = estimateApiEquivalentCost({
    inputTokens: 1000000,
    cachedInputTokens: 800000,
    cacheWriteInputTokens: 0,
    outputTokens: 100000,
    reasoningOutputTokens: 60000,
  }, { input: 10, cachedInput: 1, output: 20 });
  assert.equal(value, 4.8);
});

test('session parser reports turn cost without exposing content', async () => {
  await withFixture(async (file) => {
    const report = await parseSessionUsage(file, { force: true });
    assert.equal(report.threadId, threadId);
    assert.equal(report.turns.length, 1);
    const turn = report.turns[0];
    assert.equal(turn.model, 'example-model');
    assert.equal(turn.effort, 'high');
    assert.equal(turn.modelCalls, 2);
    assert.equal(turn.usage.totalTokens, 180);
    assert.equal(turn.usage.reasoningOutputTokens, 5);
    assert.equal(turn.uncachedInputTokens, 60);
    assert.equal(turn.cacheHitPercent, 62.5);
    assert.equal(turn.contextOccupancyPercent, 6);
    assert.equal(turn.maxContextOccupancyPercent, 10);
    assert.equal(turn.tools.total, 3);
    assert.equal(turn.tools.failures, 1);
    assert.equal(turn.tools.durationMs, 1750);
    assert.equal(turn.tools.changedFiles, 1);
    assert.equal(turn.compactions, 1);
    assert.equal(turn.promptMeasurement, null);
    const serialized = JSON.stringify(report);
    for (const secret of ['TOP_SECRET_PROMPT', 'PRIVATE COMMAND', 'PRIVATE OUTPUT', 'PRIVATE FILE', 'PRIVATE REPLY', 'PRIVATE SUMMARY', 'private\\workspace']) {
      assert.equal(serialized.includes(secret), false);
    }
  });
});

test('optional prompt measurement returns counts and still discards text', async () => {
  await withFixture(async (file) => {
    const report = await parseSessionUsage(file, { force: true, measurePromptSize: true });
    const measurement = report.turns[0].promptMeasurement;
    assert.equal(measurement.characters, 'TOP_SECRET_PROMPT'.length);
    assert.equal(measurement.source, 'session-estimate');
    assert.equal(JSON.stringify(report).includes('TOP_SECRET_PROMPT'), false);
  });
});

test('file selection honors task scope, recent limits, byte overrides, and all mode', () => {
  const now = Date.now();
  const files = [
    { filePath: 'a', threadId, bytes: 10, updatedAt: now, archived: false },
    { filePath: 'b', threadId: '33333333-3333-3333-3333-333333333333', bytes: 10, updatedAt: now - 1000, archived: false },
    { filePath: 'c', threadId: '44444444-4444-4444-4444-444444444444', bytes: 10, updatedAt: now - 2000, archived: true },
  ];
  assert.equal(selectUsageFiles(files, { now, maxSessions: 1 }).selected.length, 1);
  assert.equal(selectUsageFiles(files, { now, maxSessions: 2, maxBytes: 15 }).selected.length, 1);
  assert.equal(selectUsageFiles(files, { now, maxSessions: 2, maxBytes: 15, ignoreMaxBytes: true }).selected.length, 2);
  const allRecent = selectUsageFiles(files, { now, maxSessions: 1, maxBytes: 15, ignoreMaxBytes: true, analyzeAll: true });
  assert.equal(allRecent.selected.length, 2);
  assert.equal(allRecent.coverage.analyzeAll, true);
  assert.equal(allRecent.coverage.maxSessions, null);
  const selectedTask = selectUsageFiles(files, { now, threadId });
  assert.equal(selectedTask.selected.length, 1);
  assert.equal(selectedTask.coverage.scope, 'task');
});

test('usage intelligence aggregates cache, tools, context, and outcomes', async () => {
  await withFixture(async (file, directory) => {
    const annotationsPath = path.join(directory, 'annotations.json');
    saveTurnAnnotation(annotationsPath, threadId, turnId, {
      rating: 5,
      accepted: true,
      requiredCorrection: false,
      category: 'test',
      strategy: 'specific',
      reviewMinutes: 2,
    });
    recordPendingPromptMeasurement(annotationsPath, threadId, {
      id: 'prompt-1',
      submittedAt: Date.parse('2026-09-24T00:00:00.500Z'),
      characters: 20,
      words: 3,
      utf8Bytes: 20,
      estimatedTokens: 5,
    });
    const intelligence = await buildUsageIntelligence([file], {
      threadId,
      force: true,
      identities: { [threadId]: { title: 'Example task', status: 'idle', projectLabel: 'Example project' } },
      annotations: readUsageAnnotations(annotationsPath),
    });
    assert.equal(intelligence.summary.usage.totalTokens, 180);
    assert.equal(intelligence.summary.outcomes.acceptedTurns, 1);
    assert.equal(intelligence.summary.outcomes.averageRating, 5);
    assert.equal(intelligence.tasks[0].title, 'Example task');
    assert.equal(intelligence.tasks[0].turns[0].tokenAmplification, 36);
    assert.equal(intelligence.privacy.promptTextIncluded, false);
    const summary = aggregateUsageTasks(intelligence.tasks);
    assert.equal(summary.models[0].label, 'example-model');
    assert.equal(summary.tools[0].calls >= 1, true);
    deleteTurnAnnotation(annotationsPath, threadId, turnId);
    assert.equal(readUsageAnnotations(annotationsPath).turns[threadId], undefined);
  });
});
