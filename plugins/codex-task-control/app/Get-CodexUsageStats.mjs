import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getCodexUsageLimits,
  listCodexProjects,
  listCodexThreads,
  localCodexThreads,
  localSessionStorageFiles,
  patterns,
} from './CodexHostBridge.mjs';
import { buildUsageIntelligence } from './UsageIntelligence.mjs';
import { readUsageAnnotations } from './UsageAnnotations.mjs';
import { loadConfig } from './ControlCenter.mjs';

const APP_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

function usageSummary(payload) {
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

function projectLabel(task, projectPayload) {
  const projects = projectPayload?.projects || [];
  const byId = task?.projectId && projects.find((project) => project.projectId === task.projectId);
  if (byId?.label) return byId.label;
  const taskPath = normalizeProjectPath(task?.cwd);
  return projects.find((project) => normalizeProjectPath(project.path) === taskPath)?.label || 'Projectless';
}

function parseInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a whole number from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

export function parseArguments(argv) {
  const options = {
    threadId: null,
    windowDays: 30,
    maxSessions: 50,
    maxBytes: 1_073_741_824,
    includeArchived: false,
    measurePromptSize: false,
    force: false,
    pretty: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--thread' || argument === '--task') options.threadId = String(argv[++index] || '').toLowerCase();
    else if (argument === '--days') options.windowDays = parseInteger(argv[++index], '--days', 1, 3650);
    else if (argument === '--max') options.maxSessions = parseInteger(argv[++index], '--max', 1, 1000);
    else if (argument === '--max-bytes') options.maxBytes = parseInteger(argv[++index], '--max-bytes', 1_048_576, 10_737_418_240);
    else if (argument === '--include-archived') options.includeArchived = true;
    else if (argument === '--measure-prompt-size') options.measurePromptSize = true;
    else if (argument === '--force') options.force = true;
    else if (argument === '--pretty') options.pretty = true;
    else if (argument === '--all') {
      options.windowDays = 3650;
      options.maxSessions = 1000;
      options.maxBytes = 10_737_418_240;
      options.includeArchived = true;
    } else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--recent') {
      // Recent is the default and is accepted for readability in agent commands.
    } else throw new Error(`Unknown option: ${argument}`);
  }
  if (options.threadId && !patterns.THREAD_ID.test(options.threadId)) throw new Error('--thread must be a valid Codex task ID.');
  return options;
}

function helpText() {
  return [
    'Codex Command and Control usage statistics',
    '',
    'Usage:',
    '  node Get-CodexUsageStats.mjs --thread <task-id> --pretty',
    '  node Get-CodexUsageStats.mjs --recent --days 30 --max 50 --pretty',
    '  node Get-CodexUsageStats.mjs --all --pretty',
    '',
    'Options:',
    '  --thread, --task <id>     Analyze one task, including archived records.',
    '  --recent                  Analyze bounded recent local records (default).',
    '  --days <1-3650>           Recent activity window (default 30).',
    '  --max <1-1000>            Maximum recent session files (default 50).',
    '  --max-bytes <bytes>       Maximum recent bytes to scan (default 1 GiB).',
    '  --include-archived        Include archived records in a recent scan.',
    '  --measure-prompt-size     Locally estimate available prompt sizes; text is discarded.',
    '  --force                   Ignore the in-memory parser cache.',
    '  --pretty                  Indent JSON output.',
    '',
    'The JSON never contains prompt text, command text, tool arguments, tool outputs, or account IDs.',
  ].join('\n');
}

async function hostMetadata() {
  const [threads, projects, usage] = await Promise.allSettled([
    listCodexThreads(50),
    listCodexProjects(),
    getCodexUsageLimits(),
  ]);
  const projectPayload = projects.status === 'fulfilled' ? projects.value : null;
  const identities = {};
  if (threads.status === 'fulfilled') {
    for (const task of localCodexThreads(threads.value, 50)) {
      identities[task.id] = { ...task, projectLabel: projectLabel(task, projectPayload) };
    }
  }
  return {
    identities,
    planUsage: usageSummary(usage.status === 'fulfilled' ? usage.value : null),
    hostErrors: [
      threads.status === 'rejected' ? `tasks: ${threads.reason.message}` : null,
      projects.status === 'rejected' ? `projects: ${projects.reason.message}` : null,
      usage.status === 'rejected' ? `usage: ${usage.reason.message}` : null,
    ].filter(Boolean),
  };
}

export async function createRawUsageReport(options) {
  const annotationsPath = path.join(APP_DIRECTORY, 'usage-annotations.json');
  const config = loadConfig();
  const host = await hostMetadata();
  const intelligence = await buildUsageIntelligence(localSessionStorageFiles(), {
    ...options,
    identities: host.identities,
    annotations: readUsageAnnotations(annotationsPath),
    taskTokenBudget: config.taskTokenBudget,
    dailyTokenBudget: config.dailyTokenBudget,
    modelPricingUsdPerMillion: config.modelPricingUsdPerMillion,
  });
  return {
    app: 'codex-task-control',
    report: 'usage-intelligence',
    generatedAt: intelligence.generatedAt,
    planUsage: host.planUsage,
    hostErrors: host.hostErrors,
    ...intelligence,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const report = await createRawUsageReport(options);
  process.stdout.write(`${JSON.stringify(report, null, options.pretty ? 2 : 0)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
