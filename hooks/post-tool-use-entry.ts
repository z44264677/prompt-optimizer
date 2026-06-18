/**
 * PostToolUse Hook Entry — S1-S3
 *
 * Claude Code calls this script after every tool execution.
 * Reads from stdin, applies suppression, writes to stdout.
 *
 * Uses dynamic import() for CJS/ESM compatibility.
 * Claude Code may invoke hooks with plain `node` (CJS) or ESM loader.
 *
 * Claude Code stdin fields (verified 2026-06-10):
 *   session_id, tool_name, tool_input, tool_response, tool_use_id,
 *   transcript_path, cwd, permission_mode, effort, hook_event_name, duration_ms
 */

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
    tool_response?: string;
    tool_result?: string;
    is_error?: boolean;
  };

  try {
    input = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Dynamic imports for CJS/ESM compatibility
  const { onPostToolUse } = await import('./PostToolUse.js');
  const { loadConfig } = await import('../config/loader.js');

  const config = loadConfig();
  const sessionId = input.session_id || 'default';

  const rawResponse: unknown = input.tool_response ?? input.tool_result ?? '';
  const toolResult: string = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);

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
