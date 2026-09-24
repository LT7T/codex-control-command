import fs from 'node:fs';
import path from 'node:path';

const THREAD_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const TURN_ID = THREAD_ID;
const MAX_LABEL_LENGTH = 80;
const MAX_PENDING_PROMPTS = 50;
const MAX_STORE_BYTES = 4 * 1024 * 1024;

function emptyStore() {
  return {
    schemaVersion: 1,
    updatedAt: null,
    turns: {},
    pendingPrompts: {},
  };
}

function boundedText(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (text.length > MAX_LABEL_LENGTH) throw new Error(`${field} must be ${MAX_LABEL_LENGTH} characters or fewer.`);
  return text || null;
}

function optionalBoolean(value, field) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'boolean') throw new Error(`${field} must be true, false, or empty.`);
  return value;
}

export function validateTurnAnnotation(input = {}) {
  const rating = input.rating === null || input.rating === undefined || input.rating === ''
    ? null
    : Number(input.rating);
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    throw new Error('rating must be a whole number from 1 to 5, or empty.');
  }
  const reviewMinutes = input.reviewMinutes === null || input.reviewMinutes === undefined || input.reviewMinutes === ''
    ? null
    : Number(input.reviewMinutes);
  if (reviewMinutes !== null && (!Number.isFinite(reviewMinutes) || reviewMinutes < 0 || reviewMinutes > 10080)) {
    throw new Error('reviewMinutes must be from 0 to 10080, or empty.');
  }
  return {
    rating,
    accepted: optionalBoolean(input.accepted, 'accepted'),
    requiredCorrection: optionalBoolean(input.requiredCorrection, 'requiredCorrection'),
    category: boundedText(input.category, 'category'),
    strategy: boundedText(input.strategy, 'strategy'),
    reviewMinutes,
    updatedAt: new Date().toISOString(),
  };
}

export function readUsageAnnotations(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return emptyStore();
  try {
    if (fs.statSync(filePath).size > MAX_STORE_BYTES) throw new Error('the file is larger than 4 MiB');
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    return {
      ...emptyStore(),
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
      turns: parsed?.turns && typeof parsed.turns === 'object' ? parsed.turns : {},
      pendingPrompts: parsed?.pendingPrompts && typeof parsed.pendingPrompts === 'object' ? parsed.pendingPrompts : {},
    };
  } catch (error) {
    throw new Error(`Could not read the local usage annotations: ${error.message}`);
  }
}

function writeStore(filePath, store) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const updated = { ...store, schemaVersion: 1, updatedAt: new Date().toISOString() };
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
  return updated;
}

function requireIds(threadId, turnId = null) {
  if (!THREAD_ID.test(threadId || '')) throw new Error('A valid Codex task ID is required.');
  if (turnId !== null && !TURN_ID.test(turnId || '')) throw new Error('A valid Codex turn ID is required.');
}

export function saveTurnAnnotation(filePath, threadId, turnId, input) {
  requireIds(threadId, turnId);
  const store = readUsageAnnotations(filePath);
  store.turns[threadId] ||= {};
  store.turns[threadId][turnId] = validateTurnAnnotation(input);
  return writeStore(filePath, store).turns[threadId][turnId];
}

export function deleteTurnAnnotation(filePath, threadId, turnId) {
  requireIds(threadId, turnId);
  const store = readUsageAnnotations(filePath);
  if (store.turns[threadId]) {
    delete store.turns[threadId][turnId];
    if (!Object.keys(store.turns[threadId]).length) delete store.turns[threadId];
  }
  writeStore(filePath, store);
  return { deleted: true };
}

export function recordPendingPromptMeasurement(filePath, threadId, measurement) {
  requireIds(threadId);
  const submittedAt = Number(measurement?.submittedAt) || Date.now();
  const normalized = {
    id: String(measurement?.id || ''),
    submittedAt,
    characters: Math.max(0, Number(measurement?.characters) || 0),
    words: Math.max(0, Number(measurement?.words) || 0),
    utf8Bytes: Math.max(0, Number(measurement?.utf8Bytes) || 0),
    estimatedTokens: Math.max(0, Number(measurement?.estimatedTokens) || 0),
    source: 'control-centre',
  };
  const store = readUsageAnnotations(filePath);
  const prompts = Array.isArray(store.pendingPrompts[threadId]) ? store.pendingPrompts[threadId] : [];
  store.pendingPrompts[threadId] = [...prompts, normalized]
    .sort((a, b) => a.submittedAt - b.submittedAt)
    .slice(-MAX_PENDING_PROMPTS);
  writeStore(filePath, store);
  return normalized;
}

export function annotationForTurn(store, threadId, turnId) {
  return store?.turns?.[threadId]?.[turnId] || null;
}

export function matchPendingPromptMeasurements(store, threadId, turns) {
  const pending = [...(store?.pendingPrompts?.[threadId] || [])].sort((a, b) => a.submittedAt - b.submittedAt);
  const orderedTurns = [...turns].filter((turn) => turn.startedAt).sort((a, b) => a.startedAt - b.startedAt);
  const used = new Set();
  for (const turn of orderedTurns) {
    if (turn.promptMeasurement) continue;
    const candidate = pending.find((item, index) => !used.has(index) && turn.startedAt >= item.submittedAt - 2000);
    if (!candidate) continue;
    const index = pending.indexOf(candidate);
    used.add(index);
    turn.promptMeasurement = { ...candidate };
  }
  return turns;
}

export const annotationPatterns = { THREAD_ID, TURN_ID };
