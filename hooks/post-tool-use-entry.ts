/**
 * PostToolUse Hook Entry — S1-S5
 *
 * Claude Code calls this script after every tool execution.
 * Reads from stdin, applies suppression, writes to stdout.
 *
 * Claude Code stdin fields (verified 2026-06-10):
 *   session_id, tool_name, tool_input, tool_response, tool_use_id,
 *   transcript_path, cwd, permission_mode, effort, hook_event_name, duration_ms
 *   (NO model, NO usage — we estimate from env + content length)
 */

import { onPostToolUse, trackSessionCost } from './PostToolUse.js';
import { loadConfig } from '../config/loader.js';

function detectModel(): string {
  return process.env.ANTHROPIC_MODEL
    || process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
    || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    || process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    || '';
}

/** Estimate token count from any value (~4 chars/token) */
function estimateTokens(v: unknown): number {
  if (typeof v === 'string') return Math.round(v.length / 4);
  if (typeof v === 'object' && v !== null) return Math.round(JSON.stringify(v).length / 4);
  return 0;
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8');

  let input: {
    session_id?: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_response?: string;   // Claude Code actual field name
    tool_result?: string;     // fallback
    is_error?: boolean;
  };

  try {
    input = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const config = loadConfig();
  const model = detectModel();
  const sessionId = input.session_id || 'default';

  // tool_response is the actual field Claude Code sends (may be object or string)
  const rawResponse: unknown = input.tool_response ?? input.tool_result ?? '';
  const toolResult: string = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
  const toolInputStr = JSON.stringify(input.tool_input || {});

  // S5: Track session cost (estimate tokens from content length)
  if (config.suppressor.costAlert?.enabled) {
    const inputTokens = estimateTokens(toolInputStr) + estimateTokens(toolResult);
    trackSessionCost(
      sessionId, model, inputTokens, estimateTokens(toolResult),
      config.suppressor.costAlert.thresholdsUsd,
    );
  }

  // S1-S3: Tool result suppression
  const result = onPostToolUse(
    {
      sessionId,
      toolName: input.tool_name || 'unknown',
      toolInput: input.tool_input || {},
      toolResult,
      isError: input.is_error || false,
    },
    config.suppressor,
  );

  process.stdout.write(JSON.stringify(result));
}

main().catch(() => process.stdout.write(JSON.stringify({})));
