// PostToolUse Hook — Context Inflation Suppressor
// S1: Bash output truncation (head+tail)
// S2: Read offset/limit reminder (warn-only)
// S3: WebSearch chain summarization (file-persisted across invocations)
// S5: Session cost tracking (file-persisted across invocations)
//
// Based on 22-argument validation of 18 sessions × 7 models.
// Theoretical basis: arXiv:2604.22750 §7.2 "budget-aware tool-use policies"

import type { SuppressorConfig } from '../src/types.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';

// === File-based Session State ===

const STATE_DIR = join(process.env.HOME || '/tmp', '.claude', 'plugins', 'cache', 'prompt-optimizer', 'state');

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

interface SuppressionStats {
  /** S1: Bash truncation — chars trimmed & estimated token savings */
  bashTruncations: number;
  bashCharsBefore: number;
  bashCharsAfter: number;
  /** S2: Read reminders — count only (savings depend on user action) */
  readReminders: number;
  /** S3: WebSearch chain warnings triggered */
  searchChainWarnings: number;
  searchSearchesPrevented: number; // estimated searches avoided after warning
  /** S5: cost alerts triggered */
  costAlerts: number;
}

interface SessionState {
  searchHistory: Array<{
    topic: string;
    keywords: string[];
    count: number;
    findings: string[];
    firstRound: number;
    triggeredCount: number;
  }>;
  costTracker: {
    totalInputTokens: number;
    totalOutputTokens: number;
    rounds: number;
    lastAlertThreshold: number;
    pricePerM: number;
  } | null;
  suppressionStats: SuppressionStats;
}

function loadState(sessionId: string): SessionState {
  ensureStateDir();
  const path = join(STATE_DIR, `${sessionId}.json`);
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { searchHistory: [], costTracker: null, suppressionStats: { bashTruncations: 0, bashCharsBefore: 0, bashCharsAfter: 0, readReminders: 0, searchChainWarnings: 0, searchSearchesPrevented: 0, costAlerts: 0 } };
  }
}

function saveState(sessionId: string, state: SessionState): void {
  ensureStateDir();
  const path = join(STATE_DIR, `${sessionId}.json`);
  writeFileSync(path, JSON.stringify(state));
}

// === S1: Bash Output Truncation ===

/**
 * Truncate large Bash output to head+tail, preserving exit code and errors.
 * Returns the truncated content, or null if no truncation needed.
 */
function truncateBashOutput(
  content: string,
  config: SuppressorConfig['bash'],
): string | null {
  const maxLen = config.maxChars;
  if (content.length <= maxLen) return null;

  const head = content.slice(0, config.headChars);
  const tail = content.slice(-config.tailChars);
  const dropped = content.length - config.headChars - config.tailChars;

  return `${head}\n\n... [截断 ${dropped.toLocaleString()} 字符] ...\n\n${tail}`;
}

// === S2: Read Offset/Limit Reminder ===

/**
 * Generate a reminder for large file reads.
 */
function generateReadReminder(
  filePath: string,
  content: string,
  config: SuppressorConfig['read'],
): string | null {
  if (content.length <= config.maxChars) return null;

  const lines = content.split('\n').length;
  const sizeKB = Math.round(content.length / 1024);

  return [
    `\n[提示] 文件 "${filePath}" 较大 (${sizeKB}KB, ~${lines} 行)。`,
    '后续读取建议使用 offset/limit 参数，只读取需要的部分。',
  ].join(' ');
}

// === S3: WebSearch Chain Detection ===

/**
 * Extract search keywords from WebSearch tool input.
 */
function extractKeywords(input: Record<string, unknown>): string[] {
  const query = String(input?.query || input?.explanation || '');
  // Split into words, filter short/common words
  return query
    .toLowerCase()
    .split(/[\s,，。？！]+/)
    .filter((w) => w.length > 2)
    .slice(0, 5);
}

/**
 * Calculate keyword overlap between two sets.
 */
function keywordOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = new Set([...a].filter((x) => b.has(x)));
  return intersection.size / Math.max(a.size, b.size);
}

/**
 * Extract a brief summary from search results.
 */
function extractSearchSummary(content: string, maxItems: number): string {
  // Try to parse JSON search results
  try {
    const parsed = JSON.parse(content);
    if (parsed.organic && Array.isArray(parsed.organic)) {
      return parsed.organic
        .slice(0, maxItems)
        .map((r: { title?: string; link?: string }) => `- ${r.title || 'Untitled'}`)
        .join('\n');
    }
  } catch {
    // Not JSON, extract first few lines
  }

  const lines = content.split('\n').filter((l) => l.trim());
  return lines.slice(0, maxItems).join('\n');
}

/**
 * Check for search chains and generate summary injection.
 * Uses file-persisted state (Claude Code spawns a new process per hook call).
 */
function checkSearchChain(
  state: SessionState,
  sessionId: string,
  input: Record<string, unknown>,
  content: string,
  config: SuppressorConfig['websearch'],
): string | null {
  const history = state.searchHistory;

  const keywords = extractKeywords(input);
  if (keywords.length === 0) return null;

  const keywordSet = new Set(keywords);

  // Find matching topic
  let matchedEntry: typeof history[0] | null = null;
  for (const entry of history) {
    if (keywordOverlap(keywordSet, new Set(entry.keywords)) >= config.overlapThreshold) {
      matchedEntry = entry;
      break;
    }
  }

  if (matchedEntry) {
    matchedEntry.count++;
    const summary = extractSearchSummary(content, 3);
    if (summary) {
      matchedEntry.findings.push(summary);
    }
    // Save state for existing entries too (so count persists across hook invocations)
    saveState(sessionId, state);
  } else {
    const summary = extractSearchSummary(content, 3);
    history.push({
      topic: keywords.join(' '),
      keywords: [...keywordSet],
      count: 1,
      findings: summary ? [summary] : [],
      firstRound: 0,
      triggeredCount: 0,
    });
    saveState(sessionId, state);
    return null;
  }

  // Trigger chain warning at threshold
  if (matchedEntry.count >= config.chainThreshold) {
    const allFindings = matchedEntry.findings.slice(-5).join('\n');
    const totalSearches = matchedEntry.count + (matchedEntry.triggeredCount || 0);
    const warning = [
      `\n[搜索链检测] 你已就 "${matchedEntry.topic}" 搜索了 ${totalSearches} 次。`,
      '主要发现：',
      allFindings || '(无有效结果)',
      '建议：直接 Read 相关文件获取精确信息，而非继续搜索。',
    ].join('\n');

    // Track trigger history, then reset count to avoid repeated warnings
    matchedEntry.triggeredCount = totalSearches;
    matchedEntry.count = 0;

    return warning;
  }

  return null;
}

// === Main Hook ===

export interface PostToolUseResult {
  /** Modified tool result content (null = no change) */
  content?: string;
  /** Injection to append to the tool result */
  injection?: string;
  /** Whether to suppress the tool result entirely */
  suppress?: boolean;
}

export interface PostToolUseContext {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult: string;
  isError: boolean;
}

/**
 * Main PostToolUse handler.
 * Called by Claude Code after every tool execution.
 */
