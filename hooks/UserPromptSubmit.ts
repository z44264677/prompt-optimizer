// UserPromptSubmit Hook — Main Entry Point
// Source: 02-architecture.md §3.2 + §3.3
// This is the primary Hook that intercepts every user input before it reaches the main model.
//
// Route decisions:
//   P1: passthrough (short prompt, cache hit, or default)
//   P3: direct answer by small model (simple Q/A, translation, format)
//   P4: budget alert (predicted cost > soft cap)
//   P5: reject (predicted cost > hard cap, or plugin disabled)
//
// PostToolUse compression was removed in 2026-06 — T0.2/T0.3 validation
// showed only 4.3% token savings ceiling (Read already uses offset/limit).
// See 05-risks-cost.md §7.0 for the analysis.

import { randomUUID } from 'crypto';
import type { ComparisonSnapshot, PluginContext, RouteDecision } from '../src/types.js';
import { decide, estimateTokenCount } from '../src/router/decide.js';
import { CostEstimator } from '../src/cost-estimator/index.js';
import { DirectResponder, SafetyGate } from '../src/direct-responder/index.js';
import { classify as classifyForDirect, type ClassifierConfig, DEFAULT_CLASSIFIER_CONFIG } from '../src/direct-responder/classifier.js';
import { BudgetGovernor } from '../src/budget-governor/index.js';
import { DegradeHandler } from '../src/degrade/fallback.js';
import { MetricsReporter } from '../src/metrics/reporter.js';
import { ExactCache } from '../src/cache/exact.js';
import { ModelClient } from '../src/model-client.js';
import { loadConfig } from '../config/loader.js';

// === Plugin State ===

let config = loadConfig();
let client: ModelClient;
let costEstimator: CostEstimator;
let directResponder: DirectResponder;
let safetyGate: SafetyGate;
let budgetGovernor: BudgetGovernor;
let degradeHandler: DegradeHandler;
let metrics: MetricsReporter;
let cache: ExactCache;
let turnIndex = 0;
let sessionId = '';

// === Hook Entry Point ===

/**
 * Called by Claude Code on every UserPromptSubmit event.
 * Receives the raw user input and returns either the original prompt,
 * a compressed version, or a direct answer from the small model.
 */
