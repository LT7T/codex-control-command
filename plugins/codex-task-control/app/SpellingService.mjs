import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = path.join(APP_DIRECTORY, 'Get-SpellingSuggestions.ps1');
const WORD_PATTERN = /^[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*$/u;
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const MAX_OUTPUT_BYTES = 65536;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_LIMIT = 500;
const cache = new Map();
const inFlight = new Map();

function powershellPath() {
  return path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function validateSpellingRequest(input = {}) {
  const word = String(input.word || '').normalize('NFC').trim();
  const language = String(input.language || 'en-US').trim();
  const limit = input.limit === undefined ? 6 : Number(input.limit);
  if (!word || [...word].length > 64 || Buffer.byteLength(word, 'utf8') > 256 || !WORD_PATTERN.test(word)) {
    throw new Error('Choose one word containing letters, apostrophes, or hyphens.');
  }
  if (!LANGUAGE_PATTERN.test(language) || language.length > 35) {
    throw new Error('The spelling language is not valid.');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) {
    throw new Error('The spelling suggestion limit must be from 1 to 8.');
  }
  return { word, language, limit };
}

export function sanitizeSpellingResult(input, limit = 6) {
  const suggestions = [];
  for (const value of Array.isArray(input?.suggestions) ? input.suggestions : []) {
    const suggestion = String(value || '').normalize('NFC').trim();
    if (!suggestion || [...suggestion].length > 80 || /[\u0000-\u001f\u007f]/u.test(suggestion)) continue;
    if (!suggestions.includes(suggestion)) suggestions.push(suggestion);
    if (suggestions.length >= limit) break;
  }
  return {
    available: input?.available === true,
    language: typeof input?.language === 'string' && LANGUAGE_PATTERN.test(input.language) ? input.language : null,
    misspelled: typeof input?.misspelled === 'boolean' ? input.misspelled : null,
    suggestions,
  };
}

function runHelper(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershellPath(), [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      HELPER_PATH,
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('The local spelling service timed out.')), 7000);
    child.stdout.on('data', (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > MAX_OUTPUT_BYTES) finish(new Error('The local spelling service returned too much data.'));
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) finish(new Error('The local spelling service failed.'));
    });
    child.on('error', () => finish(new Error('The local spelling service could not start.')));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) return finish(new Error('The local spelling service failed.'));
      try {
        finish(null, JSON.parse(stdout.toString('utf8')));
      } catch {
        finish(new Error('The local spelling service returned invalid data.'));
      }
    });
    child.stdin.on('error', () => finish(new Error('The local spelling service could not read the word.')));
    child.stdin.end(`${JSON.stringify(request)}\n`, 'utf8');
  });
}

export async function suggestSpelling(input = {}) {
  const request = validateSpellingRequest(input);
  const key = `${request.language.toLowerCase()}\u0000${request.word.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) return cached.value;
  if (inFlight.has(key)) return inFlight.get(key);

  const pending = runHelper(request)
    .then((result) => sanitizeSpellingResult(result, request.limit))
    .catch(() => ({ available: false, language: null, misspelled: null, suggestions: [] }))
    .then((result) => {
      if (result.available) {
        cache.set(key, { createdAt: Date.now(), value: result });
        if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
      }
      return result;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}
