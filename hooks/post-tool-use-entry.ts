/**
 * PostToolUse Hook Entry — S1-S5
 *
 * Claude Code calls this script after every tool execution.
 * Reads from stdin, applies suppression, writes to stdout.
 *
 * stdin:  JSON with tool result + optional usage data
 * stdout: JSON with modified content / injection
 */

import { onPostToolUse, resetSession, trackSessionCost } from './PostToolUse.js';
import { loadConfig } from '../config/loader.js';

/** Detect current model from env */
function detectModel(): string {
  return process.env.ANTHROPIC_MODEL
    || process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
    || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    || process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    || '';
}

async function main(): Promise<void> {
  // Read stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8');

  let input: {
    session_id?: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_result?: string;
    is_error?: boolean;
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  };

  try {
    input = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const config = loadConfig();
  const model = input.model || detectModel();
  const sessionId = input.session_id || 'default';

  // S5: Track session cost
  let costAlert: string | null = null;
  if (input.usage && config.suppressor.costAlert.enabled) {
    const totalInput = (input.usage.input_tokens || 0) + (input.usage.cache_read_input_tokens || 0);
    costAlert = trackSessionCost(
      sessionId, model, totalInput, input.usage.output_tokens || 0,
      config.suppressor.costAlert.thresholdsUsd,
    );
  }

  // S1-S3: Tool result suppression
  const result = onPostToolUse(
    {
      sessionId,
      toolName: input.tool_name || 'unknown',
      toolInput: input.tool_input || {},
      toolResult: input.tool_result || '',
      isError: input.is_error || false,
    },
    config.suppressor,
  );

  // Merge cost alert
  if (costAlert) {
    result.injection = result.injection
      ? result.injection + '\n\n' + costAlert
      : costAlert;
  }

  process.stdout.write(JSON.stringify(result));
}

main().catch(() => process.stdout.write(JSON.stringify({})));
