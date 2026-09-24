import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const PIPE_DIRECTORY = '\\\\.\\pipe\\';
const PIPE_NAME = /^codex-browser-use-[0-9a-f-]{36}$/i;
const THREAD_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MAX_FRAME = 8 * 1024 * 1024;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_META_BYTES = 2 * 1024 * 1024;
let cachedPipe = null;
let cachedCallerThreadId = null;
let sessionIndexCache = null;
const sessionMetadataCache = new Map();

function exchange(pipe, method, params, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    const data = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), 'utf8');
    const frame = Buffer.alloc(4 + data.length);
    frame.writeUInt32LE(data.length, 0);
    data.copy(frame, 4);
    let incoming = Buffer.alloc(0);
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };

    socket.setTimeout(timeoutMs, () => finish(new Error('Codex did not respond in time.')));
    socket.on('connect', () => socket.write(frame));
    socket.on('data', (chunk) => {
      incoming = Buffer.concat([incoming, chunk]);
      if (incoming.length < 4) return;
      const length = incoming.readUInt32LE(0);
      if (length > MAX_FRAME) return finish(new Error('Codex returned an unexpectedly large response.'));
      if (incoming.length < length + 4) return;
      let response;
      try {
        response = JSON.parse(incoming.subarray(4, length + 4).toString('utf8'));
      } catch {
        return finish(new Error('Codex returned invalid JSON.'));
      }
      if (response.error) return finish(new Error(response.error.message || 'Codex rejected the request.'));
      finish(null, response.result);
    });
    socket.on('error', (error) => finish(error));
    socket.on('close', () => {
      if (!settled) finish(new Error('Codex closed the local connection.'));
    });
  });
}

function isAllowedPipe(value) {
  if (!value) return false;
  const normalized = String(value).replaceAll('/', '\\');
  return normalized.startsWith(PIPE_DIRECTORY) && PIPE_NAME.test(normalized.slice(PIPE_DIRECTORY.length));
}

export async function findHostPipe() {
  if (cachedPipe) {
    try {
      await exchange(cachedPipe, 'tools/list', { threadStartKind: 'all' }, 1000);
      return cachedPipe;
    } catch {
      cachedPipe = null;
      cachedCallerThreadId = null;
    }
  }

  const preferred = isAllowedPipe(process.env.CODEX_APP_TOOLS_PIPE_PATH)
    ? process.env.CODEX_APP_TOOLS_PIPE_PATH.replaceAll('/', '\\')
    : null;
  const discovered = fs.readdirSync(PIPE_DIRECTORY)
    .filter((name) => PIPE_NAME.test(name))
    .map((name) => PIPE_DIRECTORY + name);

  for (const candidate of new Set([preferred, ...discovered].filter(Boolean))) {
    try {
      const response = await exchange(candidate, 'tools/list', { threadStartKind: 'all' }, 1500);
      const supportsRequiredTools = response?.tools?.some(
        (tool) => tool.namespace === 'codex_app' && tool.name === 'send_message_to_thread',
      );
      if (supportsRequiredTools) {
        cachedPipe = candidate;
        return candidate;
      }
    } catch {
      // Probe the next live Codex host pipe.
    }
  }
  throw new Error('The running Codex desktop host could not be reached. Open Codex and try again.');
}

export async function callCodexAppTool(pipe, callerThreadId, tool, args, timeoutMs = 30000) {
  if (!THREAD_ID.test(callerThreadId)) throw new Error('Invalid caller task ID.');
  return exchange(pipe, 'tools/call', {
    arguments: args,
    callId: `task-control-${randomUUID()}`,
    namespace: 'codex_app',
    threadId: callerThreadId,
    tool,
    turnId: `task-control-${randomUUID()}`,
  }, timeoutMs);
}

export function parseToolPayload(result, fallbackMessage = 'Codex rejected the request.') {
  if (!result?.success) {
    const message = result?.contentItems?.find((item) => item.type === 'inputText')?.text;
    throw new Error(message || fallbackMessage);
  }
  const text = result.contentItems?.find((item) => item.type === 'inputText')?.text;
  if (!text) throw new Error('Codex returned no readable result.');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Codex returned an unreadable result.');
  }
}

