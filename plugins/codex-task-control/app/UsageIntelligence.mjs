import fs from 'node:fs';
import readline from 'node:readline';
import { annotationForTurn, matchPendingPromptMeasurements } from './UsageAnnotations.mjs';

export const USAGE_SCHEMA_VERSION = 1;

const TOKEN_MAPPING = Object.freeze({
  input_tokens: 'inputTokens',
  cached_input_tokens: 'cachedInputTokens',
  cache_write_input_tokens: 'cacheWriteInputTokens',
  output_tokens: 'outputTokens',
  reasoning_output_tokens: 'reasoningOutputTokens',
  total_tokens: 'totalTokens',
});

const usageCache = new Map();

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function emptyTokenUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

export function normalizeTokenUsage(value) {
  const result = emptyTokenUsage();
  for (const [source, target] of Object.entries(TOKEN_MAPPING)) result[target] = number(value?.[source]);
  if (!result.totalTokens) result.totalTokens = result.inputTokens + result.outputTokens;
  return result;
}

export function addTokenUsage(left, right) {
  const result = emptyTokenUsage();
  for (const key of Object.values(TOKEN_MAPPING)) result[key] = number(left?.[key]) + number(right?.[key]);
  return result;
}

function percent(part, total, digits = 1) {
  return total > 0 ? Number(((part / total) * 100).toFixed(digits)) : 0;
}

export function durationToMilliseconds(value) {
  if (Number.isFinite(value)) return Math.max(0, Number(value));
  if (!value || typeof value !== 'object') return 0;
  return Math.max(0, (number(value.secs) * 1000) + (number(value.nanos) / 1_000_000));
}

function countWords(text) {
  const trimmed = String(text || '').trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

function extractText(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => extractText(item, depth + 1)).filter(Boolean).join('\n');
  if (typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.input_text === 'string') return value.input_text;
  if (value.type === 'text' && typeof value.content === 'string') return value.content;
  if (value.type === 'input_text' && typeof value.content === 'string') return value.content;
  return extractText(value.content, depth + 1);
}

export function estimatePromptMeasurement(value, source = 'session-estimate') {
  const text = extractText(value);
  if (!text) return null;
  const characters = [...text].length;
  const utf8Bytes = Buffer.byteLength(text, 'utf8');
  return {
    characters,
    words: countWords(text),
    utf8Bytes,
    estimatedTokens: Math.max(1, Math.ceil(characters / 4)),
    source,
  };
}

function createToolSummary() {
  return {
    total: 0,
    commands: 0,
    mcpCalls: 0,
    fileChanges: 0,
    changedFiles: 0,
    extensions: 0,
    functionOutputs: 0,
    failures: 0,
    durationMs: 0,
    byName: {},
  };
}

function createTurn(turnId, sequence) {
  return {
    turnId,
    rootTurnId: null,
    sequence,
    status: 'inProgress',
    startedAt: null,
    completedAt: null,
    durationMs: null,
    timeToFirstTokenMs: null,
    model: null,
    effort: null,
    collaborationMode: null,
    contextWindow: null,
    modelCalls: 0,
    usage: emptyTokenUsage(),
    lastModelCallUsage: emptyTokenUsage(),
    maxModelCallInputTokens: 0,
    cacheHitPercent: 0,
    uncachedInputTokens: 0,
    contextOccupancyPercent: null,
    maxContextOccupancyPercent: null,
    tokenAmplification: null,
    tools: createToolSummary(),
    compactions: 0,
    agentMessages: 0,
    reasoningItems: 0,
    promptMeasurement: null,
    annotation: null,
    delegated: false,
    _responseIds: new Set(),
    _compactionItems: 0,
    _compactionEvents: 0,
  };
}

function addToolName(summary, name) {
  const safeName = String(name || 'other').slice(0, 120);
  summary.byName[safeName] = (summary.byName[safeName] || 0) + 1;
}

function countChangedFiles(changes) {
  if (Array.isArray(changes)) return changes.length;
  if (changes && typeof changes === 'object') return Object.keys(changes).length;
  return 0;
}

