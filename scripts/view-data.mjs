#!/usr/bin/env node
/**
 * prompt-optimizer 数据查看器 v2
 * 用法: node scripts/view-data.mjs [--watch] [--json] [--session <id>]
 *
 * --watch   每秒刷新，增量显示变化
 * --json    输出原始 JSON
 * --session 只看指定 session
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';

const STATE_DIR = join(process.env.HOME, '.claude', 'plugins', 'cache', 'prompt-optimizer', 'state');

function $(usd) { return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`; }
function tk(n) { return n >= 1_000_000 ? `${(n/1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n/1_000).toFixed(1)}K` : String(n); }

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

function calcSavings(ss) {
  if (!ss) return { bashTokens: 0, bashCost: 0, readTokens: 0, readCost: 0, searchTokens: 0, searchCost: 0, totalTokens: 0, totalCost: 0 };
  const bashTokens = Math.round((ss.bashCharsBefore - ss.bashCharsAfter) / 4);
  const readTokens = ss.readReminders * 2000;
  const searchTokens = ss.searchSearchesPrevented * 5000;
  const totalTokens = bashTokens + readTokens + searchTokens;
  const totalCost = (totalTokens / 1_000_000) * 3.0;
  return { bashTokens, bashCost: (bashTokens/1_000_000)*3.0, readTokens, readCost: (readTokens/1_000_000)*3.0, searchTokens, searchCost: (searchTokens/1_000_000)*3.0, totalTokens, totalCost };
}

// ---- v2: incremental append mode for --watch ----

let lastSnapshot = {};
let tick = 0;

function snapshot(sessions) {
  const snap = {};
  for (const s of sessions) {
    const ct = s.costTracker;
    const ss = s.suppressionStats || {};
    snap[s.id] = {
      rounds: ct?.rounds || 0,
      input: ct?.totalInputTokens || 0,
      output: ct?.totalOutputTokens || 0,
      ss: {
        bashTruncations: ss.bashTruncations || 0,
        readReminders: ss.readReminders || 0,
        searchChainWarnings: ss.searchChainWarnings || 0,
        costAlerts: ss.costAlerts || 0,
      },
      mtime: s.mtime.getTime(),
    };
  }
  return snap;
}

function renderWatch(sessions) {
  const now = new Date();
  const current = snapshot(sessions);
  tick++;

  // First run: show full header + initial state
  if (tick === 1) {
    console.log('═'.repeat(72));
    console.log(`  prompt-optimizer · 实时监控  [${now.toLocaleTimeString()}]`);
    console.log('═'.repeat(72));

    const activeSessions = sessions.filter(s => s.costTracker && s.costTracker.rounds > 0);
    if (activeSessions.length === 0) {
      console.log('\n  (等待数据...)');
    }
    for (const s of activeSessions) {
      const ct = s.costTracker;
      const ss = s.suppressionStats || {};
      console.log(`\n  ▸ ${s.id.slice(0, 8)}...  ${ct.rounds} 轮  ${tk(ct.totalInputTokens)} in  ${tk(ct.totalOutputTokens)} out  ${$( (ct.totalInputTokens*(ct.pricePerM||0.14))/1_000_000 )}`);
      const events = [];
      if (ss.bashTruncations) events.push(`S1×${ss.bashTruncations}`);
      if (ss.readReminders) events.push(`S2×${ss.readReminders}`);
      if (ss.searchChainWarnings) events.push(`S3×${ss.searchChainWarnings}`);
      if (ss.costAlerts) events.push(`S5×${ss.costAlerts}`);
      if (events.length) console.log(`    事件: ${events.join(' ')}`);
    }
    console.log(`\n  ── 等待变化...`);
  }

  // Skip change detection on first tick (initial snapshot)
  const isFirstTick = Object.keys(lastSnapshot).length === 0;

  // Detect changes
  for (const s of sessions) {
    const prev = lastSnapshot[s.id];
    const cur = current[s.id];
    if (!cur) continue;
    if (!prev) {
      // New session appeared (skip on first tick)
      if (!isFirstTick) {
        const ct = s.costTracker;
        if (ct && ct.rounds > 0) {
          console.log(`\n  🆕 新 session: ${s.id.slice(0, 8)}...  ${ct.rounds} 轮`);
        }
      }
      continue;
    }

    // Check each field
    const changes = [];
    const ts = new Date().toLocaleTimeString();

    if (cur.rounds !== prev.rounds) {
      changes.push(`轮数 ${prev.rounds}→${cur.rounds} (+${cur.rounds - prev.rounds})`);
    }
    if (cur.input !== prev.input) {
      const delta = cur.input - prev.input;
      changes.push(`input ${tk(prev.input)}→${tk(cur.input)} (+${tk(delta)})`);
    }
    if (cur.output !== prev.output) {
      const delta = cur.output - prev.output;
      changes.push(`output ${tk(prev.output)}→${tk(cur.output)} (+${tk(delta)})`);
    }
    // S1-S5 events
    for (const [key, label] of Object.entries({ bashTruncations: 'S1', readReminders: 'S2', searchChainWarnings: 'S3', costAlerts: 'S5' })) {
      if (cur.ss[key] !== prev.ss[key]) {
        changes.push(`${label} ${prev.ss[key]}→${cur.ss[key]} 🎯`);
      }
    }

    if (changes.length > 0) {
      console.log(`  [${ts}] ${s.id.slice(0, 8)}...  ${changes.join('  |  ')}`);
    }
  }

  lastSnapshot = current;
}

function renderStatic(sessions) {
  const now = new Date();
  console.log('═'.repeat(72));
  console.log(`  prompt-optimizer · Context Inflation Suppressor  [${now.toLocaleTimeString()}]`);
  console.log('═'.repeat(72));

  if (sessions.length === 0) {
    console.log('\n  (暂无数据)\n');
    return;
  }

  // Aggregate
  let totalTrunc = 0, totalRemind = 0, totalWarn = 0, totalPrevented = 0, totalAlerts = 0;
  let totalBashCharsBefore = 0, totalBashCharsAfter = 0;
  let aggSearchChains = 0, aggTriggered = 0;
  let aggRounds = 0, aggInput = 0, aggOutput = 0;

  for (const s of sessions) {
    const ss = s.suppressionStats || {};
    totalTrunc += ss.bashTruncations || 0;
    totalRemind += ss.readReminders || 0;
    totalWarn += ss.searchChainWarnings || 0;
    totalPrevented += ss.searchSearchesPrevented || 0;
    totalAlerts += ss.costAlerts || 0;
    totalBashCharsBefore += ss.bashCharsBefore || 0;
    totalBashCharsAfter += ss.bashCharsAfter || 0;
    const sh = s.searchHistory || [];
    aggSearchChains += sh.length;
    aggTriggered += sh.filter(h => (h.triggeredCount||0) > 0).length;
    const ct = s.costTracker;
    if (ct) { aggRounds += ct.rounds||0; aggInput += ct.totalInputTokens||0; aggOutput += ct.totalOutputTokens||0; }
  }

  const bashTokens = Math.round((totalBashCharsBefore - totalBashCharsAfter) / 4);
  const readTokens = totalRemind * 2000;
  const searchTokens = totalPrevented * 5000;
  const totalSaved = bashTokens + readTokens + searchTokens;
  const savedCost = (totalSaved / 1_000_000) * 3.0;
  const estCost = (aggInput * 0.14) / 1_000_000;
  const savingsRate = aggInput > 0 ? (totalSaved / aggInput * 100).toFixed(1) : '0.0';

  // S5 realtime
  const activeSession = sessions.find(s => s.costTracker && s.costTracker.rounds > 0);
  if (activeSession) {
    const ct = activeSession.costTracker;
    const age = Math.round((now - activeSession.mtime) / 1000);
    const indicator = age < 120 ? '🟢 活跃' : `🟡 ${age}s 前`;
    console.log('\n  ╔══════════════════════════════════════════════════════════════╗');
    console.log('  ║              📡 S5 实时成本追踪                             ║');
    console.log('  ╠══════════════════════════════════════════════════════════════╣');
    console.log(`  ║  Session:  ${activeSession.id.slice(0, 36)}  ${indicator.padEnd(12)}║`);
    console.log(`  ║  已进行:  ${String(ct.rounds).padStart(6)} 轮                                ║`);
    console.log(`  ║  Input:   ${tk(ct.totalInputTokens).padStart(10)} tokens                        ║`);
    console.log(`  ║  Output:  ${tk(ct.totalOutputTokens).padStart(10)} tokens                        ║`);
    console.log(`  ║  预估成本: ${$( (ct.totalInputTokens*(ct.pricePerM||0.14))/1_000_000 ).padStart(10)}  (@ ${$(ct.pricePerM||0.14)}/M)                    ║`);
    console.log('  ╚══════════════════════════════════════════════════════════════╝');
  }

  // Dashboard
  console.log('\n  ╔══════════════════════════════════════════════════════════════╗');
  console.log('  ║                     💰 抑制效果总览                         ║');
  console.log('  ╠══════════════════════════════════════════════════════════════╣');
  console.log(`  ║  策略     触发次数    节省 Token      节省成本               ║`);
  console.log('  ╠══════════════════════════════════════════════════════════════╣');

  const s1Label = `S1 Bash截断`.padEnd(12);
  console.log(`  ║  ${s1Label}${String(totalTrunc).padStart(6)} 次${tk(bashTokens).padStart(10)}${$(savedCost * (bashTokens/totalSaved || 0)).padStart(10)}           ║`);

  const s2Label = `S2 Read提醒`.padEnd(12);
  console.log(`  ║  ${s2Label}${String(totalRemind).padStart(6)} 次${tk(readTokens).padStart(10)}${$(savedCost * (readTokens/totalSaved || 0)).padStart(10)}           ║`);

  const s3Label = `S3 搜索链`.padEnd(12);
  console.log(`  ║  ${s3Label}${String(totalWarn).padStart(6)} 次${tk(searchTokens).padStart(10)}${$(savedCost * (searchTokens/totalSaved || 0)).padStart(10)}           ║`);

  console.log(`  ║  ${`S5 成本提醒`.padEnd(12)}${String(totalAlerts).padStart(6)} 次       —            —           ║`);
  console.log('  ╠══════════════════════════════════════════════════════════════╣');
  console.log(`  ║  合计                ${tk(totalSaved).padStart(10)}${$(savedCost).padStart(10)}           ║`);
  console.log('  ╚══════════════════════════════════════════════════════════════╝');

  console.log(`\n  📊 ${sessions.length} sessions, ${aggRounds} 轮, ${tk(aggInput)} in, ${tk(aggOutput)} out`);
  console.log(`  💵 成本: ${$(estCost)}  |  节省: ${$(savedCost)}  |  节省率: ${savingsRate}%`);

  // Per-session
  console.log('\n' + '─'.repeat(72));
  for (const s of sessions) {
    const ct = s.costTracker;
    const ss = s.suppressionStats || {};
    const sv = calcSavings(ss);
    console.log(`\n  ▸ ${s.id}  (${s.mtime.toLocaleString()})`);
    if (ct && ct.rounds > 0) {
      console.log(`    S5: ${ct.rounds} 轮, ${tk(ct.totalInputTokens)} in / ${tk(ct.totalOutputTokens)} out, ${$( (ct.totalInputTokens*(ct.pricePerM||0.14))/1_000_000 )}`);
    }
    const parts = [];
    if (ss.bashTruncations) parts.push(`S1×${ss.bashTruncations}`);
    if (ss.readReminders) parts.push(`S2×${ss.readReminders}`);
    if (ss.searchChainWarnings) parts.push(`S3×${ss.searchChainWarnings}`);
    if (ss.costAlerts) parts.push(`S5×${ss.costAlerts}`);
    if (parts.length) console.log(`    抑制: ${parts.join(', ')}  |  省 ${tk(sv.totalTokens)} tokens`);
  }
  console.log();
}

function renderJson(sessions) {
  let agg = { bashTruncations:0, readReminders:0, searchChainWarnings:0, searchSearchesPrevented:0, costAlerts:0, bashCharsBefore:0, bashCharsAfter:0 };
  const items = sessions.map(s => {
    const ss = s.suppressionStats || {};
    for (const k of Object.keys(agg)) agg[k] += (ss[k] || 0);
    return { id: s.id, updated: s.mtime.toISOString(), costTracker: s.costTracker, suppressionStats: ss, searchChains: (s.searchHistory||[]).map(h => ({ topic: h.topic, count: h.count, triggered: (h.triggeredCount||0)>0 })) };
  });
  const bashTokens = Math.round((agg.bashCharsBefore - agg.bashCharsAfter) / 4);
  const readTokens = agg.readReminders * 2000;
  const searchTokens = agg.searchSearchesPrevented * 5000;
  console.log(JSON.stringify({
    summary: { sessions: items.length, ...agg, estimatedTokensSaved: bashTokens+readTokens+searchTokens, estimatedCostSaved: ((bashTokens+readTokens+searchTokens)/1_000_000)*3.0 },
    sessions: items,
  }, null, 2));
}

const watch = process.argv.includes('--watch');
const asJson = process.argv.includes('--json');
const filterSession = process.argv.includes('--session') ? process.argv[process.argv.indexOf('--session') + 1] : null;

function getSessions() {
  let sessions = loadAllSessions();
  if (filterSession) sessions = sessions.filter(s => s.id === filterSession || s.id.startsWith(filterSession));
  return sessions;
}

if (watch) {
  // Incremental mode — never clears, just appends changes
  console.log('🟢 prompt-optimizer 实时监控已启动 (Ctrl+C 退出)\n');
  const sessions = getSessions();
  renderWatch(sessions);
  setInterval(() => renderWatch(getSessions()), 1000);
} else if (asJson) {
  renderJson(getSessions());
} else {
  renderStatic(getSessions());
}
