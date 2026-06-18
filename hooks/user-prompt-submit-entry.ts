/**
 * UserPromptSubmit Hook Entry — S4
 *
 * Claude Code calls this script before processing every user prompt.
 * Reads from stdin, checks for verbose patterns, writes injection to stdout.
 *
 * Uses dynamic import() for CJS/ESM compatibility.
 * Claude Code may invoke hooks with plain `node` (CJS) or ESM loader.
 *
 * Claude Code stdin fields:
 *   session_id, prompt, transcript_path, cwd, hook_event_name, permission_mode
 */

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8');

  let input: {
    session_id?: string;
    prompt?: string;
  };

  try {
    input = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Dynamic imports for CJS/ESM compatibility
  const { onUserPromptSubmit } = await import('./UserPromptSubmit.js');
  const { loadConfig } = await import('../config/loader.js');

  const config = loadConfig();
  const result = onUserPromptSubmit(
    {
      sessionId: input.session_id || 'default',
      prompt: input.prompt || '',
    },
    config.suppressor,
  );

  process.stdout.write(JSON.stringify(result));
}

main().catch(() => process.stdout.write(JSON.stringify({})));
