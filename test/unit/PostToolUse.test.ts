// Tests for PostToolUse Hook — Context Inflation Suppressor
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { onPostToolUse, resetSession, trackSessionCost, type PostToolUseContext } from '../../hooks/PostToolUse';
import { DEFAULT_SUPPRESSOR_CONFIG, type SuppressorConfig } from '../../src/types';

const SESSION_ID = 'test-session';
const config: SuppressorConfig = { ...DEFAULT_SUPPRESSOR_CONFIG };

afterAll(() => {
  // Final cleanup: ensure test-session state file is removed
  resetSession(SESSION_ID);
});

function makeCtx(overrides: Partial<PostToolUseContext>): PostToolUseContext {
  return {
    sessionId: SESSION_ID,
    toolName: 'Bash',
    toolInput: {},
    toolResult: '',
    isError: false,
    ...overrides,
  };
}

beforeEach(() => {
  // Clean up file-persisted state
  resetSession(SESSION_ID);
});

// === S1: Bash Truncation ===

describe('S1: Bash Output Truncation', () => {
  it('passes through short output', () => {
    const result = onPostToolUse(
      makeCtx({ toolResult: 'short output' }),
      config,
    );
    expect(result.content).toBeUndefined();
    expect(result.injection).toBeUndefined();
  });

  it('truncates long output to head+tail', () => {
    const head = 'START\n'.repeat(2000); // ~12000 chars
    const mid = 'MIDDLE\n'.repeat(2000);
    const tail = 'END\n'.repeat(500); // ~2000 chars
    const content = head + mid + tail;

    const result = onPostToolUse(
      makeCtx({ toolResult: content }),
      config,
    );
    expect(result.content).toBeDefined();
    expect(result.content!).toContain('START');
    expect(result.content!).toContain('END');
    expect(result.content!).toContain('截断');
    // Middle should be dropped
    expect(result.content!).not.toContain('MIDDLE');
    // Head and tail preserved
    expect(result.content!.length).toBeLessThan(content.length);
  });

  it('does not truncate error outputs', () => {
    const content = 'ERROR\n'.repeat(3000);
    const result = onPostToolUse(
      makeCtx({ toolResult: content, isError: true }),
      config,
    );
    expect(result.content).toBeUndefined();
  });

  it('respects custom maxChars', () => {
    const customConfig: SuppressorConfig = {
      ...config,
      bash: { ...config.bash, maxChars: 100 },
    };
    const result = onPostToolUse(
      makeCtx({ toolResult: 'x'.repeat(200) }),
      customConfig,
    );
    expect(result.content).toBeDefined();
  });

  it('can be disabled', () => {
    const disabledConfig: SuppressorConfig = {
      ...config,
      bash: { ...config.bash, enabled: false },
    };
    const content = 'x'.repeat(20000);
    const result = onPostToolUse(
      makeCtx({ toolResult: content }),
      disabledConfig,
    );
    expect(result.content).toBeUndefined();
  });
});

// === S2: Read Reminder ===

describe('S2: Read Offset/Limit Reminder', () => {
  it('no reminder for small files', () => {
    const result = onPostToolUse(
      makeCtx({
        toolName: 'Read',
        toolInput: { file_path: '/small/file.ts' },
        toolResult: 'short content',
      }),
      config,
    );
    expect(result.injection).toBeUndefined();
  });

  it('injects reminder for large files', () => {
    const result = onPostToolUse(
      makeCtx({
        toolName: 'Read',
        toolInput: { file_path: '/large/file.ts' },
        toolResult: 'x'.repeat(10000),
      }),
      config,
    );
    expect(result.injection).toBeDefined();
    expect(result.injection!).toContain('offset/limit');
    expect(result.injection!).toContain('/large/file.ts');
  });

  it('can be disabled', () => {
    const disabledConfig: SuppressorConfig = {
      ...config,
      read: { ...config.read, enabled: false },
    };
    const result = onPostToolUse(
      makeCtx({
        toolName: 'Read',
        toolInput: { file_path: '/large/file.ts' },
        toolResult: 'x'.repeat(10000),
      }),
      disabledConfig,
    );
    expect(result.injection).toBeUndefined();
  });
});

