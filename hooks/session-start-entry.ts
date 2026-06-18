/**
 * SessionStart Hook Entry Point
 *
 * Claude Code calls this script at the start of each session.
 * Initializes fresh session state for tracking.
 *
 * Uses dynamic import() for CJS/ESM compatibility.
 *
 * Protocol:
 *   stdin:  { session_id: string }
 *   stdout: {} (no action needed)
 */

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8');

  try {
    const input = JSON.parse(raw);
    const sessionId = input.session_id || 'default';

    // Dynamic import for CJS/ESM compatibility
    const { initSession } = await import('./PostToolUse.js');
    initSession(sessionId);
  } catch {
    // Ignore parse errors
  }

  process.stdout.write(JSON.stringify({}));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