function applyCompletedItem(turn, item) {
  if (!turn || !item) return;
  const type = item.type;
  if (type === 'Reasoning') {
    turn.reasoningItems += 1;
    return;
  }
  if (type === 'AgentMessage') {
    turn.agentMessages += 1;
    return;
  }
  if (type === 'ContextCompaction') {
    turn._compactionItems += 1;
    return;
  }
  if (type === 'UserMessage') return;

  const tools = turn.tools;
  const duration = durationToMilliseconds(item.duration);
  const failed = item.status && !['completed', 'success', 'succeeded'].includes(String(item.status).toLowerCase());
  if (type === 'CommandExecution') {
    tools.total += 1;
    tools.commands += 1;
    addToolName(tools, 'command');
  } else if (type === 'McpToolCall') {
    tools.total += 1;
    tools.mcpCalls += 1;
    addToolName(tools, `${item.server || 'mcp'}.${item.tool || 'tool'}`);
  } else if (type === 'FileChange') {
    tools.total += 1;
    tools.fileChanges += 1;
    tools.changedFiles += countChangedFiles(item.changes);
    addToolName(tools, 'file-change');
  } else if (type === 'Extension') {
    tools.total += 1;
    tools.extensions += 1;
    addToolName(tools, item.kind || 'extension');
  } else if (type === 'FunctionCallOutput') {
    tools.total += 1;
    tools.functionOutputs += 1;
    addToolName(tools, item.namespace ? `${item.namespace}.${item.name || 'function'}` : (item.name || 'function'));
  } else {
    return;
  }
  tools.durationMs += duration;
  if (failed) tools.failures += 1;
}

function finalizeTurn(turn) {
  turn.compactions = Math.max(turn.compactions, turn._compactionItems, turn._compactionEvents);
  turn.uncachedInputTokens = Math.max(0, turn.usage.inputTokens - turn.usage.cachedInputTokens);
  turn.cacheHitPercent = percent(turn.usage.cachedInputTokens, turn.usage.inputTokens);
  if (turn.contextWindow) {
    turn.contextOccupancyPercent = percent(turn.lastModelCallUsage.inputTokens, turn.contextWindow);
    turn.maxContextOccupancyPercent = percent(turn.maxModelCallInputTokens, turn.contextWindow);
  }
  if (turn.promptMeasurement?.estimatedTokens) {
    turn.tokenAmplification = Number((turn.usage.totalTokens / turn.promptMeasurement.estimatedTokens).toFixed(1));
  }
  turn.tools.durationMs = Math.round(turn.tools.durationMs);
  turn.delegated = Boolean(turn.rootTurnId && turn.rootTurnId !== turn.turnId);
  delete turn._responseIds;
  delete turn._compactionItems;
  delete turn._compactionEvents;
  return turn;
}

function sessionIdentity(file, metadata) {
  return String(metadata?.id || file?.threadId || '').toLowerCase();
}

