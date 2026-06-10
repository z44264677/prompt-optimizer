/**
 * UserPromptSubmit Hook Entry — S4 Verbose Detection
 *
 * Claude Code calls this script before every user prompt is processed.
 * Currently: passthrough stub. The full S4 verbose-detection pipeline
 * (UserPromptSubmit.ts + src/* modules) is a v0.3 feature.
 *
 * stdin:  JSON with { prompt: string, session_id?: string }
 * stdout: JSON with modified prompt / injection
 */

async function main(): Promise<void> {
  // Read stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8');

  let input: { prompt?: string };
  try {
    input = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  if (!input.prompt) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Passthrough: return prompt unchanged (S4 disabled by default)
  process.stdout.write(JSON.stringify({ prompt: input.prompt }));
}

main().catch(() => process.stdout.write(JSON.stringify({})));