export function onPostToolUse(ctx: PostToolUseContext, config: SuppressorConfig): PostToolUseResult {
  const result: PostToolUseResult = {};
  const injections: string[] = [];

  // Load state for stats tracking
  const state = loadState(ctx.sessionId);
  const ss = state.suppressionStats;

  // === S1: Bash truncation ===
  if (config.bash.enabled && ctx.toolName === 'Bash' && !ctx.isError) {
    const truncated = truncateBashOutput(ctx.toolResult, config.bash);
    if (truncated) {
      result.content = truncated;
      ss.bashTruncations++;
      ss.bashCharsBefore += ctx.toolResult.length;
      ss.bashCharsAfter += truncated.length;
      saveState(ctx.sessionId, state);
    }
  }

  // === S2: Read reminder ===
  if (config.read.enabled && ctx.toolName === 'Read') {
    const filePath = String(ctx.toolInput?.file_path || ctx.toolInput?.filePath || '');
    const reminder = generateReadReminder(filePath, ctx.toolResult, config.read);
    if (reminder) {
      injections.push(reminder);
      ss.readReminders++;
      saveState(ctx.sessionId, state);
    }
  }

  // === S3: WebSearch chain ===
  if (config.websearch.enabled &&
      (ctx.toolName === 'WebSearch' || ctx.toolName === 'WebFetch' ||
       ctx.toolName === 'mcp__MiniMax__web_search')) {
    const chainWarning = checkSearchChain(state, ctx.sessionId, ctx.toolInput, ctx.toolResult, config.websearch);
    if (chainWarning) {
      injections.push(chainWarning);
      ss.searchChainWarnings++;
      // Estimate prevented searches: after warning, user typically stops that topic (saves ~3 searches = ~15K tokens)
      ss.searchSearchesPrevented += 3;
      saveState(ctx.sessionId, state);
    }
  }

  if (injections.length > 0) {
    result.injection = injections.join('\n\n');
  }

  return result;
}

/**
 * Reset session state (call on SessionStart in tests).
 * Only deletes — loadState returns defaults when file doesn't exist.
 */
export function resetSession(sessionId: string): void {
  const path = join(STATE_DIR, `${sessionId}.json`);
  try { unlinkSync(path); } catch { /* doesn't exist */ }
}

/**
 * Initialize a fresh session state (call on real SessionStart).
 * Creates the state file so viewer can see it immediately.
 */
export function initSession(sessionId: string): void {
  // Delete old state first
  const path = join(STATE_DIR, `${sessionId}.json`);
  try { unlinkSync(path); } catch { /* doesn't exist */ }
  // Create fresh state
  saveState(sessionId, {
    searchHistory: [],
    costTracker: null,
    suppressionStats: { bashTruncations: 0, bashCharsBefore: 0, bashCharsAfter: 0, readReminders: 0, searchChainWarnings: 0, searchSearchesPrevented: 0, costAlerts: 0 },
  });
}

// === S5: Session Cost Tracker (file-persisted) ===

const MODEL_PRICES: Record<string, number> = {
  'claude-opus-4-6': 1.50, 'claude-sonnet-4-6': 0.30,
  'deepseek-v4-pro': 0.14, 'MiniMax-M3': 2.0, 'MiniMax-M2.7': 2.0,
  'kimi-k2.6': 2.0, 'doubao-seed-2.0-code': 1.0, 'glm-5.1': 1.0,
};

export function trackSessionCost(
  sessionId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  thresholdsUsd: number[],
): string | null {
  const state = loadState(sessionId);
  let t = state.costTracker;
  if (!t) {
    t = {
      totalInputTokens: 0, totalOutputTokens: 0,
      rounds: 0, lastAlertThreshold: 0,
      pricePerM: MODEL_PRICES[model] ?? 2.0,
    };
    state.costTracker = t;
  }
  t.totalInputTokens += inputTokens;
  t.totalOutputTokens += outputTokens;
  t.rounds++;
  saveState(sessionId, state);

  const estimatedCost = (t.totalInputTokens * t.pricePerM) / 1_000_000;
  for (const threshold of thresholdsUsd) {
    if (estimatedCost >= threshold && t.lastAlertThreshold < threshold && t.rounds > 20) {
      t.lastAlertThreshold = Math.floor(threshold);
      state.suppressionStats.costAlerts++;
      return `[成本提醒] 已 ${t.rounds} 轮, 估算 ~$${estimatedCost.toFixed(2)}。` +
        (threshold >= 5 ? ' 任务完成后建议新开 session。' : '');
    }
  }
  return null;
}