export async function parseSessionUsage(file, options = {}) {
  const filePath = typeof file === 'string' ? file : file?.filePath;
  if (!filePath) throw new Error('A local session file path is required.');
  const stat = fs.statSync(filePath);
  const cacheKey = `${filePath}|${stat.size}|${stat.mtimeMs}|${options.measurePromptSize === true}`;
  if (!options.force && usageCache.has(cacheKey)) return structuredClone(usageCache.get(cacheKey));

  const turns = new Map();
  let sequence = 0;
  let activeTurnId = null;
  let metadata = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let malformedLines = 0;
  let finalThreadUsage = emptyTokenUsage();

  const ensureTurn = (turnId) => {
    const normalized = String(turnId || activeTurnId || '').toLowerCase();
    if (!normalized) return null;
    if (!turns.has(normalized)) turns.set(normalized, createTurn(normalized, ++sequence));
    return turns.get(normalized);
  };

  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    const timestamp = Date.parse(entry.timestamp);
    if (Number.isFinite(timestamp)) {
      firstTimestamp = firstTimestamp === null ? timestamp : Math.min(firstTimestamp, timestamp);
      lastTimestamp = lastTimestamp === null ? timestamp : Math.max(lastTimestamp, timestamp);
    }
    const payload = entry.payload || {};
    if (entry.type === 'session_meta') {
      metadata = payload;
      continue;
    }
    if (entry.type === 'turn_context') {
      const turn = ensureTurn(payload.turn_id);
      if (!turn) continue;
      turn.rootTurnId = payload.root_turn_id || turn.rootTurnId;
      turn.model = payload.model || turn.model;
      turn.effort = payload.effort || turn.effort;
      turn.collaborationMode = payload.collaboration_mode?.mode || payload.collaboration_mode || turn.collaborationMode;
      continue;
    }
    if (entry.type === 'token_usage_record') {
      const turn = ensureTurn(payload.turn_id);
      if (!turn) continue;
      turn.rootTurnId = payload.root_turn_id || turn.rootTurnId;
      const responseId = payload.response_id || `ordinal-${entry.ordinal}`;
      if (!turn._responseIds.has(responseId)) {
        turn._responseIds.add(responseId);
        turn.modelCalls += 1;
      }
      const callUsage = normalizeTokenUsage(payload.usage);
      turn.lastModelCallUsage = callUsage;
      turn.maxModelCallInputTokens = Math.max(turn.maxModelCallInputTokens, callUsage.inputTokens);
      turn.usage = payload.turn_token_usage
        ? normalizeTokenUsage(payload.turn_token_usage)
        : addTokenUsage(turn.usage, callUsage);
      if (payload.thread_token_usage) finalThreadUsage = normalizeTokenUsage(payload.thread_token_usage);
      continue;
    }
    if (entry.type === 'compacted') {
      const turnId = payload.latest_token_usage_record?.payload?.turn_id || activeTurnId;
      const turn = ensureTurn(turnId);
      if (turn) turn._compactionEvents += 1;
      continue;
    }
    if (entry.type !== 'event_msg') continue;

    if (payload.type === 'task_started') {
      activeTurnId = String(payload.turn_id || '').toLowerCase();
      const turn = ensureTurn(activeTurnId);
      if (!turn) continue;
      turn.rootTurnId = payload.root_turn_id || turn.rootTurnId;
      turn.startedAt = number(payload.started_at) || timestamp || turn.startedAt;
      if (turn.startedAt && turn.startedAt < 10_000_000_000) turn.startedAt *= 1000;
      turn.contextWindow = number(payload.model_context_window) || turn.contextWindow;
      turn.collaborationMode = payload.collaboration_mode_kind || turn.collaborationMode;
      continue;
    }
    if (payload.type === 'task_complete') {
      const turn = ensureTurn(payload.turn_id);
      if (!turn) continue;
      turn.status = 'completed';
      turn.startedAt = number(payload.started_at) || turn.startedAt;
      turn.completedAt = number(payload.completed_at) || timestamp || turn.completedAt;
      if (turn.startedAt && turn.startedAt < 10_000_000_000) turn.startedAt *= 1000;
      if (turn.completedAt && turn.completedAt < 10_000_000_000) turn.completedAt *= 1000;
      turn.durationMs = number(payload.duration_ms) || (turn.startedAt && turn.completedAt ? turn.completedAt - turn.startedAt : null);
      turn.timeToFirstTokenMs = number(payload.time_to_first_token_ms) || null;
      if (activeTurnId === turn.turnId) activeTurnId = null;
      continue;
    }
    if (['task_failed', 'turn_failed', 'task_interrupted', 'turn_aborted'].includes(payload.type)) {
      const turn = ensureTurn(payload.turn_id);
      if (!turn) continue;
      turn.status = payload.type.includes('interrupt') || payload.type.includes('aborted') ? 'interrupted' : 'failed';
      turn.completedAt = timestamp || turn.completedAt;
      if (turn.startedAt && turn.completedAt) turn.durationMs = turn.completedAt - turn.startedAt;
      if (activeTurnId === turn.turnId) activeTurnId = null;
      continue;
    }
    if (payload.type === 'item_completed') {
      const turn = ensureTurn(payload.turn_id);
      if (!turn) continue;
      if (payload.item?.type === 'UserMessage' && options.measurePromptSize === true) {
        turn.promptMeasurement = estimatePromptMeasurement(payload.item.content);
      }
      applyCompletedItem(turn, payload.item);
    }
  }

  const threadId = sessionIdentity(file, metadata);
  const report = {
    schemaVersion: USAGE_SCHEMA_VERSION,
    threadId,
    archived: typeof file === 'object' ? file.archived === true : false,
    bytes: stat.size,
    fileCount: 1,
    firstActivityAt: firstTimestamp,
    lastActivityAt: lastTimestamp || stat.mtimeMs,
    malformedLines,
    sourceTokenUsage: finalThreadUsage,
    turns: [...turns.values()].sort((a, b) => a.sequence - b.sequence).map(finalizeTurn),
  };
  usageCache.set(cacheKey, structuredClone(report));
  if (usageCache.size > 250) usageCache.delete(usageCache.keys().next().value);
  return report;
}

