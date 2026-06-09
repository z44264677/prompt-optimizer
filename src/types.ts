// === Suppressor Types ===
// Context Inflation Suppressor: S1-S5 tool result optimization
// Based on 22-argument validation of 18 sessions × 7 models.
// Theoretical basis: arXiv:2604.22750 §7.2 "budget-aware tool-use policies"

export interface SuppressorConfig {
  bash: {
    enabled: boolean;
    /** Max chars before truncation (default: 10000) */
    maxChars: number;
    /** Chars to keep from head (default: 5000) */
    headChars: number;
    /** Chars to keep from tail (default: 1000) */
    tailChars: number;
  };
  read: {
    enabled: boolean;
    /** Max chars before reminder (default: 6000) */
    maxChars: number;
    /** 'warn' = inject reminder only */
    mode: 'warn' | 'block';
  };
  websearch: {
    enabled: boolean;
    /** Consecutive same-topic searches before warning (default: 3) */
    chainThreshold: number;
    /** Keyword overlap threshold (default: 0.3) */
    overlapThreshold: number;
  };
  verbose: {
    enabled: boolean;
    /** Rolling window size for output mean (default: 20) */
    windowSize: number;
    /** Output token threshold for verbosity alert (default: 800) */
    threshold: number;
  };
  costAlert: {
    enabled: boolean;
    /** Cost thresholds in USD for session alerts (default: [0.5, 1, 2, 5, 10, 20, 50]) */
    thresholdsUsd: number[];
  };
}

export const DEFAULT_SUPPRESSOR_CONFIG: SuppressorConfig = {
  bash: { enabled: true, maxChars: 10000, headChars: 5000, tailChars: 1000 },
  read: { enabled: true, maxChars: 6000, mode: 'warn' },
  websearch: { enabled: true, chainThreshold: 3, overlapThreshold: 0.3 },
  verbose: { enabled: false, windowSize: 20, threshold: 800 },
  costAlert: { enabled: true, thresholdsUsd: [0.5, 1, 2, 5, 10, 20, 50] },
};
