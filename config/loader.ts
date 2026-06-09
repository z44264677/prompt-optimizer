// Config Loader — v0.2 simplified
// Loads suppressor config + budget from default.json with env var overrides.

import type { SuppressorConfig } from '../src/types.js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AppConfig {
  plugin: { name: string; version: string; enabled: boolean };
  suppressor: SuppressorConfig;
  budget: {
    enabled: boolean;
    softCapUsd: number;
    hardCapUsd: number;
    perSessionCapUsd: number;
    perDayCapUsd: number;
  };
  excludes: string[];
}

const DEFAULT_CONFIG: AppConfig = {
  plugin: { name: 'prompt-optimizer-spend-control', version: '0.2.0', enabled: true },
  suppressor: {
    bash: { enabled: true, maxChars: 15000, headChars: 6000, tailChars: 1500 },
    read: { enabled: true, maxChars: 6000, mode: 'warn' },
    websearch: { enabled: true, chainThreshold: 3, overlapThreshold: 0.3 },
    verbose: { enabled: false, windowSize: 20, threshold: 800 },
    costAlert: { enabled: true, thresholdsUsd: [0.5, 1, 2, 5, 10, 20, 50] },
  },
  budget: { enabled: true, softCapUsd: 1.0, hardCapUsd: 5.0, perSessionCapUsd: 10.0, perDayCapUsd: 50.0 },
  excludes: [],
};

export function loadConfig(configPath?: string): AppConfig {
  const path = configPath ?? resolve(__dirname, '../../config/default.json');
  let config: AppConfig;

  try {
    const raw = readFileSync(path, 'utf-8');
    config = JSON.parse(raw) as AppConfig;
  } catch {
    config = DEFAULT_CONFIG;
  }

  // Env var overrides
  if (process.env.PO_ENABLED === 'false') config.plugin.enabled = false;
  if (process.env.PO_SOFT_CAP_USD) config.budget.softCapUsd = parseFloat(process.env.PO_SOFT_CAP_USD);
  if (process.env.PO_HARD_CAP_USD) config.budget.hardCapUsd = parseFloat(process.env.PO_HARD_CAP_USD);
  if (process.env.PO_BASH_MAX_CHARS) config.suppressor.bash.maxChars = parseInt(process.env.PO_BASH_MAX_CHARS);
  if (process.env.PO_READ_MAX_CHARS) config.suppressor.read.maxChars = parseInt(process.env.PO_READ_MAX_CHARS);
  if (process.env.PO_VERBOSE_ENABLED === 'true') config.suppressor.verbose.enabled = true;

  return config;
}