function walkRecentSessionFiles(root, limit = 40) {
  if (!fs.existsSync(root)) return [];
  const stack = [root];
  const found = [];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const match = entry.name.match(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})/i);
      if (!match) continue;
      try {
        found.push({ id: match[1].toLowerCase(), modified: fs.statSync(full).mtimeMs });
      } catch {
        // A session can be rotated between enumeration and stat.
      }
    }
  }
  return found.sort((a, b) => b.modified - a.modified).slice(0, limit);
}

function walkSessionStorage(root, archived) {
  if (!fs.existsSync(root)) return [];
  const stack = [root];
  const found = [];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const match = entry.name.match(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})/i);
      if (!match) continue;
      try {
        const stat = fs.statSync(full);
        found.push({
          threadId: match[1].toLowerCase(),
          filePath: full,
          bytes: stat.size,
          updatedAt: stat.mtimeMs,
          archived,
        });
      } catch {
        // A session can be rotated between enumeration and stat.
      }
    }
  }
  return found;
}

export function localSessionStorageFiles() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return [
    ...walkSessionStorage(path.join(codexHome, 'sessions'), false),
    ...walkSessionStorage(path.join(codexHome, 'archived_sessions'), true),
  ];
}

function sessionIndexEntries(codexHome) {
  const filePath = path.join(codexHome, 'session_index.jsonl');
  if (!fs.existsSync(filePath)) return [];
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_INDEX_BYTES) return [];
  if (
    sessionIndexCache?.filePath === filePath
    && sessionIndexCache.size === stat.size
    && sessionIndexCache.updatedAt === stat.mtimeMs
  ) return sessionIndexCache.entries;

  const entries = [];
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (THREAD_ID.test(value?.id || '')) entries.push(value);
      } catch {
        // Ignore a partial index record while Codex is appending it.
      }
    }
  } catch {
    return [];
  }
  sessionIndexCache = { filePath, size: stat.size, updatedAt: stat.mtimeMs, entries };
  return entries;
}

function sessionMetadata(file) {
  const cached = sessionMetadataCache.get(file.filePath);
  if (cached?.size === file.bytes && cached.updatedAt === file.updatedAt) return cached.metadata;
  let descriptor;
  let metadata = null;
  try {
    descriptor = fs.openSync(file.filePath, 'r');
    let pending = Buffer.alloc(0);
    while (pending.length < MAX_SESSION_META_BYTES) {
      const chunk = Buffer.alloc(Math.min(32768, MAX_SESSION_META_BYTES - pending.length));
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, pending.length);
      if (!bytesRead) break;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      const newline = pending.indexOf(0x0a);
      if (newline >= 0) {
        pending = pending.subarray(0, newline);
        break;
      }
    }
    const entry = JSON.parse(pending.toString('utf8').replace(/\r$/, ''));
    if (entry?.type === 'session_meta' && entry.payload && typeof entry.payload === 'object') {
      metadata = {
        cwd: typeof entry.payload.cwd === 'string' ? entry.payload.cwd : null,
        thread_source: typeof entry.payload.thread_source === 'string' ? entry.payload.thread_source : null,
        subagent: entry.payload.thread_source === 'subagent'
          || Boolean(entry.payload.source && typeof entry.payload.source === 'object' && entry.payload.source.subagent),
      };
    }
  } catch {
    metadata = null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  sessionMetadataCache.set(file.filePath, { size: file.bytes, updatedAt: file.updatedAt, metadata });
  return metadata;
}

function isUserTaskMetadata(metadata) {
  if (!metadata) return true;
  if (metadata.subagent === true) return false;
  if (metadata.thread_source === 'subagent') return false;
  if (metadata.source && typeof metadata.source === 'object' && metadata.source.subagent) return false;
  return true;
}