export async function onUserPromptSubmit(rawPrompt: string): Promise<{
  prompt: string;
  routeDecision: RouteDecision;
  directAnswer?: string; // P3 only: small model's answer, bypassing main model
  alert?: string; // P4 only: budget alert message
  rejected?: boolean; // P5 only: prompt was rejected
}> {
  const startTime = Date.now();
  const turnId = randomUUID();
  turnIndex++;

  const ctx: PluginContext = {
    sessionId,
    turnIndex,
    config,
    budgetState: budgetGovernor.getState(),
  };

  // === Phase 1: Free checks ===
  if (!config.plugin.enabled) {
    return passthrough(rawPrompt, 'P5', turnId, startTime);
  }

  if (estimateTokenCount(rawPrompt) < config.costEstimator.minTokensToEstimate) {
    return passthrough(rawPrompt, 'P1', turnId, startTime);
  }

  // Cache hit
  const cached = cache.get(rawPrompt);
  if (cached) {
    return cached.optimizedPrompt
      ? { prompt: cached.optimizedPrompt, routeDecision: cached.routeDecision as RouteDecision }
      : passthrough(rawPrompt, 'P1', turnId, startTime);
  }

  // === Phase 1.5: P3 direct-answer classification (0 cost for short/marker-hit prompts) ===
  if (config.directResponder.enabled) {
    const classifierConfig: ClassifierConfig = {
      ...DEFAULT_CLASSIFIER_CONFIG,
      enableClassifier: config.directResponder.useClassifier ?? true,
    };
    const cls = await classifyForDirect(rawPrompt, client, classifierConfig);
    if (cls.verdict === 'simple') {
      // Try direct answer
      try {
        const answer = await directResponder.answer(rawPrompt);
        const gateResult = safetyGate.validate(answer);
        const p3Enabled = safetyGate.trackAndMaybeDisable(sessionId, gateResult.pass);

        if (gateResult.pass && p3Enabled) {
          // Record snapshot
          const snapshot = createSnapshot(rawPrompt, rawPrompt, 'P3', null, startTime);
          snapshot.routeRationale = `p3_${cls.reason}`;
          metrics.record(snapshot);
          return {
            prompt: '',
            routeDecision: 'P3',
            directAnswer: answer.response,
          };
        }
        // Fall through if safety gate failed
      } catch {
        // Fall through to main model
      }
    }
  }

  // === Phase 2: Cost Estimator (only reached if P3 didn't claim it) ===
  if (degradeHandler.isPaused()) {
    return passthrough(rawPrompt, 'P1', turnId, startTime);
  }

  let estimate;
  try {
    estimate = await costEstimator.predict(rawPrompt);
    degradeHandler.recordSuccess();
  } catch (err) {
    const degradeResult = degradeHandler.handleFailure(
      err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'http_5xx'
    );
    return passthrough(rawPrompt, degradeResult.fallbackRoute, turnId, startTime);
  }

  // Budget check
  const budgetResult = budgetGovernor.check(estimate.predicted_total_cost_usd);

  if (budgetResult === 'hard_reject') {
    cache.set(rawPrompt, 'P5', null);
    return {
      prompt: rawPrompt,
      routeDecision: 'P5',
      rejected: true,
    };
  }

  if (budgetResult === 'soft_alert') {
    return {
      prompt: rawPrompt,
      routeDecision: 'P4',
      alert: `⚠️ 预计成本 $${estimate.predicted_total_cost_usd.toFixed(2)} 超过软上限 $${config.budget.softCapUsd}。继续?`,
    };
  }

  // === Route based on estimate ===
  const route = decide(rawPrompt, estimate, ctx);

  if (route === 'P3') {
    // Direct answer by small model
    try {
      const answer = await directResponder.answer(rawPrompt);
      const gateResult = safetyGate.validate(answer);
      const p3Enabled = safetyGate.trackAndMaybeDisable(sessionId, gateResult.pass);

      if (!gateResult.pass || !p3Enabled) {
        // Fallback to P1
        cache.set(rawPrompt, 'P1', rawPrompt);
        return passthrough(rawPrompt, 'P1', turnId, startTime);
      }

      // Record snapshot
      const snapshot = createSnapshot(rawPrompt, rawPrompt, 'P3', estimate, startTime);
      snapshot.directResponderGate = gateResult;
      metrics.record(snapshot);

      // Don't call main model — return small model answer directly
      return {
        prompt: '', // not used
        routeDecision: 'P3',
        directAnswer: answer.response,
      };
    } catch {
      return passthrough(rawPrompt, 'P1', turnId, startTime);
    }
  }

  // P1 default: passthrough
  cache.set(rawPrompt, 'P1', rawPrompt);
  return passthrough(rawPrompt, 'P1', turnId, startTime);
}

/**
 * Called by Claude Code on SessionStart.
 */
export function onSessionStart(newSessionId: string): void {
  sessionId = newSessionId;
  turnIndex = 0;

  // Reload config (may have changed between sessions)
  config = loadConfig();

  // Initialize components
  const dbPath = `${process.env.HOME}/.claude/plugins/prompt-optimizer/metrics.db`;
  const apiKey = process.env.ANTHROPIC_API_KEY || '';

  client = new ModelClient({
    provider: 'anthropic',
    apiKey,
    model: config.costEstimator.model,
    maxLatencyMs: Math.max(
      config.costEstimator.maxLatencyMs,
      config.directResponder.maxLatencyMs
    ),
    maxRetries: 2,
  });

  costEstimator = new CostEstimator(client, config.costEstimator);
  directResponder = new DirectResponder(client, {
    minSelfConfidence: config.directResponder.minSelfConfidence,
    maxConsecutiveFailures: config.directResponder.maxConsecutiveFailures,
  });
  safetyGate = new SafetyGate(
    config.directResponder.minSelfConfidence,
    config.directResponder.maxConsecutiveFailures
  );
  budgetGovernor = new BudgetGovernor(config.budget);
  degradeHandler = new DegradeHandler();
  metrics = new MetricsReporter(dbPath);
  cache = new ExactCache(dbPath.replace('metrics.db', 'cache.db'));

  degradeHandler.reset();
  safetyGate.reset(sessionId);
  budgetGovernor.resetSession();
}

