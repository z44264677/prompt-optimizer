#!/usr/bin/env node
/**
 * 模拟真实 session 数据 — 直接 import 模块，不通过 stdin pipe。
 *
 * spawnSync.input 对 ESM stdin 不生效，execSync shell pipe 也不稳定。
 * 最可靠的方式：直接调用模块导出的函数。
 */
import { onPostToolUse, resetSession, trackSessionCost } from '../dist/hooks/PostToolUse.js';
import { loadConfig } from '../dist/config/loader.js';

const SID = 'sim-real-20260610';
const config = loadConfig();

// SessionStart
resetSession(SID);
console.log('✅ SessionStart');

const tools = [
  { t: 'Bash', c: 'git status', r: 'On branch main\nnothing to commit...' },
  { t: 'Read', f: 'src/index.ts', r: 'export function hello() { return "world"; }\n'.repeat(100) },
  { t: 'Bash', c: 'npm test', r: 'Tests: 14 passed\n'.repeat(5) },
  { t: 'Read', f: 'package.json', r: '{"name":"test"}\n'.repeat(200) },
  { t: 'Bash', c: 'ls', r: 'file1\nfile2\n'.repeat(3) },
  { t: 'WebSearch', q: 'React hooks performance optimization useMemo useCallback', r: '{"organic":[{"title":"React useMemo Guide"},{"title":"useCallback Best Practices"},{"title":"React Performance 2026"}]}' },
  { t: 'Bash', c: 'npm run build', r: 'Build completed in 2.3s\n'.repeat(10) },
  { t: 'WebSearch', q: 'React useMemo vs useCallback when to use', r: '{"organic":[{"title":"useMemo vs useCallback"},{"title":"React memoization patterns"}]}' },
  { t: 'Read', f: 'hooks/PostToolUse.ts', r: '// PostToolUse hook...\n'.repeat(500) },
  { t: 'WebSearch', q: 'React render optimization memo techniques', r: '{"organic":[{"title":"React.memo deep dive"},{"title":"Avoid unnecessary re-renders"}]}' },
  { t: 'Bash', c: 'tsc --noEmit', r: 'Found 0 errors.\n' },
  { t: 'WebSearch', q: 'TypeScript conditional types infer keyword', r: '{"organic":[{"title":"TypeScript Conditional Types"},{"title":"infer keyword explained"}]}' },
  { t: 'Bash', c: 'npm install', r: 'added 5 packages\n'.repeat(8) },
  { t: 'WebSearch', q: 'typescript template literal types examples', r: '{"organic":[{"title":"Template Literal Types"},{"title":"TypeScript 4.1 features"}]}' },
  { t: 'Read', f: 'src/types.ts', r: 'export type Foo = string;\n'.repeat(300) },
  { t: 'WebSearch', q: 'TypeScript recursive conditional types', r: '{"organic":[{"title":"Recursive Types in TS"},{"title":"Advanced TypeScript patterns"}]}' },
  { t: 'Bash', c: 'npm run lint', r: 'No lint errors found.\n'.repeat(3) },
  { t: 'WebSearch', q: 'React Server Components vs Client Components 2026', r: '{"organic":[{"title":"RSC Guide 2026"},{"title":"Next.js App Router patterns"}]}' },
  { t: 'Bash', c: 'cat output.log', r: 'x'.repeat(18000) },
  { t: 'WebSearch', q: 'typescript satisfies operator usage patterns', r: '{"organic":[{"title":"satisfies keyword"},{"title":"TypeScript 4.9 features"}]}' },
  { t: 'Bash', c: 'docker ps', r: 'CONTAINER ID   IMAGE   STATUS\n'.repeat(2) },
  { t: 'Read', f: 'README.md', r: '# Project\n\nDescription here.\n'.repeat(600) },
  { t: 'WebSearch', q: 'RSC streaming SSR patterns Next.js', r: '{"organic":[{"title":"Streaming SSR with RSC"},{"title":"Next.js partial rendering"}]}' },
  { t: 'Bash', c: 'grep -r "TODO" src/', r: 'src/a.ts:// TODO: fix\nsrc/b.ts:// TODO: refactor\n'.repeat(10) },
  { t: 'WebSearch', q: 'typescript decorators stage 3 proposal', r: '{"organic":[{"title":"TC39 Decorators Proposal"},{"title":"TypeScript 5.0 decorators"}]}' },
];

let totalIn = 0, totalOut = 0;
for (let i = 0; i < tools.length; i++) {
  const t = tools[i];
  const inToks = 3000 + Math.floor(Math.random() * 7000);
  const outToks = 100 + Math.floor(Math.random() * 400);
  totalIn += inToks; totalOut += outToks;

  // S1-S3
  const result = onPostToolUse({
    sessionId: SID,
    toolName: t.t,
    toolInput: t.t === 'WebSearch' ? { query: t.q } : (t.t === 'Read' ? { file_path: t.f } : { command: t.c }),
    toolResult: t.r,
    isError: false,
  }, config.suppressor);

  // S5
  if (config.suppressor.costAlert?.enabled) {
    trackSessionCost(SID, 'deepseek-v4-pro', inToks, outToks, config.suppressor.costAlert.thresholdsUsd);
  }

  if (result.injection) {
    console.log(`\n  ⚡ R${i + 1}: ${result.injection.slice(0, 100).replace(/\n/g, ' ')}`);
  }
  process.stdout.write(`\r  轮次 ${i + 1}/${tools.length} (in: ${(totalIn/1000).toFixed(0)}K, out: ${(totalOut/1000).toFixed(0)}K)`);
}

const cost = (totalIn * 0.14) / 1_000_000;
console.log(`\n\n✅ 模拟完成: ${tools.length} 轮, ~${(totalIn/1000).toFixed(0)}K input tokens`);
console.log(`   估算成本: $${cost.toFixed(2)} (deepseek-v4-pro @ $0.14/M)`);
console.log('\n运行: node scripts/view-data.mjs');
