import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  getCodexUsageLimits,
  getThreadIdentity,
  getThreadSnapshot,
  latestAssistantReply,
  localCodexTaskHistory,
  listCodexProjects,
  listCodexThreads,
  localSessionStorageFiles,
  mergeLocalCodexTasks,
  patterns,
  sendThreadFollowUp,
} from './CodexHostBridge.mjs';
import {
  buildUsageIntelligence,
  estimatePromptMeasurement,
  USAGE_SCHEMA_VERSION,
} from './UsageIntelligence.mjs';
import {
  deleteTurnAnnotation,
  readUsageAnnotations,
  recordPendingPromptMeasurement,
  saveTurnAnnotation,
} from './UsageAnnotations.mjs';
import { suggestSpelling } from './SpellingService.mjs';

export const VERSION = '0.3.0';
const APP_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ANNOTATIONS_PATH = path.join(APP_DIRECTORY, 'usage-annotations.json');
const HOST = '127.0.0.1';
const DEFAULT_CONFIG = Object.freeze({
  port: 47651,
  recentTaskLimit: 20,
  maxPromptBytes: 262144,
  analyticsWindowDays: 30,
  analyticsMaxSessions: 50,
  analyticsIncludeArchived: false,
  measurePromptSize: false,
  enableUsageAnnotations: true,
  taskTokenBudget: 0,
  dailyTokenBudget: 0,
  modelPricingUsdPerMillion: {},
  enableEndLocalWork: true,
  openBrowserOnShortcut: true,
});

export function validateConfig(input = {}) {
  const config = { ...DEFAULT_CONFIG, ...input };
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new Error('config.port must be an integer from 1024 to 65535.');
  }
  if (!Number.isInteger(config.recentTaskLimit) || config.recentTaskLimit < 1 || config.recentTaskLimit > 50) {
    throw new Error('config.recentTaskLimit must be an integer from 1 to 50.');
  }
  if (!Number.isInteger(config.maxPromptBytes) || config.maxPromptBytes < 1024 || config.maxPromptBytes > 1048576) {
    throw new Error('config.maxPromptBytes must be an integer from 1024 to 1048576.');
  }
  if (!Number.isInteger(config.analyticsWindowDays) || config.analyticsWindowDays < 1 || config.analyticsWindowDays > 3650) {
    throw new Error('config.analyticsWindowDays must be an integer from 1 to 3650.');
  }
  if (!Number.isInteger(config.analyticsMaxSessions) || config.analyticsMaxSessions < 1 || config.analyticsMaxSessions > 1000) {
    throw new Error('config.analyticsMaxSessions must be an integer from 1 to 1000.');
  }
  for (const key of ['taskTokenBudget', 'dailyTokenBudget']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 0) throw new Error(`config.${key} must be a non-negative safe integer.`);
  }
  if (!config.modelPricingUsdPerMillion || typeof config.modelPricingUsdPerMillion !== 'object' || Array.isArray(config.modelPricingUsdPerMillion)) {
    throw new Error('config.modelPricingUsdPerMillion must be an object.');
  }
  for (const [model, rates] of Object.entries(config.modelPricingUsdPerMillion)) {
    if (!model || model.length > 120 || !rates || typeof rates !== 'object' || Array.isArray(rates)) {
      throw new Error('Each modelPricingUsdPerMillion entry must be a model name and rate object.');
    }
    for (const key of ['input', 'cachedInput', 'output']) {
      if (!Number.isFinite(rates[key]) || rates[key] < 0 || rates[key] > 100000) {
        throw new Error(`Pricing rate ${model}.${key} must be a non-negative number.`);
      }
    }
    if (rates.cacheWriteInput !== undefined && (!Number.isFinite(rates.cacheWriteInput) || rates.cacheWriteInput < 0 || rates.cacheWriteInput > 100000)) {
      throw new Error(`Pricing rate ${model}.cacheWriteInput must be a non-negative number.`);
    }
  }
  for (const key of ['analyticsIncludeArchived', 'measurePromptSize', 'enableUsageAnnotations', 'enableEndLocalWork', 'openBrowserOnShortcut']) {
    if (typeof config[key] !== 'boolean') throw new Error(`config.${key} must be true or false.`);
  }
  return config;
}

