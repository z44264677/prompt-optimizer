# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在当前仓库中工作时提供指导。

## 项目概览

**prompt-optimizer** (v0.2.0) 是一个 Claude Code 插件，通过 5 种纯规则策略（S1-S5）自动抑制 context 膨胀。零 LLM 调用，零额外成本。基于 arXiv:2604.22750 论文 + 18 个真实 session × 7 个模型数据验证。预计月省 ~$65。

## 构建与测试

```bash
npm run build       # tsc — 将 hooks/ 和 config/ 编译到 dist/
npm run dev         # tsc --watch
npm run test        # vitest run（目前只有一个测试文件：test/unit/PostToolUse.test.ts）
npm run test:watch  # vitest 监听模式
npm run lint        # eslint src/ test/
npm run typecheck   # tsc --noEmit
```

TypeScript target: ES2022，ESM 模块（`"type": "module"`），bundler 模块解析。`tsconfig.json` 包含 `src/`、`hooks/`、`config/`，但不包含 `test/`（测试由 vitest 直接运行 ts 源文件）。

## 架构

### 插件 Hook 模型

插件通过 `hooks/hooks.json` 中定义的 3 个 Hook 事件拦截 Claude Code：

| Hook 事件 | 入口文件 | 用途 |
|---|---|---|
| **PostToolUse** | `hooks/post-tool-use-entry.ts` | S1-S3 + S5：工具结果抑制 + 成本追踪 |
| **UserPromptSubmit** | `hooks/user-prompt-submit-entry.ts` | S4：啰嗦检测（v0.2 是 passthrough 桩，完整流水线是 v0.3） |
| **SessionStart** | `hooks/session-start-entry.ts` | 为 S3/S5 初始化 session 状态 |

每个入口文件是一个独立的 Node.js 脚本，从 stdin 读 JSON、向 stdout 写 JSON。Claude Code **每次 Hook 调用都会启动一个新进程**，因此所有跨调用状态必须通过文件持久化。

### 抑制策略

| 策略 | Hook | 触发条件 | 动作 |
|---|---|---|---|
| **S1** | PostToolUse | Bash 输出 > maxChars（15K） | head+tail 截断，丢弃中间部分 |
| **S2** | PostToolUse | Read 文件 > maxChars（6K） | 注入 offset/limit 使用提醒 |
| **S3** | PostToolUse | WebSearch 同主题 ≥3 次 | 注入搜索历史摘要 |
| **S4** | UserPromptSubmit | 20 轮 output 均值 >800 tok | 注入"请简洁"提醒（默认关闭） |
| **S5** | PostToolUse | 累计成本达到阈值 | 注入成本提醒 |

### 核心文件

- **`src/types.ts`** — `SuppressorConfig` 接口 + `DEFAULT_SUPPRESSOR_CONFIG`。S1-S5 所有配置的单一数据源。
- **`hooks/PostToolUse.ts`** — S1（截断）、S2（Read 提醒）、S3（搜索链）、S5（成本追踪）的核心逻辑。导出 `onPostToolUse()`、`initSession()`、`resetSession()`、`trackSessionCost()`。
- **`hooks/post-tool-use-entry.ts`** — stdin→stdout 适配层：解析 Claude Code Hook 输入，调用 `onPostToolUse()` + `trackSessionCost()`，将结果以 JSON 写入 stdout。
- **`config/loader.ts`** — 加载 `config/default.json`，支持 `PO_*` 环境变量覆盖。失败时回退到硬编码默认值。
- **`config/default.json`** — 5 个策略 + 预算上限的运行时配置。
- **`hooks/UserPromptSubmit.ts`** — 完整的 v0.3 流水线代码（成本预估器、直接回答路由、预算治理器、P1-P5 路由）。被入口文件 import，但 v0.2 中**尚未接线**。
- **`hooks/user-prompt-submit-entry.ts`** — 当前 v0.2 桩：仅 passthrough。
- **`.claude-plugin/plugin.json`** — `claude plugin` CLI 使用的插件元数据。
- **`.claude-plugin/marketplace.json`** — 市场列表元数据。

### 文件持久化状态（S3 和 S5）

由于 Claude Code 每次 Hook 调用都启动新进程，S3（搜索链历史）和 S5（成本累加器）使用 JSON 文件存储：
```
~/.claude/plugins/cache/prompt-optimizer/state/<sessionId>.json
```

状态结构（`SessionState`）：
- `searchHistory[]` — 每个主题的关键词集合、计数、搜索结果，用于 S3 链检测
- `costTracker` — 累计 input/output token 数、轮次、上次告警阈值，用于 S5
- `suppressionStats` — 所有策略的计数器（用于报告）

状态在 `SessionStart` 时通过 `initSession()` 创建，每次 `PostToolUse` 调用时加载/保存。测试用 `resetSession()` 清理。

### S5 成本追踪

模型价格硬编码在 `MODEL_PRICES` 映射中。成本通过 token 估算（大致 4 字符/token，从内容长度估算）乘以 `pricePerM / 1,000,000` 计算。当轮次 > 20 且累计成本达到配置的 USD 阈值时触发告警。

### v0.3 流水线（规划中，代码在 UserPromptSubmit.ts）

`UserPromptSubmit.ts` 文件包含完整的多路由流水线（P1-P5），其中 import 了大量 `src/` 下尚不存在的模块。v0.2 中 `user-prompt-submit-entry.ts` 是简单的 passthrough 桩。v0.3 流水线将加入：
- 通过小模型进行成本预估
- 简单问题的直接回答路由（P3）
- 带软/硬上限的预算治理器
- 重复 prompt 的精确缓存
- API 故障时的降级/回退

### 插件安装

- 本地安装（marketplace.json 中 source 为 `"./"`，即本目录）
- 安装命令：`claude plugin install github.com/z44264677/prompt-optimizer` 或本地 `bash install.sh`
- 卸载：`claude plugin uninstall prompt-optimizer`

## 依赖

- `@anthropic-ai/sdk` — v0.3 成本预估器使用（尚未接线）
- `better-sqlite3` — v0.3 metrics 数据库使用（尚未接线）
- `openai` — 备用模型提供商（尚未接线）

这些在 `package.json` 中声明，但运行时只有 v0.2 的 Hook 文件（纯 Node.js + fs）被实际使用。
