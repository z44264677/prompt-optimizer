import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { onUserPromptSubmit } from '../../hooks/UserPromptSubmit.js';
import type { SuppressorConfig } from '../../src/types.js';

const STATE_DIR = join(process.env.HOME || '/tmp', '.claude', 'plugins', 'cache', 'prompt-optimizer', 'state');

const BASE_CONFIG: SuppressorConfig = {
  bash: { enabled: true, maxChars: 15000, headChars: 6000, tailChars: 1500 },
  read: { enabled: true, maxChars: 6000, mode: 'warn' },
  websearch: { enabled: true, chainThreshold: 3, overlapThreshold: 0.3 },
  verbose: { enabled: true, minRounds: 10, shortPromptThreshold: 100 },
  escalation: { enabled: true, warnAt: 3, blockAt: 5 },
};

/** Write a state file with given roundCount and verboseReminders. */
function writeState(sessionId: string, roundCount: number, verboseReminders: number = 0) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(
    join(STATE_DIR, `${sessionId}.json`),
    JSON.stringify({ roundCount, verboseReminders }),
  );
}

function cleanupState(sessionId: string) {
  try { unlinkSync(join(STATE_DIR, `${sessionId}.json`)); } catch { /* ok */ }
}

describe('S4: Verbose detection — basic', () => {
  it('returns empty when verbose is disabled', () => {
    const config = { ...BASE_CONFIG, verbose: { ...BASE_CONFIG.verbose, enabled: false } };
    const result = onUserPromptSubmit(
      { sessionId: 'test-s4-disabled', prompt: 'hi' },
      config,
    );
    expect(result).toEqual({});
  });

  it('returns empty when roundCount < minRounds (no state file)', () => {
    const result = onUserPromptSubmit(
      { sessionId: 'test-s4-nonexistent', prompt: 'hi' },
      BASE_CONFIG,
    );
    expect(result).toEqual({});
  });

  it('returns empty when prompt is long', () => {
    const longPrompt = 'Please help me design a new API endpoint for user authentication with JWT tokens...';
    const result = onUserPromptSubmit(
      { sessionId: 'test-s4-long-prompt', prompt: longPrompt },
      BASE_CONFIG,
    );
    expect(result).toEqual({});
  });

  it('returns empty for empty prompt', () => {
    const result = onUserPromptSubmit(
      { sessionId: 'test-s4-empty', prompt: '' },
      BASE_CONFIG,
    );
    expect(result).toEqual({});
  });
});

describe('S4: Verbose detection — state-backed', () => {
  const SID = 'test-s4-state';

  afterEach(() => cleanupState(SID));

  it('L1: triggers reminder when roundCount >= minRounds and prompt is short', () => {
    writeState(SID, 12); // roundCount=12 >= minRounds=10

    const result = onUserPromptSubmit(
      { sessionId: SID, prompt: 'ok' },
      BASE_CONFIG,
    );

    expect(result.injection).toBeDefined();
    expect(result.injection).toContain('Round 12');
    expect(result.injection).toContain('Be concise');
  });

  it('L2: escalates tone after warnAt triggers', () => {
    writeState(SID, 15, 3); // Already 3 verbose reminders

    const result = onUserPromptSubmit(
      { sessionId: SID, prompt: 'hmm' },
      BASE_CONFIG,
    );

    expect(result.injection).toBeDefined();
    expect(result.injection).toContain('4x this session');
  });

  it('does not trigger when roundCount is below minRounds', () => {
    writeState(SID, 5); // roundCount=5 < minRounds=10

    const result = onUserPromptSubmit(
      { sessionId: SID, prompt: 'ok' },
      BASE_CONFIG,
    );

    expect(result).toEqual({});
  });

  it('does not trigger when prompt is long enough', () => {
    writeState(SID, 20);

    const result = onUserPromptSubmit(
      { sessionId: SID, prompt: 'This is a substantial prompt with enough context that it should not trigger the verbose detection.' },
      BASE_CONFIG,
    );

    expect(result).toEqual({});
  });

  it('increments verboseReminders counter across calls', () => {
    writeState(SID, 12, 0);

    // First call triggers
    const r1 = onUserPromptSubmit(
      { sessionId: SID, prompt: 'ok' },
      BASE_CONFIG,
    );
    expect(r1.injection).toBeDefined();

    // Second call — counter should have been persisted
    const r2 = onUserPromptSubmit(
      { sessionId: SID, prompt: 'yes' },
      BASE_CONFIG,
    );
    expect(r2.injection).toBeDefined();
    expect(r2.injection).toContain('2x');
  });
});