/**
 * Called by Claude Code on SessionEnd.
 */
export function onSessionEnd(): void {
  const report = metrics.generateSessionReport(sessionId);
  console.log(`\n[prompt-optimizer] Session Report: ${sessionId}`);
  console.log(`  Turns: ${report.totalTurns}`);
  console.log(`  Net Savings: $${report.costSummary.netSavings.toFixed(4)} (${report.costSummary.savingsPercent.toFixed(1)}%)`);
  console.log(`  Route: P1=${report.routeDistribution.P1} P2=${report.routeDistribution.P2} P3=${report.routeDistribution.P3} P4=${report.routeDistribution.P4} P5=${report.routeDistribution.P5}`);
  if (report.alerts.length > 0) {
    console.log(`  Alerts: ${report.alerts.length}`);
    for (const alert of report.alerts.slice(0, 5)) {
      console.log(`    [${alert.severity}] ${alert.message}`);
    }
  }

  cache.purgeExpired();
  metrics.close();
  cache.close();
}

// === Helpers ===

function passthrough(
  prompt: string,
  route: RouteDecision,
  turnId: string,
  startTime: number
): { prompt: string; routeDecision: RouteDecision } {
  const snapshot = createSnapshot(prompt, prompt, route, null, startTime);
  metrics.record(snapshot);
  return { prompt, routeDecision: route };
}

function createSnapshot(
  rawPrompt: string,
  optimizedPrompt: string,
  route: RouteDecision,
  estimate: import('../src/types.js').CostEstimate | null,
  startTime: number
): ComparisonSnapshot {
  const elapsed = Date.now() - startTime;
  return {
    id: randomUUID(),
    timestamp: Date.now(),
    sessionId,
    turnIndex,
    cost: {
      raw: { inputTokens: estimateTokenCount(rawPrompt), cachedInputTokens: 0, outputTokens: 0, totalCostUsd: 0 },
      optimized: { inputTokens: estimateTokenCount(optimizedPrompt), cachedInputTokens: 0, outputTokens: 0, totalCostUsd: 0, compressorCostUsd: 0 },
      directResponder: { inputTokens: 0, outputTokens: 0, totalCostUsd: 0 },
      savings: { tokenDelta: estimateTokenCount(rawPrompt) - estimateTokenCount(optimizedPrompt), costDeltaUsd: 0, compressionRatio: optimizedPrompt === rawPrompt ? 1.0 : estimateTokenCount(optimizedPrompt) / estimateTokenCount(rawPrompt), netSavingsUsd: 0 },
    },
    semanticFidelity: { bertScoreF1: 0, keyFactsPreserved: 0, codeIdentifiersPreserved: 0, constraintsPreserved: 0, llmJudgeScore: 0, llmJudgeRationale: '', mainModelOutputConsistency: 0 },
    latency: { compressorMs: route === 'P3' ? elapsed : 0, estimatorMs: route !== 'P1' ? elapsed : 0, cacheLookupMs: 0, mainModelRawMs: 0, mainModelOptimizedMs: 0, totalDeltaMs: elapsed },
    behavior: { raw: { success: false, rounds: 0, repeatedFileViews: 0, repeatedFileModifies: 0 }, optimized: { success: false, rounds: 0, repeatedFileViews: 0, repeatedFileModifies: 0 } },
    predictionAccuracy: estimate
      ? { predictedInputTokens: estimate.predicted_input_tokens, predictedOutputTokens: estimate.predicted_output_tokens, actualInputTokens: 0, actualOutputTokens: 0, inputErrorPercent: 0, outputErrorPercent: 0, confidence: estimate.confidence }
      : { predictedInputTokens: 0, predictedOutputTokens: 0, actualInputTokens: 0, actualOutputTokens: 0, inputErrorPercent: 0, outputErrorPercent: 0, confidence: 0 },
    routeDecision: route,
    routeRationale: route === 'P1' ? 'short_input_or_default' : 'estimator_directed',
    rawPrompt,
    optimizedPrompt,
  };
}