function chooseTurn(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (right.usage.totalTokens > left.usage.totalTokens) return right;
  if (right.completedAt && !left.completedAt) return right;
  return left;
}

export function mergeTaskReports(reports) {
  const grouped = new Map();
  for (const report of reports) {
    if (!report?.threadId) continue;
    const task = grouped.get(report.threadId) || {
      schemaVersion: USAGE_SCHEMA_VERSION,
      threadId: report.threadId,
      title: `Task ${report.threadId.slice(0, 8)}`,
      status: report.archived ? 'archived' : 'not loaded',
      projectLabel: 'Projectless',
      archived: true,
      bytes: 0,
      fileCount: 0,
      firstActivityAt: null,
      lastActivityAt: null,
      malformedLines: 0,
      turns: [],
    };
    task.archived = task.archived && report.archived;
    task.bytes += number(report.bytes);
    task.fileCount += number(report.fileCount) || 1;
    task.firstActivityAt = task.firstActivityAt === null ? report.firstActivityAt : Math.min(task.firstActivityAt, report.firstActivityAt || task.firstActivityAt);
    task.lastActivityAt = Math.max(task.lastActivityAt || 0, report.lastActivityAt || 0);
    task.malformedLines += number(report.malformedLines);
    const byTurn = new Map(task.turns.map((turn) => [turn.turnId, turn]));
    for (const turn of report.turns || []) byTurn.set(turn.turnId, chooseTurn(byTurn.get(turn.turnId), turn));
    task.turns = [...byTurn.values()].sort((a, b) => a.sequence - b.sequence || (a.startedAt || 0) - (b.startedAt || 0));
    task.turns.forEach((turn, index) => { turn.sequence = index + 1; });
    grouped.set(report.threadId, task);
  }
  return [...grouped.values()];
}

function applyTaskIdentity(task, identities) {
  const identity = identities instanceof Map ? identities.get(task.threadId) : identities?.[task.threadId];
  if (!identity) return task;
  task.title = identity.title || task.title;
  task.status = identity.status || task.status;
  task.projectLabel = identity.projectLabel || task.projectLabel;
  return task;
}

function applyAnnotations(task, annotations) {
  matchPendingPromptMeasurements(annotations, task.threadId, task.turns);
  for (const turn of task.turns) {
    turn.annotation = annotationForTurn(annotations, task.threadId, turn.turnId);
    if (turn.promptMeasurement?.estimatedTokens) {
      turn.tokenAmplification = Number((turn.usage.totalTokens / turn.promptMeasurement.estimatedTokens).toFixed(1));
    }
  }
  return task;
}

function summarizeTask(task) {
  task.usage = task.turns.reduce((sum, turn) => addTokenUsage(sum, turn.usage), emptyTokenUsage());
  task.modelCalls = task.turns.reduce((sum, turn) => sum + turn.modelCalls, 0);
  task.durationMs = task.turns.reduce((sum, turn) => sum + number(turn.durationMs), 0);
  task.compactions = task.turns.reduce((sum, turn) => sum + turn.compactions, 0);
  task.tools = task.turns.reduce((summary, turn) => {
    for (const key of ['total', 'commands', 'mcpCalls', 'fileChanges', 'changedFiles', 'extensions', 'functionOutputs', 'failures', 'durationMs']) {
      summary[key] += number(turn.tools?.[key]);
    }
    for (const [name, count] of Object.entries(turn.tools?.byName || {})) summary.byName[name] = (summary.byName[name] || 0) + count;
    return summary;
  }, createToolSummary());
  task.uncachedInputTokens = Math.max(0, task.usage.inputTokens - task.usage.cachedInputTokens);
  task.cacheHitPercent = percent(task.usage.cachedInputTokens, task.usage.inputTokens);
  task.maxContextOccupancyPercent = Math.max(0, ...task.turns.map((turn) => number(turn.maxContextOccupancyPercent)));
  const followUps = task.turns.slice(1).reduce((sum, turn) => sum + turn.usage.totalTokens, 0);
  task.followUpTokenSharePercent = percent(followUps, task.usage.totalTokens);
  return task;
}

