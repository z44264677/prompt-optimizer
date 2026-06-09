#!/bin/bash
# Prompt Optimizer v0.2 — Context Inflation Suppressor
# 安装方式:
#   方式 1 (推荐): claude plugin install <git-url>
#   方式 2 (本地):  bash install.sh
#   卸载:         bash install.sh --uninstall

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_NAME="prompt-optimizer"
VERSION="0.2.0"

# ============================================================
# 卸载
# ============================================================
if [ "$1" = "--uninstall" ]; then
  echo "[${PLUGIN_NAME}] Uninstalling..."

  # 1. claude plugin uninstall (if available)
  claude plugin uninstall "${PLUGIN_NAME}" 2>/dev/null || true

  # 2. 清理 hooks (从 settings.json 中移除)
  node -e "
    const fs = require('fs');
    const settingsPath = require('os').homedir() + '/.claude/settings.json';
    try {
      let s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (s.hooks) {
        for (const k of ['PostToolUse','UserPromptSubmit','SessionStart']) {
          if (s.hooks[k]) s.hooks[k] = s.hooks[k].filter(h =>
            !(h.hookName||'').includes('${PLUGIN_NAME}') &&
            !(h.command||'').includes('${PLUGIN_NAME}') &&
            !JSON.stringify(h.hooks||[]).includes('${PLUGIN_NAME}')
          );
          if (s.hooks[k] && !s.hooks[k].length) delete s.hooks[k];
        }
        if (!Object.keys(s.hooks).length) delete s.hooks;
      }
      fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
      console.log('Hooks removed from settings.json');
    } catch(e) { console.log('settings.json already clean'); }
  "

  # 3. 清理缓存
  rm -rf "${HOME}/.claude/plugins/cache/${PLUGIN_NAME}"

  echo "[${PLUGIN_NAME}] Uninstalled."
  exit 0
fi

# ============================================================
# 本地安装 (开发/离线用)
# ============================================================
echo "[${PLUGIN_NAME}] Installing locally..."
cd "$DIR"

# 构建
[ -d node_modules ] || npm install --production
npx tsc 2>/dev/null

PLUGIN_DIR="${HOME}/.claude/plugins/cache/${PLUGIN_NAME}/${PLUGIN_NAME}/${VERSION}"

# 复制文件
mkdir -p "$PLUGIN_DIR"
cp -r dist hooks config package.json .claude-plugin "$PLUGIN_DIR/" 2>/dev/null || true

# 注册 hooks
node -e "
const fs = require('fs');
const path = require('path');
const settingsPath = require('os').homedir() + '/.claude/settings.json';
const pd = '${PLUGIN_DIR}';

let s = {};
try { s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch(e) {}
s.hooks = s.hooks || {};

// 清除旧的
for (const k of ['PostToolUse','UserPromptSubmit','SessionStart']) {
  if (!s.hooks[k]) s.hooks[k] = [];
  s.hooks[k] = s.hooks[k].filter(h => !(h.hookName||'').includes('${PLUGIN_NAME}'));
}

// 注册新的 (与 hooks/hooks.json 一致)
s.hooks.PostToolUse.push({
  matcher: '',
  hooks: [{ type: 'command', command: 'node ' + pd + '/dist/hooks/post-tool-use-entry.js' }]
});
s.hooks.UserPromptSubmit.push({
  matcher: '',
  hooks: [{ type: 'command', command: 'node ' + pd + '/dist/hooks/user-prompt-submit-entry.js' }]
});
s.hooks.SessionStart.push({
  matcher: '',
  hooks: [{ type: 'command', command: 'node ' + pd + '/dist/hooks/session-start-entry.js' }]
});

fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
console.log('Hooks registered');
"

echo ""
echo "========================================="
echo "  Prompt Optimizer v${VERSION} installed"
echo ""
echo "  功能:"
echo "    S1: Bash 大输出截断 (>10K chars)"
echo "    S2: Read 大文件提醒 (>6K chars)"
echo "    S3: WebSearch 搜索链检测 (3+次)"
echo "    S4: 啰嗦检测 (默认关闭)"
echo "    S5: Session 成本追踪"
echo ""
echo "  预期节省: ~\$65/月"
echo "  配置: ${PLUGIN_DIR}/config/default.json"
echo "========================================="
echo ""
echo "  📦 上传到 GitHub 后可通过以下命令安装:"
echo "     claude plugin install github.com/z44264677/prompt-optimizer"
echo ""