export function localTaskHistoryFromRecords(indexEntries = [], sessionEntries = [], state = {}) {
  const indexById = new Map();
  for (const [position, entry] of indexEntries.entries()) {
    const id = String(entry?.id || '').toLowerCase();
    if (!THREAD_ID.test(id)) continue;
    const updatedAt = Number.isFinite(Date.parse(entry.updated_at)) ? Date.parse(entry.updated_at) : 0;
    const existing = indexById.get(id);
    if (!existing || updatedAt > existing.updatedAt || (updatedAt === existing.updatedAt && position > existing.position)) {
      indexById.set(id, {
        title: typeof entry.thread_name === 'string' && entry.thread_name.trim() ? entry.thread_name.trim() : null,
        updatedAt,
        position,
      });
    }
  }

  const currentById = new Map();
  for (const file of sessionEntries) {
    const id = String(file?.threadId || '').toLowerCase();
    if (!THREAD_ID.test(id) || file.archived === true || !isUserTaskMetadata(file.metadata)) continue;
    const existing = currentById.get(id) || { updatedAt: 0, cwd: null };
    existing.updatedAt = Math.max(existing.updatedAt, Number(file.updatedAt) || 0);
    existing.cwd = file.metadata?.cwd || existing.cwd;
    currentById.set(id, existing);
  }

  const assignments = state?.['thread-project-assignments'] || {};
  const localProjects = state?.['local-projects'] || {};
  const pinned = new Set((state?.['pinned-thread-ids'] || []).map((id) => String(id).toLowerCase()));
  return [...currentById.entries()]
    .map(([id, session]) => {
      const indexed = indexById.get(id);
      const projectId = assignments[id]?.projectId || null;
      const project = projectId ? localProjects[projectId] : null;
      return {
        id,
        title: indexed?.title || `Task ${id.slice(0, 8)}`,
        status: 'notLoaded',
        updatedAt: Math.max(session.updatedAt, indexed?.updatedAt || 0),
        cwd: session.cwd,
        projectId,
        projectLabel: typeof project?.name === 'string' && project.name.trim() ? project.name.trim() : null,
        pinned: pinned.has(id),
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function localCodexTaskHistory() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const files = localSessionStorageFiles().map((file) => ({ ...file, metadata: sessionMetadata(file) }));
  return localTaskHistoryFromRecords(sessionIndexEntries(codexHome), files);
}

export function recentSessionThreadIds() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const preferred = THREAD_ID.test(process.env.CODEX_THREAD_ID || '')
    ? [process.env.CODEX_THREAD_ID.toLowerCase()]
    : [];
  const sessions = walkRecentSessionFiles(path.join(codexHome, 'sessions'));
  return [...new Set([...preferred, ...sessions.map((item) => item.id)])];
}

async function resolveCaller(pipe) {
  if (cachedCallerThreadId) return cachedCallerThreadId;
  for (const candidate of recentSessionThreadIds()) {
    try {
      const result = await callCodexAppTool(pipe, candidate, 'list_threads', { limit: 1 }, 5000);
      if (result?.success) {
        cachedCallerThreadId = candidate;
        return candidate;
      }
    } catch {
      // Try the next recent local task as the caller context.
    }
  }
  throw new Error('No local Codex task could be used to query the running app. Open a Codex task and refresh.');
}

export async function listCodexThreads(limit = 30) {
  const pipe = await findHostPipe();
  const caller = await resolveCaller(pipe);
  const result = await callCodexAppTool(pipe, caller, 'list_threads', { limit });
  return parseToolPayload(result, 'Codex could not list local tasks.');
}

export async function getCodexUsageLimits() {
  const pipe = await findHostPipe();
  const caller = await resolveCaller(pipe);
  const result = await callCodexAppTool(pipe, caller, 'get_usage_limits', {});
  return parseToolPayload(result, 'Codex could not read usage limits.');
}

export async function listCodexProjects() {
  const pipe = await findHostPipe();
  const caller = await resolveCaller(pipe);
  const result = await callCodexAppTool(pipe, caller, 'list_projects', {});
  return parseToolPayload(result, 'Codex could not list projects.');
}

export async function getThreadSnapshot(threadId) {
  if (!THREAD_ID.test(threadId)) throw new Error('Select a valid Codex task.');
  const pipe = await findHostPipe();
  const result = await callCodexAppTool(pipe, threadId, 'read_thread', {
    threadId,
    turnLimit: 1,
    includeOutputs: false,
    maxOutputCharsPerItem: 500,
  });
  const snapshot = parseToolPayload(result, 'Codex could not read this task.');
  if (snapshot?.thread?.id !== threadId) throw new Error('The selected task did not resolve.');
  return { pipe, snapshot };
}

export async function getThreadIdentity(threadId) {
  const { snapshot } = await getThreadSnapshot(threadId);
  return {
    id: snapshot.thread.id,
    title: snapshot.thread.title || null,
    status: snapshot.thread.status?.type || null,
    cwd: snapshot.thread.cwd || null,
    projectId: snapshot.thread.projectId || null,
  };
}

export async function sendThreadFollowUp(threadId, prompt) {
  const { pipe, snapshot } = await getThreadSnapshot(threadId);
  const turn = snapshot.turns?.[0];
  if (snapshot.thread.status?.type !== 'idle') {
    throw new Error('This task is active. Wait for it to finish before sending a follow-up.');
  }
  if (!['completed', 'interrupted', 'failed'].includes(turn?.status)) {
    throw new Error('Codex has not marked the latest turn as finished.');
  }
  const result = await callCodexAppTool(pipe, threadId, 'send_message_to_thread', { threadId, prompt }, 30000);
  if (!result?.success) {
    const message = result?.contentItems?.find((item) => item.type === 'inputText')?.text;
    throw new Error(message || 'Codex refused the follow-up.');
  }
  return { accepted: true, previousTurnId: turn?.id ?? null, title: snapshot.thread.title ?? null };
}

function findSessionFile(threadId) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  for (const folder of ['sessions', 'archived_sessions']) {
    const root = path.join(codexHome, folder);
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith('.jsonl')) return full;
      }
    }
  }
  return null;
}