// === S3: WebSearch Chain ===

describe('S3: WebSearch Chain Detection', () => {
  it('first search: no warning', () => {
    const result = onPostToolUse(
      makeCtx({
        toolName: 'WebSearch',
        toolInput: { query: 'claude code plugin development' },
        toolResult: JSON.stringify({
          organic: [{ title: 'Result 1', link: 'https://example.com' }],
        }),
      }),
      config,
    );
    expect(result.injection).toBeUndefined();
  });

  it('triggers warning after 3 same-topic searches', () => {
    const searchInput = { query: 'claude code hooks posttooluse' };
    const searchResult = JSON.stringify({
      organic: [
        { title: 'Claude Code Hooks', link: 'https://docs.anthropic.com' },
        { title: 'PostToolUse Guide', link: 'https://example.com' },
        { title: 'Plugin Development', link: 'https://example.com' },
      ],
    });

    // First 2 searches: no warning
    for (let i = 0; i < 2; i++) {
      const result = onPostToolUse(
        makeCtx({ toolName: 'WebSearch', toolInput: searchInput, toolResult: searchResult }),
        config,
      );
      expect(result.injection).toBeUndefined();
    }

    // Third search: warning triggered
    const result = onPostToolUse(
      makeCtx({ toolName: 'WebSearch', toolInput: searchInput, toolResult: searchResult }),
      config,
    );
    expect(result.injection).toBeDefined();
    expect(result.injection!).toContain('搜索链检测');
    expect(result.injection!).toContain('搜索了');
  });

  it('different topics: no false chain detection', () => {
    const topics = [
      { query: 'claude code hooks' },
      { query: 'python asyncio tutorial' },
      { query: 'typescript generics' },
    ];
    for (const topic of topics) {
      const result = onPostToolUse(
        makeCtx({
          toolName: 'WebSearch',
          toolInput: topic,
          toolResult: JSON.stringify({ organic: [{ title: 'Result' }] }),
        }),
        config,
      );
      expect(result.injection).toBeUndefined();
    }
  });

  it('resets chain count after warning', () => {
    const searchInput = { query: 'claude code mcp server' };
    const searchResult = JSON.stringify({ organic: [{ title: 'R' }] });

    // Trigger first warning
    for (let i = 0; i < 3; i++) {
      onPostToolUse(
        makeCtx({ toolName: 'WebSearch', toolInput: searchInput, toolResult: searchResult }),
        config,
      );
    }

    // Next search should not trigger again (count reset)
    const result = onPostToolUse(
      makeCtx({ toolName: 'WebSearch', toolInput: searchInput, toolResult: searchResult }),
      config,
    );
    expect(result.injection).toBeUndefined();
  });

  it('can be disabled', () => {
    const disabledConfig: SuppressorConfig = {
      ...config,
      websearch: { ...config.websearch, enabled: false },
    };
    const searchInput = { query: 'test' };
    const searchResult = JSON.stringify({ organic: [{ title: 'R' }] });
    for (let i = 0; i < 3; i++) {
      const result = onPostToolUse(
        makeCtx({ toolName: 'WebSearch', toolInput: searchInput, toolResult: searchResult }),
        disabledConfig,
      );
      expect(result.injection).toBeUndefined();
    }
  });
});

// === Session Reset ===

describe('Session Reset', () => {
  it('clears search history on reset', () => {
    const searchInput = { query: 'test topic' };
    const searchResult = JSON.stringify({ organic: [{ title: 'R' }] });

    // Build up history
    for (let i = 0; i < 2; i++) {
      onPostToolUse(
        makeCtx({ toolName: 'WebSearch', toolInput: searchInput, toolResult: searchResult }),
        config,
      );
    }

    // Reset
    resetSession(SESSION_ID);

    // Should start fresh — no warning on 3rd search
    for (let i = 0; i < 2; i++) {
      const result = onPostToolUse(
        makeCtx({ toolName: 'WebSearch', toolInput: searchInput, toolResult: searchResult }),
        config,
      );
      expect(result.injection).toBeUndefined();
    }
  });
});

// === S5: Session Cost Tracking ===

