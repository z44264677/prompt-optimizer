/**
 * SessionStart Hook Entry Point
 *
 * Claude Code calls this script at the start of each session.
 * Resets session-level state (WebSearch history).
 *
 * Protocol:
 *   stdin:  { session_id: string }
 *   stdout: {} (no action needed)
 */

import { resetSession } from './PostToolUse.js';

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8');

  try {
    const input = JSON.parse(raw);
    if (input.session_id) {
      resetSession(input.session_id);
    }
  } catch {
    // Ignore parse errors
  }

  process.stdout.write(JSON.stringify({}));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