export function latestAssistantReply(threadId, sinceUnixSeconds) {
  const file = findSessionFile(threadId);
  if (!file) return null;
  const descriptor = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(descriptor).size;
    const length = Math.min(size, 4 * 1024 * 1024);
    const bytes = Buffer.alloc(length);
    fs.readSync(descriptor, bytes, 0, length, size - length);
    const lines = bytes.toString('utf8').split(/\r?\n/);
    if (size > length) lines.shift();
    let reply = null;
    for (const line of lines) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (sinceUnixSeconds && Date.parse(entry.timestamp) / 1000 < sinceUnixSeconds - 1) continue;
      if (entry.type === 'event_msg' && entry.payload?.type === 'task_started') reply = null;
      if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload?.role === 'assistant') {
        const text = entry.payload.content
          ?.filter((part) => part.type === 'output_text')
          .map((part) => part.text)
          .join('\n');
        if (text) reply = text;
      }
    }
    return reply;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function normalizeUpdatedAt(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}

export function localCodexThreads(payload, limit = 30) {
  const items = [...(payload?.threads || []), ...(payload?.pinnedThreads || [])];
  const seen = new Set();
  return items
    .filter((item) => item?.kind === 'codex' && (!item.hostId || item.hostId === 'local'))
    .filter((item) => {
      if (!THREAD_ID.test(item.id || '') || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .map((item) => ({
      id: item.id,
      title: item.title || 'Untitled Codex task',
      status: item.status || 'unknown',
      updatedAt: normalizeUpdatedAt(item.updatedAt),
      cwd: item.cwd || null,
      projectId: item.projectId || null,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

export function mergeLocalCodexTasks(payload, historyTasks = []) {
  const merged = new Map();
  for (const task of historyTasks) {
    if (!THREAD_ID.test(task?.id || '')) continue;
    merged.set(task.id, { ...task });
  }
  for (const live of localCodexThreads(payload, 500)) {
    const historical = merged.get(live.id) || {};
    merged.set(live.id, {
      ...historical,
      ...live,
      title: live.title || historical.title || `Task ${live.id.slice(0, 8)}`,
      updatedAt: Math.max(Number(live.updatedAt) || 0, Number(historical.updatedAt) || 0),
      cwd: live.cwd || historical.cwd || null,
      projectId: live.projectId || historical.projectId || null,
      projectLabel: historical.projectLabel || null,
      pinned: historical.pinned === true,
    });
  }
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export const patterns = { THREAD_ID };