describe('S5: Session Cost Tracking', () => {
  const thresholds = [0.5, 1, 2, 5];

  beforeEach(() => {
    resetSession(SESSION_ID);
  });

  it('returns null when cost is below threshold', () => {
    const result = trackSessionCost(SESSION_ID, 'deepseek-v4-pro', 1000, 500, thresholds);
    expect(result).toBeNull();
  });

  it('returns null for unknown model (pricePerM = 0, no false alerts)', () => {
    // Unknown model should not produce alerts regardless of token count
    for (let i = 0; i < 30; i++) {
      const result = trackSessionCost(SESSION_ID, '', 100_000, 50_000, thresholds);
      expect(result).toBeNull();
    }
  });

  it('returns null when rounds <= 20 even if cost exceeds threshold', () => {
    // deepseek-v4-pro @ $0.14/M — need ~3.6M tokens to hit $0.5
    // But with only 20 rounds, should not alert
    for (let i = 0; i < 20; i++) {
      const result = trackSessionCost(SESSION_ID, 'deepseek-v4-pro', 200_000, 100_000, thresholds);
      expect(result).toBeNull();
    }
  });

  it('triggers alert at threshold when rounds > 20 and cost exceeds', () => {
    // claude-opus-4-6 @ $1.50/M — 400K tokens per round × 21 rounds = 8.4M tokens = $12.6
    // Should trigger $0.5, $1, $2, $5 thresholds progressively
    let alerts: string[] = [];
    for (let i = 0; i < 25; i++) {
      const result = trackSessionCost(SESSION_ID, 'claude-opus-4-6', 400_000, 200_000, thresholds);
      if (result) alerts.push(result);
    }
    // First alert should mention cost
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0]).toContain('成本提醒');
  });

  it('does not re-trigger the same threshold', () => {
    // Push past $0.5 threshold, then continue — same threshold should not fire again
    let alertCount = 0;
    for (let i = 0; i < 30; i++) {
      const result = trackSessionCost(SESSION_ID, 'claude-sonnet-4-6', 100_000, 50_000, [0.5]);
      if (result) alertCount++;
    }
    // $0.30/M × 100K/round × 30 rounds = 3M tokens = $0.9 — crosses $0.5 once
    expect(alertCount).toBe(1);
  });

  it('triggers progressively across multiple thresholds', () => {
    // claude-opus-4-6 @ $1.50/M, 500K per round
    // round 21: 10.5M tokens = $15.75 — already past all thresholds
    // But thresholds fire one-at-a-time due to loop break on first match
    resetSession(SESSION_ID);
    let alerts: string[] = [];

    // First 21 rounds: accumulate to trigger
    for (let i = 0; i < 21; i++) {
      const result = trackSessionCost(SESSION_ID, 'claude-opus-4-6', 500_000, 200_000, thresholds);
      if (result) alerts.push(result);
    }
    // At round 21: 10.5M input tokens × $1.50/M = $15.75
    // Should have triggered $0.5 first (at round 21 when rounds > 20)
    expect(alerts.length).toBeGreaterThanOrEqual(1);

    // Subsequent rounds should trigger remaining thresholds
    for (let i = 0; i < 10; i++) {
      const result = trackSessionCost(SESSION_ID, 'claude-opus-4-6', 500_000, 200_000, thresholds);
      if (result) alerts.push(result);
    }
    // All 4 thresholds ($0.5, $1, $2, $5) should have fired
    expect(alerts.length).toBe(4);
  });

  it('suggests new session when threshold >= $5', () => {
    // claude-opus-4-6 @ $1.50/M — accumulate past $5 threshold
    // Need > 20 rounds, then trigger at round 21
    for (let i = 0; i < 20; i++) {
      trackSessionCost(SESSION_ID, 'claude-opus-4-6', 500_000, 200_000, [5]);
    }
    // Round 21 (rounds > 20) with 10.5M tokens × $1.50/M = $15.75 → triggers $5
    const result = trackSessionCost(SESSION_ID, 'claude-opus-4-6', 500_000, 200_000, [5]);
    expect(result).not.toBeNull();
    expect(result!).toContain('新开 session');
  });
});