export function estimateApiEquivalentCost(usage, rates) {
  if (!rates || typeof rates !== 'object') return null;
  const inputRate = Number(rates.input);
  const cachedRate = Number(rates.cachedInput);
  const outputRate = Number(rates.output);
  const cacheWriteRate = Number(rates.cacheWriteInput || 0);
  if (![inputRate, cachedRate, outputRate, cacheWriteRate].every((value) => Number.isFinite(value) && value >= 0)) return null;
  const uncachedInput = Math.max(0, number(usage.inputTokens) - number(usage.cachedInputTokens));
  const dollars = (
    (uncachedInput * inputRate)
    + (number(usage.cachedInputTokens) * cachedRate)
    + (number(usage.cacheWriteInputTokens) * cacheWriteRate)
    + (number(usage.outputTokens) * outputRate)
  ) / 1_000_000;
  return Number(dollars.toFixed(6));
}

function applyPricing(task, pricing) {
  let pricedTurns = 0;
  let totalCost = 0;
  for (const turn of task.turns) {
    const rates = pricing?.[turn.model] || pricing?.default || null;
    turn.estimatedApiEquivalentCostUsd = estimateApiEquivalentCost(turn.usage, rates);
    if (turn.estimatedApiEquivalentCostUsd !== null) {
      pricedTurns += 1;
      totalCost += turn.estimatedApiEquivalentCostUsd;
    }
  }
  task.estimatedApiEquivalentCostUsd = pricedTurns ? Number(totalCost.toFixed(6)) : null;
  task.pricedTurns = pricedTurns;
  return task;
}

