#!/usr/bin/env node
/**
 * prompt-optimizer 系统分析脚本
 * 用法: node scripts/analyze.mjs [--json] [--days <n>] [--model <name>]
 *
 * --json         输出机器可读 JSON（可供图表库消费）
 * --days <n>     只分析最近 n 天（默认全部）
 * --model <name> 只看指定模型的 session
 *
 * 输出：
 *   1. 按模型聚合的成本与节省对比
 *   2. 按天聚合的趋势数据（轮次、token、成本、节省）
 *   3. 各策略效率分析（S1 压缩率、S2 采纳率估算、S3 链长分布）
 *   4. ROI 预测（月度外推）
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';

const STATE_DIR = join(process.env.HOME, '.claude', 'plugins', 'cache', 'prompt-optimizer', 'state');

// === Helpers ===

function $(usd) { return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`; }
function tk(n) { return n >= 1_000_000 ? `${(n/1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n/1_000).toFixed(1)}K` : String(n); }
function pct(a, b) { return b > 0 ? `${(a / b * 100).toFixed(1)}%` : '—'; }
function dayKey(date) { return date.toISOString().slice(0, 10); }

// === Data Loading ===

function loadAllSessions() {
  if (!existsSync(STATE_DIR)) return [];
  const files = readdirSync(STATE_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    try {
      const data = JSON.parse(readFileSync(join(STATE_DIR, f), 'utf-8'));
      const mtime = statSync(join(STATE_DIR, f)).mtime;
      return { id: f.replace('.json', ''), mtime, ...data };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
}

// === Analysis Functions ===

function analyzeByModel(sessions) {
  const models = {};
  for (const s of sessions) {
    const ct = s.costTracker;
    if (!ct || ct.rounds === 0) continue;
    const model = ct.pricePerM === 0.14 ? 'deepseek-v4-pro'
      : ct.pricePerM === 1.50 ? 'claude-opus-4-6'
      : ct.pricePerM === 0.30 ? 'claude-sonnet-4-6'
      : `unknown-${ct.pricePerM}/M`;

    if (!models[model]) {
      models[model] = { sessions: 0, rounds: 0, inputTokens: 0, outputTokens: 0, pricePerM: ct.pricePerM, cost: 0, savedTokens: 0, savedCost: 0, s1: 0, s2: 0, s3: 0, s5: 0 };
    }
    const m = models[model];
    const ss = s.suppressionStats || {};
    m.sessions++;
    m.rounds += ct.rounds;
    m.inputTokens += ct.totalInputTokens;
    m.outputTokens += ct.totalOutputTokens;
    m.cost += (ct.totalInputTokens * ct.pricePerM) / 1_000_000;

    const bashSaved = Math.round(((ss.bashCharsBefore || 0) - (ss.bashCharsAfter || 0)) / 4);
    const readSaved = (ss.readReminders || 0) * 2000;
    const searchSaved = (ss.searchSearchesPrevented || 0) * 5000;
    const totalSaved = bashSaved + readSaved + searchSaved;
    m.savedTokens += totalSaved;
    m.savedCost += (totalSaved / 1_000_000) * ct.pricePerM;
    m.s1 += ss.bashTruncations || 0;
    m.s2 += ss.readReminders || 0;
    m.s3 += ss.searchChainWarnings || 0;
    m.s5 += ss.costAlerts || 0;
  }
  return models;
}

function analyzeByDay(sessions) {
  const days = {};
  for (const s of sessions) {
    const ct = s.costTracker;
    if (!ct || ct.rounds === 0) continue;
    const key = dayKey(s.mtime);
    if (!days[key]) {
      days[key] = { date: key, sessions: 0, rounds: 0, inputTokens: 0, outputTokens: 0, cost: 0, savedTokens: 0, savedCost: 0, s1: 0, s2: 0, s3: 0 };
    }
    const d = days[key];
    const ss = s.suppressionStats || {};
    d.sessions++;
    d.rounds += ct.rounds;
    d.inputTokens += ct.totalInputTokens;
    d.outputTokens += ct.totalOutputTokens;
    d.cost += (ct.totalInputTokens * ct.pricePerM) / 1_000_000;

    const bashSaved = Math.round(((ss.bashCharsBefore || 0) - (ss.bashCharsAfter || 0)) / 4);
    const readSaved = (ss.readReminders || 0) * 2000;
    const searchSaved = (ss.searchSearchesPrevented || 0) * 5000;
    const totalSaved = bashSaved + readSaved + searchSaved;
    d.savedTokens += totalSaved;
    d.savedCost += (totalSaved / 1_000_000) * ct.pricePerM;
    d.s1 += ss.bashTruncations || 0;
    d.s2 += ss.readReminders || 0;
    d.s3 += ss.searchChainWarnings || 0;
  }
  return Object.values(days).sort((a, b) => a.date.localeCompare(b.date));
}

function analyzeStrategyEfficiency(sessions) {
  let totalBashBefore = 0, totalBashAfter = 0, bashEvents = 0;
  let readEvents = 0, totalRounds = 0;
  let searchChains = 0, searchTriggered = 0, totalSearchCount = 0;

  for (const s of sessions) {
    const ss = s.suppressionStats || {};
    const ct = s.costTracker;
    totalRounds += ct?.rounds || 0;

    totalBashBefore += ss.bashCharsBefore || 0;
    totalBashAfter += ss.bashCharsAfter || 0;
    bashEvents += ss.bashTruncations || 0;

    readEvents += ss.readReminders || 0;

    const sh = s.searchHistory || [];
    searchChains += sh.length;
    for (const h of sh) {
      totalSearchCount += h.count + (h.triggeredCount || 0);
      if ((h.triggeredCount || 0) > 0) searchTriggered++;
    }
  }

  return {
    s1: {
      events: bashEvents,
      avgCompressionRatio: totalBashBefore > 0 ? (1 - totalBashAfter / totalBashBefore) : 0,
      avgCharsDropped: bashEvents > 0 ? Math.round((totalBashBefore - totalBashAfter) / bashEvents) : 0,
      triggerRate: totalRounds > 0 ? bashEvents / totalRounds : 0,
    },
    s2: {
      events: readEvents,
      triggerRate: totalRounds > 0 ? readEvents / totalRounds : 0,
      estimatedTokensSavedPerEvent: 2000,
    },
    s3: {
      uniqueTopics: searchChains,
      chainsTriggered: searchTriggered,
      totalSearches: totalSearchCount,
      avgSearchesBeforeTrigger: searchTriggered > 0 ? Math.round(totalSearchCount / searchTriggered) : 0,
    },
  };
}

function projectMonthlyROI(sessions) {
  if (sessions.length === 0) return null;

  const earliest = sessions[sessions.length - 1].mtime;
  const latest = sessions[0].mtime;
  const spanDays = Math.max(1, (latest - earliest) / (1000 * 60 * 60 * 24));

  let totalCost = 0, totalSaved = 0, totalRounds = 0;
  for (const s of sessions) {
    const ct = s.costTracker;
    const ss = s.suppressionStats || {};
    if (!ct) continue;
    totalCost += (ct.totalInputTokens * ct.pricePerM) / 1_000_000;
    totalRounds += ct.rounds;

    const bashSaved = Math.round(((ss.bashCharsBefore || 0) - (ss.bashCharsAfter || 0)) / 4);
    const readSaved = (ss.readReminders || 0) * 2000;
    const searchSaved = (ss.searchSearchesPrevented || 0) * 5000;
    totalSaved += ((bashSaved + readSaved + searchSaved) / 1_000_000) * ct.pricePerM;
  }

  const dailyCost = totalCost / spanDays;
  const dailySaved = totalSaved / spanDays;
  const dailyRounds = totalRounds / spanDays;

  return {
    observedDays: Math.round(spanDays * 10) / 10,
    sessionsCount: sessions.length,
    dailyAvg: { rounds: Math.round(dailyRounds), cost: dailyCost, saved: dailySaved },
    monthlyProjection: { cost: dailyCost * 30, saved: dailySaved * 30, rounds: Math.round(dailyRounds * 30) },
    savingsRate: totalCost > 0 ? totalSaved / totalCost : 0,
    note: spanDays < 3 ? '⚠️ 数据跨度不足 3 天，月度外推置信度低' : null,
  };
}

// === Rendering ===

function renderText(sessions) {
  console.log('═'.repeat(72));
  console.log('  prompt-optimizer · 系统分析报告');
  console.log('═'.repeat(72));

  if (sessions.length === 0) {
    console.log('\n  (暂无数据)\n');
    return;
  }

  // --- 1. 按模型聚合 ---
  const byModel = analyzeByModel(sessions);
  console.log('\n┌─────────────────────────────────────────────────────────────────────┐');
  console.log('│  1. 按模型聚合                                                      │');
  console.log('├─────────────────────────────────────────────────────────────────────┤');
  console.log('│  模型                Sessions  轮次    Input     成本      节省      │');
  console.log('├─────────────────────────────────────────────────────────────────────┤');
  for (const [model, m] of Object.entries(byModel)) {
    const line = `  ${model.padEnd(20)} ${String(m.sessions).padStart(4)}   ${String(m.rounds).padStart(5)}  ${tk(m.inputTokens).padStart(8)}  ${$(m.cost).padStart(7)}  ${$(m.savedCost).padStart(7)}`;
    console.log(`│${line.padEnd(69)}│`);
  }
  console.log('└─────────────────────────────────────────────────────────────────────┘');

  // --- 2. 按天趋势 ---
  const byDay = analyzeByDay(sessions);
  console.log('\n┌─────────────────────────────────────────────────────────────────────┐');
  console.log('│  2. 按天趋势                                                        │');
  console.log('├─────────────────────────────────────────────────────────────────────┤');
  console.log('│  日期          Sessions  轮次    成本      节省    节省率   S1/S2/S3 │');
  console.log('├─────────────────────────────────────────────────────────────────────┤');
  for (const d of byDay) {
    const rate = d.cost > 0 ? pct(d.savedCost, d.cost) : '—';
    const line = `  ${d.date}     ${String(d.sessions).padStart(4)}   ${String(d.rounds).padStart(5)}  ${$(d.cost).padStart(7)}  ${$(d.savedCost).padStart(7)}  ${rate.padStart(6)}   ${d.s1}/${d.s2}/${d.s3}`;
    console.log(`│${line.padEnd(69)}│`);
  }
  console.log('└─────────────────────────────────────────────────────────────────────┘');

  // --- 3. 策略效率 ---
  const efficiency = analyzeStrategyEfficiency(sessions);
  console.log('\n┌─────────────────────────────────────────────────────────────────────┐');
  console.log('│  3. 策略效率分析                                                    │');
  console.log('├─────────────────────────────────────────────────────────────────────┤');
  const s1 = efficiency.s1;
  console.log(`│  S1 Bash截断:                                                       │`);
  console.log(`│    触发次数: ${String(s1.events).padStart(4)}  |  压缩率: ${(s1.avgCompressionRatio*100).toFixed(0)}%  |  平均砍掉: ${tk(s1.avgCharsDropped)} chars`.padEnd(70) + '│');
  console.log(`│    触发率: ${(s1.triggerRate*100).toFixed(1)}% (每 ${s1.triggerRate>0 ? Math.round(1/s1.triggerRate) : '∞'} 轮触发 1 次)`.padEnd(70) + '│');
  console.log('│'.padEnd(70) + '│');
  const s2 = efficiency.s2;
  console.log(`│  S2 Read提醒:                                                       │`);
  console.log(`│    触发次数: ${String(s2.events).padStart(4)}  |  触发率: ${(s2.triggerRate*100).toFixed(1)}%  |  估算每次省: ${tk(s2.estimatedTokensSavedPerEvent)} tok`.padEnd(70) + '│');
  console.log('│'.padEnd(70) + '│');
  const s3 = efficiency.s3;
  console.log(`│  S3 搜索链:                                                         │`);
  console.log(`│    独立主题: ${String(s3.uniqueTopics).padStart(4)}  |  触发告警: ${s3.chainsTriggered}  |  总搜索: ${s3.totalSearches}`.padEnd(70) + '│');
  if (s3.chainsTriggered > 0) {
    console.log(`│    平均触发前搜索次数: ${s3.avgSearchesBeforeTrigger}`.padEnd(70) + '│');
  }
  console.log('└─────────────────────────────────────────────────────────────────────┘');

  // --- 4. ROI 预测 ---
  const roi = projectMonthlyROI(sessions);
  if (roi) {
    console.log('\n┌─────────────────────────────────────────────────────────────────────┐');
    console.log('│  4. 月度 ROI 预测                                                   │');
    console.log('├─────────────────────────────────────────────────────────────────────┤');
    console.log(`│  观测跨度: ${roi.observedDays} 天  |  ${roi.sessionsCount} sessions`.padEnd(70) + '│');
    console.log(`│  日均: ${roi.dailyAvg.rounds} 轮  ${$(roi.dailyAvg.cost)} 成本  ${$(roi.dailyAvg.saved)} 节省`.padEnd(70) + '│');
    console.log('│'.padEnd(70) + '│');
    console.log(`│  月度外推 (×30):`.padEnd(70) + '│');
    console.log(`│    预计成本:  ${$(roi.monthlyProjection.cost)}`.padEnd(70) + '│');
    console.log(`│    预计节省:  ${$(roi.monthlyProjection.saved)}`.padEnd(70) + '│');
    console.log(`│    节省率:    ${(roi.savingsRate * 100).toFixed(1)}%`.padEnd(70) + '│');
    if (roi.note) {
      console.log(`│  ${roi.note}`.padEnd(70) + '│');
    }
    console.log('└─────────────────────────────────────────────────────────────────────┘');

    // Sparkline hint
    if (byDay.length >= 2) {
      console.log('\n  趋势 (节省 token/天):');
      const maxSaved = Math.max(...byDay.map(d => d.savedTokens));
      const bars = '▁▂▃▄▅▆▇█';
      const sparkline = byDay.map(d => {
        const idx = maxSaved > 0 ? Math.round((d.savedTokens / maxSaved) * (bars.length - 1)) : 0;
        return bars[idx];
      }).join('');
      console.log(`  ${byDay[0].date} ${sparkline} ${byDay[byDay.length-1].date}`);
    }
  }

  console.log();
}

function renderJson(sessions) {
  const result = {
    generatedAt: new Date().toISOString(),
    byModel: analyzeByModel(sessions),
    byDay: analyzeByDay(sessions),
    strategyEfficiency: analyzeStrategyEfficiency(sessions),
    monthlyROI: projectMonthlyROI(sessions),
    raw: sessions.map(s => ({
      id: s.id,
      date: dayKey(s.mtime),
      mtime: s.mtime.toISOString(),
      costTracker: s.costTracker,
      suppressionStats: s.suppressionStats,
      searchChains: (s.searchHistory || []).map(h => ({
        topic: h.topic,
        searches: h.count + (h.triggeredCount || 0),
        triggered: (h.triggeredCount || 0) > 0,
      })),
    })),
  };
  console.log(JSON.stringify(result, null, 2));
}

// === CLI ===

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const daysIdx = args.indexOf('--days');
const daysFilter = daysIdx >= 0 ? parseInt(args[daysIdx + 1]) : null;
const modelIdx = args.indexOf('--model');
const modelFilter = modelIdx >= 0 ? args[modelIdx + 1] : null;

let sessions = loadAllSessions();

if (daysFilter) {
  const cutoff = new Date(Date.now() - daysFilter * 24 * 60 * 60 * 1000);
  sessions = sessions.filter(s => s.mtime >= cutoff);
}

if (modelFilter) {
  sessions = sessions.filter(s => {
    const ct = s.costTracker;
    if (!ct) return false;
    if (modelFilter === 'deepseek' && ct.pricePerM === 0.14) return true;
    if (modelFilter === 'opus' && ct.pricePerM === 1.50) return true;
    if (modelFilter === 'sonnet' && ct.pricePerM === 0.30) return true;
    return false;
  });
}

if (asJson) {
  renderJson(sessions);
} else {
  renderText(sessions);
}
