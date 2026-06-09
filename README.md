# Prompt Optimizer — Context Inflation Suppressor

> Claude Code 插件：自动抑制 context 膨胀，月省 ~$65。基于 arXiv:2604.22750 论文 + 18 session × 7 模型真实数据验证。

## 快速安装

```bash
# 方式 1: 通过 claude plugin 安装 (推荐)
claude plugin install github.com/z44264677/prompt-optimizer

# 方式 2: 本地安装
git clone https://github.com/z44264677/prompt-optimizer
cd prompt-optimizer
npm install && npx tsc && bash install.sh
```

## 功能

| 策略 | Hook | 触发条件 | 动作 | 风险 | 月省 |
|------|------|---------|------|------|------|
| S1 | PostToolUse | Bash 输出 >10K 字符 | head 5K + tail 1K | 极低 | ~$31 |
| S2 | PostToolUse | Read 文件 >6K 字符 | 建议 offset/limit | 零 | ~$11 |
| S3 | PostToolUse | WebSearch 同主题 ≥3 次 | 注入搜索历史 | 低 | ~$24 |
| S4 | UserPromptSubmit | 20 轮 output >800 tok | "请简洁" 提醒 | 中 | 不确定 |
| S5 | PostToolUse | 按成本阈值 | Session 成本提醒 | 零 | — |

## 配置

编辑 `config/default.json`：

```json
{
  "suppressor": {
    "bash":    { "enabled": true, "maxChars": 10000, "headChars": 5000, "tailChars": 1000 },
    "read":    { "enabled": true, "maxChars": 6000,  "mode": "warn" },
    "websearch": { "enabled": true, "chainThreshold": 3, "overlapThreshold": 0.3 },
    "verbose": { "enabled": false, "windowSize": 20, "threshold": 800 },
    "costAlert": { "enabled": true, "thresholdsUsd": [0.5, 1, 2, 5, 10, 20, 50] }
  }
}
```

## 原理

论文 arXiv:2604.22750 发现 AI coding agent 的成本 82.3% 来自 cache_read——同一个上下文被反复读取计费。本插件在 token 进入 context **之前**进行抑制：

- S1: Bash 大输出截断为 head+tail，丢弃中间冗余
- S2: 大文件读取后提醒使用 offset/limit 参数
- S3: 检测 WebSearch 搜索链，3 次同主题搜索后注入历史汇总
- S4: 追踪 output token 滚动均值，检测啰嗦模式
- S5: 追踪 session 累积成本，在阈值处提醒

所有策略均为纯规则，零 LLM 调用，零额外成本。

## 论文对齐

| 论文主张 | 本方案对应 |
|---------|----------|
| F1: input 主导成本 | cache_read 82.3% → S1-S3 减少 token 进入 context |
| F2: 30× 方差 | 本机 3000× → S5 成本追踪 |
| F3: 高成本≠高产出 | Spearman 0.34 → 抑制不损失产出 |
| F4: 模型效率差异 | MiniMax vs DeepSeek = 10× → 用户侧选择 |
| F5: 自我预测不可靠 | 不做预测，只做测量和规则 |
| Fig 8: cache read 主导 | 82.3% → S1-S3 直接攻击 |
| §7.2: budget-aware tool-use | S1-S3 = runtime token constraints |

## 卸载

```bash
bash install.sh --uninstall
# 或
claude plugin uninstall prompt-optimizer
```

## 许可证

MIT