function quantile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function breakdown(turns, valueFor, labelFor) {
  const groups = new Map();
  for (const turn of turns) {
    const label = labelFor(turn) || 'Unknown';
    const group = groups.get(label) || { label, turns: 0, modelCalls: 0, totalTokens: 0, durationMs: 0 };
    group.turns += 1;
    group.modelCalls += turn.modelCalls;
    group.totalTokens += valueFor(turn);
    group.durationMs += number(turn.durationMs);
    groups.set(label, group);
  }
  return [...groups.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function buildDaily(turns) {
  const groups = new Map();
  for (const turn of turns) {
    const timestamp = turn.completedAt || turn.startedAt;
    if (!timestamp) continue;
    const key = new Date(timestamp).toISOString().slice(0, 10);
    const item = groups.get(key) || { date: key, turns: 0, totalTokens: 0, durationMs: 0, modelCalls: 0 };
    item.turns += 1;
    item.totalTokens += turn.usage.totalTokens;
    item.durationMs += number(turn.durationMs);
    item.modelCalls += turn.modelCalls;
    groups.set(key, item);
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function buildToolBreakdown(tasks) {
  const counts = new Map();
  for (const task of tasks) {
    for (const [name, count] of Object.entries(task.tools.byName || {})) counts.set(name, (counts.get(name) || 0) + count);
  }
  return [...counts.entries()].map(([label, calls]) => ({ label, calls })).sort((a, b) => b.calls - a.calls);
}

function buildOutcomeSummary(turns) {
  const annotated = turns.filter((turn) => turn.annotation);
  const rated = annotated.filter((turn) => Number.isFinite(turn.annotation.rating));
  const accepted = annotated.filter((turn) => turn.annotation.accepted === true);
  const corrected = annotated.filter((turn) => turn.annotation.requiredCorrection === true);
  const promptMeasured = turns.filter((turn) => turn.promptMeasurement?.estimatedTokens);
  return {
    annotatedTurns: annotated.length,
    ratedTurns: rated.length,
    averageRating: rated.length ? Number((rated.reduce((sum, turn) => sum + turn.annotation.rating, 0) / rated.length).toFixed(2)) : null,
    acceptedTurns: accepted.length,
    requiredCorrectionTurns: corrected.length,
    firstAttemptAcceptancePercent: annotated.length ? percent(accepted.length, annotated.length) : null,
    reviewMinutes: annotated.reduce((sum, turn) => sum + number(turn.annotation.reviewMinutes), 0),
    averageTokensPerAcceptedTurn: accepted.length ? Math.round(accepted.reduce((sum, turn) => sum + turn.usage.totalTokens, 0) / accepted.length) : null,
    promptMeasurementCoverage: promptMeasured.length,
    averageTokenAmplification: promptMeasured.length
      ? Number((promptMeasured.reduce((sum, turn) => sum + number(turn.tokenAmplification), 0) / promptMeasured.length).toFixed(1))
      : null,
  };
}

function buildAnnotationBreakdown(turns, field) {
  const groups = new Map();
  for (const turn of turns) {
    const label = turn.annotation?.[field];
    if (!label) continue;
    const group = groups.get(label) || { label, turns: 0, totalTokens: 0, ratedTurns: 0, ratingTotal: 0, acceptedTurns: 0 };
    group.turns += 1;
    group.totalTokens += turn.usage.totalTokens;
    if (Number.isFinite(turn.annotation.rating)) {
      group.ratedTurns += 1;
      group.ratingTotal += turn.annotation.rating;
    }
    if (turn.annotation.accepted === true) group.acceptedTurns += 1;
    groups.set(label, group);
  }
  return [...groups.values()].map((group) => ({
    label: group.label,
    turns: group.turns,
    totalTokens: group.totalTokens,
    averageRating: group.ratedTurns ? Number((group.ratingTotal / group.ratedTurns).toFixed(2)) : null,
    acceptedPercent: percent(group.acceptedTurns, group.turns),
  })).sort((a, b) => b.totalTokens - a.totalTokens);
}

function makeInsights(summary, turns, tasks) {
  const insights = [];
  if (!turns.length) return [{ level: 'info', title: 'No completed usage found', detail: 'No token-bearing turns were available in the selected local records.' }];
  if (summary.maxContextOccupancyPercent >= 80) {
    insights.push({
      level: 'warning',
      title: 'High context occupancy',
      detail: `At least one turn reached ${summary.maxContextOccupancyPercent}% of its model context. A focused continuation task may reduce repeated context load.`,
    });
  }
  if (summary.cacheHitPercent >= 80) {
    insights.push({
      level: 'good',
      title: 'Most input was cached',
      detail: `${summary.cacheHitPercent}% of input tokens were reported as cached. Cached tokens remain part of token accounting but are useful to separate from uncached input.`,
    });
  }
  const costly = [...turns].sort((a, b) => b.usage.totalTokens - a.usage.totalTokens)[0];
  if (costly) {
    insights.push({
      level: 'info',
      title: 'Largest turn',
      detail: `Turn ${costly.sequence} in “${costly.taskTitle}” used ${costly.usage.totalTokens.toLocaleString()} aggregate tokens across ${costly.modelCalls} model generation${costly.modelCalls === 1 ? '' : 's'}.`,
    });
  }
  if (summary.toolFailures > 0) {
    insights.push({
      level: 'warning',
      title: 'Tool retry opportunity',
      detail: `${summary.toolFailures} completed tool item${summary.toolFailures === 1 ? '' : 's'} reported a non-success status. Review expensive turns with failures for avoidable retries.`,
    });
  }
  if (summary.followUpTokenSharePercent >= 70 && tasks.some((task) => task.turns.length >= 3)) {
    insights.push({
      level: 'info',
      title: 'Follow-ups dominate usage',
      detail: `${summary.followUpTokenSharePercent}% of measured tokens occurred after the first turn in each task. Compare focused new tasks with long follow-up chains for similar work.`,
    });
  }
  if (!summary.outcomes.annotatedTurns) {
    insights.push({
      level: 'info',
      title: 'Add outcome tags',
      detail: 'Token counts show resource use, not value. Rating or accepting a few representative turns enables cost-versus-quality comparisons.',
    });
  }
  return insights;
}

export function aggregateUsageTasks(tasks) {
  const turns = tasks.flatMap((task) => task.turns.map((turn) => ({ ...turn, threadId: task.threadId, taskTitle: task.title, projectLabel: task.projectLabel })));
  const usage = tasks.reduce((sum, task) => addTokenUsage(sum, task.usage), emptyTokenUsage());
  const durations = turns.map((turn) => number(turn.durationMs)).filter((value) => value > 0);
  const toolCalls = tasks.reduce((sum, task) => sum + task.tools.total, 0);
  const toolFailures = tasks.reduce((sum, task) => sum + task.tools.failures, 0);
  const compactions = tasks.reduce((sum, task) => sum + task.compactions, 0);
  const followUpTokens = tasks.reduce((sum, task) => sum + task.turns.slice(1).reduce((inner, turn) => inner + turn.usage.totalTokens, 0), 0);
  const summary = {
    taskCount: tasks.length,
    turnCount: turns.length,
    completedTurns: turns.filter((turn) => turn.status === 'completed').length,
    interruptedTurns: turns.filter((turn) => turn.status === 'interrupted').length,
    failedTurns: turns.filter((turn) => turn.status === 'failed').length,
    activeTurns: turns.filter((turn) => turn.status === 'inProgress').length,
    usage,
    uncachedInputTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens),
    cacheHitPercent: percent(usage.cachedInputTokens, usage.inputTokens),
    modelCalls: turns.reduce((sum, turn) => sum + turn.modelCalls, 0),
    toolCalls,
    toolFailures,
    toolFailurePercent: percent(toolFailures, toolCalls),
    toolDurationMs: tasks.reduce((sum, task) => sum + task.tools.durationMs, 0),
    changedFiles: tasks.reduce((sum, task) => sum + task.tools.changedFiles, 0),
    compactions,
    totalDurationMs: durations.reduce((sum, value) => sum + value, 0),
    averageTurnDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
    medianTurnDurationMs: quantile(durations, 0.5),
    p95TurnDurationMs: quantile(durations, 0.95),
    medianTurnTokens: quantile(turns.map((turn) => turn.usage.totalTokens), 0.5),
    p95TurnTokens: quantile(turns.map((turn) => turn.usage.totalTokens), 0.95),
    maxContextOccupancyPercent: Math.max(0, ...turns.map((turn) => number(turn.maxContextOccupancyPercent))),
    followUpTokenSharePercent: percent(followUpTokens, usage.totalTokens),
    rootTokens: turns.filter((turn) => !turn.delegated).reduce((sum, turn) => sum + turn.usage.totalTokens, 0),
    delegatedTokens: turns.filter((turn) => turn.delegated).reduce((sum, turn) => sum + turn.usage.totalTokens, 0),
    estimatedApiEquivalentCostUsd: null,
    pricedTurns: turns.filter((turn) => turn.estimatedApiEquivalentCostUsd !== null && turn.estimatedApiEquivalentCostUsd !== undefined).length,
    unpricedTurns: turns.filter((turn) => turn.estimatedApiEquivalentCostUsd === null || turn.estimatedApiEquivalentCostUsd === undefined).length,
    outcomes: buildOutcomeSummary(turns),
  };
  if (summary.pricedTurns) {
    summary.estimatedApiEquivalentCostUsd = Number(turns.reduce((sum, turn) => sum + number(turn.estimatedApiEquivalentCostUsd), 0).toFixed(6));
  }
  summary.topTurn = [...turns].sort((a, b) => b.usage.totalTokens - a.usage.totalTokens)[0] || null;
  summary.models = breakdown(turns, (turn) => turn.usage.totalTokens, (turn) => turn.model);
  summary.efforts = breakdown(turns, (turn) => turn.usage.totalTokens, (turn) => turn.effort);
  summary.projects = breakdown(turns, (turn) => turn.usage.totalTokens, (turn) => turn.projectLabel);
  summary.daily = buildDaily(turns);
  summary.tools = buildToolBreakdown(tasks);
  summary.categories = buildAnnotationBreakdown(turns, 'category');
  summary.strategies = buildAnnotationBreakdown(turns, 'strategy');
  summary.insights = makeInsights(summary, turns, tasks);
  return summary;
}

function applyBudgets(summary, tasks, options) {
  const taskBudget = number(options.taskTokenBudget);
  const dailyBudget = number(options.dailyTokenBudget);
  const taskStatuses = taskBudget ? tasks.map((task) => ({
    threadId: task.threadId,
    title: task.title,
    totalTokens: task.usage.totalTokens,
    budgetTokens: taskBudget,
    usedPercent: percent(task.usage.totalTokens, taskBudget),
    exceeded: task.usage.totalTokens > taskBudget,
  })).sort((a, b) => b.usedPercent - a.usedPercent) : [];
  const dailyStatuses = dailyBudget ? summary.daily.map((day) => ({
    ...day,
    budgetTokens: dailyBudget,
    usedPercent: percent(day.totalTokens, dailyBudget),
    exceeded: day.totalTokens > dailyBudget,
  })) : [];
  summary.budgets = {
    taskTokenBudget: taskBudget || null,
    dailyTokenBudget: dailyBudget || null,
    tasks: taskStatuses,
    days: dailyStatuses,
    exceededTasks: taskStatuses.filter((item) => item.exceeded).length,
    exceededDays: dailyStatuses.filter((item) => item.exceeded).length,
  };
  const topTask = taskStatuses[0];
  if (topTask?.usedPercent >= 80) {
    summary.insights.push({
      level: topTask.exceeded ? 'warning' : 'info',
      title: topTask.exceeded ? 'Task token budget exceeded' : 'Task token budget nearing limit',
      detail: `“${topTask.title}” has used ${topTask.usedPercent}% of the configured ${taskBudget.toLocaleString()}-token task reference budget.`,
    });
  }
  const latestDay = dailyStatuses.at(-1);
  if (latestDay?.usedPercent >= 80) {
    summary.insights.push({
      level: latestDay.exceeded ? 'warning' : 'info',
      title: latestDay.exceeded ? 'Daily token budget exceeded' : 'Daily token budget nearing limit',
      detail: `${latestDay.date} has used ${latestDay.usedPercent}% of the configured ${dailyBudget.toLocaleString()}-token daily reference budget.`,
    });
  }
  return summary;
}

export function selectUsageFiles(files, options = {}) {
  const now = Number(options.now) || Date.now();
  const windowDays = Math.max(1, Number(options.windowDays) || 30);
  const maxSessions = Math.max(1, Number(options.maxSessions) || 50);
  const maxBytes = Math.max(1, Number(options.maxBytes) || 1_073_741_824);
  const threadId = options.threadId ? String(options.threadId).toLowerCase() : null;
  const analyzeAll = !threadId && options.analyzeAll === true;
  const ignoreMaxBytes = !threadId && options.ignoreMaxBytes === true;
  const cutoff = now - (windowDays * 86_400_000);
  const eligible = files
    .filter((file) => file?.filePath && (!threadId || file.threadId === threadId))
    .filter((file) => threadId || options.includeArchived === true || file.archived !== true)
    .filter((file) => threadId || number(file.updatedAt) >= cutoff)
    .sort((a, b) => number(b.updatedAt) - number(a.updatedAt));
  const selected = [];
  let selectedBytes = 0;
  for (const file of eligible) {
    if (!threadId && !analyzeAll && selected.length >= maxSessions) break;
    const bytes = number(file.bytes);
    if (!threadId && !analyzeAll && !ignoreMaxBytes && selected.length && selectedBytes + bytes > maxBytes) break;
    selected.push(file);
    selectedBytes += bytes;
  }
  return {
    selected,
    coverage: {
      scope: threadId ? 'task' : 'recent',
      threadId,
      windowDays: threadId ? null : windowDays,
      includeArchived: threadId ? selected.some((file) => file.archived) : options.includeArchived === true,
      availableFiles: files.length,
      eligibleFiles: eligible.length,
      analyzedFiles: selected.length,
      skippedEligibleFiles: Math.max(0, eligible.length - selected.length),
      analyzedBytes: selectedBytes,
      maxSessions: threadId || analyzeAll ? null : maxSessions,
      maxBytes: threadId || analyzeAll || ignoreMaxBytes ? null : maxBytes,
      analyzeAll,
      byteLimitApplied: !threadId && !analyzeAll && !ignoreMaxBytes,
    },
  };
}

async function mapWithLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function buildUsageIntelligence(files, options = {}) {
  const selection = selectUsageFiles(files, options);
  const errors = [];
  const reports = (await mapWithLimit(selection.selected, 3, async (file) => {
    try {
      return await parseSessionUsage(file, {
        measurePromptSize: options.measurePromptSize === true,
        force: options.force === true,
      });
    } catch (error) {
      errors.push({ threadId: file.threadId || null, error: 'The local session record could not be parsed.' });
      return null;
    }
  })).filter(Boolean);

  const tasks = mergeTaskReports(reports)
    .map((task) => applyTaskIdentity(task, options.identities || {}))
    .map((task) => applyAnnotations(task, options.annotations || {}))
    .map(summarizeTask)
    .map((task) => applyPricing(task, options.modelPricingUsdPerMillion || {}))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const summary = aggregateUsageTasks(tasks);
  applyBudgets(summary, tasks, options);
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    generatedAt: Date.now(),
    privacy: {
      promptTextIncluded: false,
      commandTextIncluded: false,
      toolArgumentsIncluded: false,
      toolOutputsIncluded: false,
      accountIdentifiersIncluded: false,
      promptSizeMeasurementEnabled: options.measurePromptSize === true,
    },
    coverage: { ...selection.coverage, successfullyParsedFiles: reports.length, parseErrors: errors.length },
    summary,
    tasks,
    errors,
  };
}

export function clearUsageCache() {
  usageCache.clear();
}