export function loadConfig(configPath = process.env.CODEX_TASK_CONTROL_CONFIG || path.join(APP_DIRECTORY, 'config.json')) {
  if (!fs.existsSync(configPath)) return validateConfig();
  let input;
  try {
    input = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Could not read ${configPath}: ${error.message}`);
  }
  return validateConfig(input);
}

function sendJson(response, code, value) {
  response.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(JSON.stringify(value));
}

async function readBody(request, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('The request is larger than this control centre allows.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('The request body is not valid JSON.');
  }
}

export function usageSummary(payload) {
  const source = payload?.rateLimitsByLimitId?.codex || payload?.rateLimits || null;
  const primary = source?.primary || null;
  const usedPercent = Number.isFinite(primary?.usedPercent) ? primary.usedPercent : null;
  return {
    allowed: payload?.ordinaryUsageAllowed ?? null,
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent)),
    windowDurationMins: primary?.windowDurationMins ?? null,
    resetsAt: primary?.resetsAt ?? null,
    planType: source?.planType ?? null,
    rateLimitReachedType: source?.rateLimitReachedType ?? null,
    resetCreditsAvailable: payload?.rateLimitResetCredits?.availableCount ?? 0,
  };
}

function normalizeProjectPath(value) {
  return String(value || '').replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
}

export function projectLabelForTask(task, projectPayload) {
  const projects = projectPayload?.projects || [];
  const byId = task?.projectId && projects.find((project) => project.projectId === task.projectId);
  if (byId?.label) return byId.label;
  const taskPath = normalizeProjectPath(task?.cwd);
  const byPath = taskPath && projects.find((project) => normalizeProjectPath(project.path) === taskPath);
  return byPath?.label || task?.projectLabel || 'Projectless';
}

export function taskCatalog(threadPayload, projectPayload = null, historyTasks = []) {
  return mergeLocalCodexTasks(threadPayload, historyTasks).map((task) => ({
    ...task,
    projectLabel: projectLabelForTask(task, projectPayload),
  }));
}

export function taskPageSummary(threadPayload, historyTasks = [], projectPayload = null, offset = 0, pageSize = 20) {
  const allTasks = taskCatalog(threadPayload, projectPayload, historyTasks);
  const tasks = allTasks.slice(offset, offset + pageSize);
  const nextOffset = offset + tasks.length;
  return {
    tasks,
    taskPage: {
      offset,
      pageSize,
      returned: tasks.length,
      nextOffset,
      total: allTasks.length,
      hasMore: nextOffset < allTasks.length,
    },
  };
}

export function dashboardSummary(
  threadPayload,
  usagePayload,
  recentTaskLimit,
  projectPayload = null,
  historyTasks = [],
  preferredThreadId = null,
) {
  const allTasks = taskCatalog(threadPayload, projectPayload, historyTasks);
  const page = taskPageSummary(threadPayload, historyTasks, projectPayload, 0, recentTaskLimit);
  const tasks = [...page.tasks];
  const preferred = preferredThreadId && allTasks.find((task) => task.id === preferredThreadId);
  if (preferred && !tasks.some((task) => task.id === preferred.id)) tasks.push(preferred);
  return {
    connected: true,
    tasks,
    taskPage: page.taskPage,
    counts: {
      active: allTasks.filter((item) => item.status === 'active').length,
      idle: allTasks.filter((item) => item.status === 'idle').length,
      unloaded: allTasks.filter((item) => item.status === 'notLoaded').length,
      total: allTasks.length,
      shown: tasks.length,
    },
    usage: usageSummary(usagePayload),
  };
}

export function usageIdentityMap(threadPayload, projectPayload = null, historyTasks = []) {
  return Object.fromEntries(taskCatalog(threadPayload, projectPayload, historyTasks).map((task) => [task.id, {
    ...task,
    projectLabel: projectLabelForTask(task, projectPayload),
  }]));
}

export function sessionStorageSummary(files, threadPayload, now = Date.now(), projectPayload = null, historyTasks = []) {
  const knownTasks = taskCatalog(threadPayload, projectPayload, historyTasks);
  const knownById = new Map(knownTasks.map((task) => [task.id, task]));
  const grouped = new Map();
  for (const file of files) {
    if (!patterns.THREAD_ID.test(file?.threadId || '')) continue;
    const existing = grouped.get(file.threadId) || {
      threadId: file.threadId,
      bytes: 0,
      updatedAt: 0,
      archived: true,
      fileCount: 0,
    };
    existing.bytes += Number.isFinite(file.bytes) ? Math.max(0, file.bytes) : 0;
    existing.updatedAt = Math.max(existing.updatedAt, Number(file.updatedAt) || 0);
    existing.archived = existing.archived && file.archived === true;
    existing.fileCount += 1;
    grouped.set(file.threadId, existing);
  }

  const tasks = [...grouped.values()].map((item) => {
    const known = knownById.get(item.threadId);
    return {
      ...item,
      title: known?.title || `Task ${item.threadId.slice(0, 8)}`,
      status: known?.status || (item.archived ? 'archived' : 'not loaded'),
      cwd: known?.cwd || null,
      projectId: known?.projectId || null,
      projectLabel: projectLabelForTask(known, projectPayload),
    };
  });
  const sizes = tasks.map((task) => task.bytes).sort((a, b) => a - b);
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  const middle = Math.floor(sizes.length / 2);
  const medianBytes = !sizes.length ? 0 : (sizes.length % 2 ? sizes[middle] : Math.round((sizes[middle - 1] + sizes[middle]) / 2));
  const percentile = (ratio) => sizes.length ? sizes[Math.max(0, Math.ceil(sizes.length * ratio) - 1)] : 0;
  const p95Bytes = percentile(0.95);
  const p99Bytes = percentile(0.99);
  const currentBytes = tasks.filter((task) => !task.archived).reduce((sum, task) => sum + task.bytes, 0);
  const archivedBytes = totalBytes - currentBytes;
  const age = (days) => now - (days * 24 * 60 * 60 * 1000);

  const monthly = [];
  const currentMonth = new Date(now);
  currentMonth.setDate(1);
  currentMonth.setHours(0, 0, 0, 0);
  for (let offset = 5; offset >= 0; offset -= 1) {
    const start = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - offset, 1);
    const end = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - offset + 1, 1);
    const inMonth = tasks.filter((task) => task.updatedAt >= start.getTime() && task.updatedAt < end.getTime());
    monthly.push({
      key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
      label: start.toLocaleDateString('en', { month: 'short' }),
      tasks: inMonth.length,
      bytes: inMonth.reduce((sum, task) => sum + task.bytes, 0),
    });
  }

  return {
    generatedAt: now,
    taskCount: tasks.length,
    sessionFileCount: files.length,
    currentTaskCount: tasks.filter((task) => !task.archived).length,
    archivedTaskCount: tasks.filter((task) => task.archived).length,
    totalBytes,
    currentBytes,
    archivedBytes,
    averageBytes: tasks.length ? Math.round(totalBytes / tasks.length) : 0,
    medianBytes,
    p95Bytes,
    p99Bytes,
    recent: {
      day: tasks.filter((task) => task.updatedAt >= age(1)).length,
      week: tasks.filter((task) => task.updatedAt >= age(7)).length,
      month: tasks.filter((task) => task.updatedAt >= age(30)).length,
    },
    knownWorkspaceCount: new Set(knownTasks.map((task) => task.cwd).filter(Boolean)).size,
    largest: tasks.sort((a, b) => b.bytes - a.bytes).slice(0, 10),
    monthly,
  };
}

const taskIdentityCache = new Map();

async function resolveStorageTaskIdentities(storage, projectPayload) {
  const missing = storage.largest.filter((task) => task.title === `Task ${task.threadId.slice(0, 8)}`);
  await Promise.all(missing.map(async (task) => {
    try {
      let identity = taskIdentityCache.get(task.threadId);
      if (!identity) {
        identity = await getThreadIdentity(task.threadId);
        taskIdentityCache.set(task.threadId, identity);
      }
      task.title = identity.title || task.title;
      task.status = identity.status || task.status;
      task.cwd = identity.cwd || task.cwd;
      task.projectId = identity.projectId || task.projectId;
      task.projectLabel = projectLabelForTask(identity, projectPayload);
    } catch {
      // Preserve the short-ID fallback when Codex can no longer resolve an old task.
    }
  }));
  return storage;
}

function renderHtml(token) {
  const template = fs.readFileSync(path.join(APP_DIRECTORY, 'public', 'index.html'), 'utf8');
  const nonce = randomBytes(18).toString('base64url');
  return {
    nonce,
    html: template
      .replaceAll('__TASK_CONTROL_TOKEN__', JSON.stringify(token))
      .replaceAll('__TASK_CONTROL_VERSION__', VERSION)
      .replaceAll('__TASK_CONTROL_NONCE__', nonce),
  };
}

function powershellPath() {
  return path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function launchEndLocalWork(delayMilliseconds) {
  const script = path.join(APP_DIRECTORY, 'Stop-AllLocalCodexWork.ps1');
  if (!fs.existsSync(script)) throw new Error('The local-work shutdown script is missing.');
  const child = spawn(powershellPath(), [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', script,
    '-DelayMilliseconds', String(delayMilliseconds),
  ], {
    cwd: APP_DIRECTORY,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.unref();
}

export function createControlCenter(config = loadConfig()) {
  const origin = `http://${HOST}:${config.port}`;
  const token = randomBytes(32).toString('hex');
  const acceptedRequests = new Set();
  const startedAt = Date.now();
  let server;

  server = http.createServer(async (request, response) => {
    const host = request.headers.host;
    if (host !== `${HOST}:${config.port}`) return sendJson(response, 403, { error: 'Invalid host.' });
    const requestUrl = new URL(request.url, origin);

    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      return sendJson(response, 200, {
        app: 'codex-task-control',
        version: VERSION,
        usageSchemaVersion: USAGE_SCHEMA_VERSION,
        host: HOST,
        port: config.port,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      });
    }

    if (request.method === 'GET' && requestUrl.pathname === '/favicon.ico') {
      response.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
      return response.end();
    }

    if (request.method === 'GET' && requestUrl.pathname === '/') {
      const rendered = renderHtml(token);
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${rendered.nonce}'; style-src 'nonce-${rendered.nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      return response.end(rendered.html);
    }

    const routes = new Set([
      '/api/dashboard',
      '/api/tasks',
      '/api/spelling',
      '/api/stats',
      '/api/intelligence',
      '/api/raw-stats',
      '/api/annotations',
      '/api/status',
      '/api/send',
      '/api/shutdown',
      '/api/end-local-work',
    ]);
    if (request.method !== 'POST' || !routes.has(requestUrl.pathname)) {
      return sendJson(response, 404, { error: 'Not found.' });
    }
    if (
      request.headers.origin !== origin
      || request.headers['x-codex-task-control-token'] !== token
      || !String(request.headers['content-type'] || '').startsWith('application/json')
    ) {
      return sendJson(response, 403, { error: 'Request rejected.' });
    }

    try {
      const bodyLimit = requestUrl.pathname === '/api/send'
        ? config.maxPromptBytes + 4096
        : requestUrl.pathname === '/api/spelling' ? 4096 : 65536;
      const body = await readBody(request, bodyLimit);

      if (requestUrl.pathname === '/api/dashboard') {
        const requestedThreadId = body.threadId ? String(body.threadId).toLowerCase() : null;
        if (requestedThreadId && !patterns.THREAD_ID.test(requestedThreadId)) throw new Error('Select a valid Codex task.');
        const [threadResult, usageResult, projectResult] = await Promise.allSettled([
          listCodexThreads(50),
          getCodexUsageLimits(),
          listCodexProjects(),
        ]);
        if (threadResult.status === 'rejected') throw threadResult.reason;
        const usagePayload = usageResult.status === 'fulfilled' ? usageResult.value : null;
        const projectPayload = projectResult.status === 'fulfilled' ? projectResult.value : null;
        const historyTasks = localCodexTaskHistory();
        const summary = dashboardSummary(
          threadResult.value,
          usagePayload,
          config.recentTaskLimit,
          projectPayload,
          historyTasks,
          requestedThreadId,
        );
        summary.usageError = usageResult.status === 'rejected' ? usageResult.reason.message : null;
        summary.server = {
          version: VERSION,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          endLocalWorkEnabled: config.enableEndLocalWork,
          usageIntelligenceEnabled: true,
          usageAnnotationsEnabled: config.enableUsageAnnotations,
        };
        return sendJson(response, 200, summary);
      }

      if (requestUrl.pathname === '/api/tasks') {
        const offset = body.offset === undefined ? 0 : Number(body.offset);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) {
          throw new Error('Task page offset must be a non-negative integer.');
        }
        const [threadResult, projectResult] = await Promise.allSettled([
          listCodexThreads(50),
          listCodexProjects(),
        ]);
        if (threadResult.status === 'rejected') throw threadResult.reason;
        const projectPayload = projectResult.status === 'fulfilled' ? projectResult.value : null;
        return sendJson(response, 200, taskPageSummary(
          threadResult.value,
          localCodexTaskHistory(),
          projectPayload,
          offset,
          config.recentTaskLimit,
        ));
      }

      if (requestUrl.pathname === '/api/spelling') {
        return sendJson(response, 200, await suggestSpelling({
          word: body.word,
          language: body.language,
          limit: 6,
        }));
      }

      if (requestUrl.pathname === '/api/stats') {
        const [threadResult, usageResult, projectResult] = await Promise.allSettled([
          listCodexThreads(50),
          getCodexUsageLimits(),
          listCodexProjects(),
        ]);
        if (threadResult.status === 'rejected') throw threadResult.reason;
        const projectPayload = projectResult.status === 'fulfilled' ? projectResult.value : null;
        const files = localSessionStorageFiles();
        const storage = sessionStorageSummary(files, threadResult.value, Date.now(), projectPayload, localCodexTaskHistory());
        await resolveStorageTaskIdentities(storage, projectPayload);
        return sendJson(response, 200, {
          storage,
          usage: usageSummary(usageResult.status === 'fulfilled' ? usageResult.value : null),
          usageError: usageResult.status === 'rejected' ? usageResult.reason.message : null,
        });
      }

      if (requestUrl.pathname === '/api/intelligence' || requestUrl.pathname === '/api/raw-stats') {
        const requestedThreadId = body.threadId ? String(body.threadId).toLowerCase() : null;
        if (requestedThreadId && !patterns.THREAD_ID.test(requestedThreadId)) throw new Error('Select a valid Codex task.');
        const analyzeAll = !requestedThreadId && body.analyzeAll === true;
        const [threadResult, usageResult, projectResult] = await Promise.allSettled([
          listCodexThreads(50),
          getCodexUsageLimits(),
          listCodexProjects(),
        ]);
        const threadPayload = threadResult.status === 'fulfilled' ? threadResult.value : { threads: [], pinnedThreads: [] };
        const projectPayload = projectResult.status === 'fulfilled' ? projectResult.value : null;
        const identities = usageIdentityMap(threadPayload, projectPayload, localCodexTaskHistory());
        if (requestedThreadId && !identities[requestedThreadId]) {
          try {
            const identity = await getThreadIdentity(requestedThreadId);
            identities[requestedThreadId] = {
              ...identity,
              projectLabel: projectLabelForTask(identity, projectPayload),
            };
          } catch {
            // A local session can still be analyzed even when the host cannot resolve its title.
          }
        }
        const intelligence = await buildUsageIntelligence(localSessionStorageFiles(), {
          threadId: requestedThreadId,
          windowDays: config.analyticsWindowDays,
          maxSessions: config.analyticsMaxSessions,
          ignoreMaxBytes: true,
          analyzeAll,
          includeArchived: config.analyticsIncludeArchived,
          measurePromptSize: config.measurePromptSize,
          force: body.force === true,
          identities,
          annotations: readUsageAnnotations(ANNOTATIONS_PATH),
          taskTokenBudget: config.taskTokenBudget,
          dailyTokenBudget: config.dailyTokenBudget,
          modelPricingUsdPerMillion: config.modelPricingUsdPerMillion,
        });
        return sendJson(response, 200, {
          intelligence,
          usage: usageSummary(usageResult.status === 'fulfilled' ? usageResult.value : null),
          usageError: usageResult.status === 'rejected' ? usageResult.reason.message : null,
          hostError: threadResult.status === 'rejected' ? threadResult.reason.message : null,
          configuration: {
            windowDays: config.analyticsWindowDays,
            maxSessions: config.analyticsMaxSessions,
            byteLimitApplied: false,
            analyzeAllAvailable: true,
            includeArchived: config.analyticsIncludeArchived,
            promptSizeMeasurementEnabled: config.measurePromptSize,
            annotationsEnabled: config.enableUsageAnnotations,
            taskTokenBudget: config.taskTokenBudget || null,
            dailyTokenBudget: config.dailyTokenBudget || null,
            pricedModels: Object.keys(config.modelPricingUsdPerMillion),
          },
        });
      }

      if (requestUrl.pathname === '/api/annotations') {
        if (!config.enableUsageAnnotations) throw new Error('Usage annotations are disabled in config.json.');
        const threadId = String(body.threadId || '').toLowerCase();
        const turnId = body.turnId ? String(body.turnId).toLowerCase() : null;
        if (!patterns.THREAD_ID.test(threadId)) throw new Error('Select a valid Codex task.');
        if (body.action === 'list') {
          const store = readUsageAnnotations(ANNOTATIONS_PATH);
          return sendJson(response, 200, { annotations: store.turns?.[threadId] || {} });
        }
        if (!patterns.THREAD_ID.test(turnId || '')) throw new Error('Select a valid Codex turn.');
        if (body.action === 'delete') {
          return sendJson(response, 200, deleteTurnAnnotation(ANNOTATIONS_PATH, threadId, turnId));
        }
        if (body.action !== 'upsert') throw new Error('Choose a valid annotation action.');
        const annotation = saveTurnAnnotation(ANNOTATIONS_PATH, threadId, turnId, body.annotation || {});
        return sendJson(response, 200, { saved: true, annotation });
      }

      if (requestUrl.pathname === '/api/status') {
        const threadId = String(body.threadId || '').toLowerCase();
        if (!patterns.THREAD_ID.test(threadId)) throw new Error('Select a valid Codex task.');
        const { snapshot } = await getThreadSnapshot(threadId);
        const turn = snapshot.turns?.[0];
        return sendJson(response, 200, {
          threadId,
          title: snapshot.thread.title || null,
          taskStatus: snapshot.thread.status?.type || null,
          latestTurnId: turn?.id || null,
          latestTurnStatus: turn?.status || null,
          reply: turn?.status === 'completed' ? latestAssistantReply(threadId, turn.startedAt) : null,
        });
      }

      if (requestUrl.pathname === '/api/send') {
        const threadId = String(body.threadId || '').toLowerCase();
        const prompt = String(body.prompt || '').trim();
        const requestId = String(body.requestId || '');
        if (!patterns.THREAD_ID.test(threadId)) throw new Error('Select a valid Codex task.');
        if (!prompt) throw new Error('Write a follow-up message first.');
        if (Buffer.byteLength(prompt, 'utf8') > config.maxPromptBytes) throw new Error('The follow-up is too long.');
        if (!patterns.THREAD_ID.test(requestId)) throw new Error('Invalid send request.');
        if (acceptedRequests.has(requestId)) return sendJson(response, 200, { accepted: true, duplicate: true });
        const submittedAt = Date.now();
        const result = await sendThreadFollowUp(threadId, prompt);
        const measurement = estimatePromptMeasurement(prompt, 'control-centre');
        if (measurement) {
          recordPendingPromptMeasurement(ANNOTATIONS_PATH, threadId, {
            ...measurement,
            id: requestId,
            submittedAt,
          });
        }
        acceptedRequests.add(requestId);
        if (acceptedRequests.size > 100) acceptedRequests.delete(acceptedRequests.values().next().value);
        return sendJson(response, 200, result);
      }

      if (requestUrl.pathname === '/api/shutdown') {
        if (body.confirmation !== 'STOP CONTROL CENTRE') throw new Error('The confirmation phrase did not match.');
        sendJson(response, 202, { stopping: true });
        setTimeout(() => server.close(() => process.exit(0)), 250);
        return;
      }

      if (!config.enableEndLocalWork) throw new Error('Ending local Codex work is disabled in config.json.');
      if (body.confirmation !== 'END LOCAL WORK') throw new Error('The confirmation phrase did not match.');
      launchEndLocalWork(900);
      return sendJson(response, 202, { stopping: true });
    } catch (error) {
      return sendJson(response, 400, { error: error.message || 'The request failed.' });
    }
  });

  return { server, config, origin };
}

export async function run(config = loadConfig()) {
  const { server, origin } = createControlCenter(config);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, HOST, resolve);
  });
  process.stdout.write(`Codex Command and Control is ready at ${origin}\n`);
  return server;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  run().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
