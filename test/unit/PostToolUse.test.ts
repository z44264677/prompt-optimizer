// Tests for PostToolUse Hook — Context Inflation Suppressor
import { describe, it, expect, beforeEach } from 'vitest';
import { onPostToolUse, resetSession, type PostToolUseContext } from '../../hooks/PostToolUse';
import { DEFAULT_SUPPRESSOR_CONFIG, type SuppressorConfig } from '../../src/types';

const SESSION_ID = 'test-session';
const config: SuppressorConfig = { ...DEFAULT_SUPPRESSOR_CONFIG };

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
