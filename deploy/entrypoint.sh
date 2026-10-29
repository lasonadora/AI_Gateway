#!/bin/sh
# 容器启动脚本：
# 1. 确保持久卷目录存在并归 node 用户
# 2. 用环境变量渲染 openclaw.json（配置在 Git 里，状态在卷里）
# 3. 把密钥写进 ~/.openclaw/.env（给 Gateway 和 MCP 子进程用）
# 4. 把仓库里的技能同步到工作区
# 5. 以 node 用户启动 Gateway
set -eu

STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$STATE_DIR/workspace}"
TEMPLATE=/opt/agent-platform/openclaw.json5

: "${OPENCLAW_GATEWAY_TOKEN:?必须设置 OPENCLAW_GATEWAY_TOKEN（手机和电脑连 Gateway 用的密码）}"
: "${ANTHROPIC_API_KEY:?必须设置 ANTHROPIC_API_KEY}"

mkdir -p "$STATE_DIR" "$WORKSPACE_DIR/skills"

# 受信任的反代 IP：逗号分隔 → JSON 数组内容（空 → 空数组）
TRUSTED_JSON="$(printf '%s' "${OPENCLAW_TRUSTED_PROXIES:-}" | tr -d ' ' | awk -F, '{for(i=1;i<=NF;i++) if($i!="") printf("%s\"%s\"", (n++?",":""), $i)}')"
export OPENCLAW_TRUSTED_PROXIES_JSON="$TRUSTED_JSON"

# 渲染配置：把 ${VAR} 替换成环境变量；没设的变量用默认值
node - "$TEMPLATE" "$STATE_DIR/openclaw.json" <<'EOF'
const fs = require("fs");
const [tpl, out] = process.argv.slice(2);
const defaults = {
  PORT: "18789",
  OPENCLAW_TZ: "Asia/Shanghai",
  OPENCLAW_PRIMARY_MODEL: "anthropic/claude-sonnet-5-5",
  OPENCLAW_FALLBACK_MODEL: "anthropic/claude-haiku-5-5",
  OPENCLAW_UTILITY_MODEL: "anthropic/claude-haiku-5-5",
  OPENCLAW_PUBLIC_ORIGIN: "",
  OPENCLAW_TRUSTED_PROXIES_JSON: "",
};
let text = fs.readFileSync(tpl, "utf8");
text = text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => process.env[k] ?? defaults[k] ?? "");
fs.writeFileSync(out, text);
console.log(`[entrypoint] wrote ${out}`);
EOF

# 密钥文件：Gateway 启动时读 ~/.openclaw/.env；Notion MCP 包装脚本也读它
umask 077
{
  echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
  echo "NOTION_TOKEN=${NOTION_TOKEN:-}"
} > "$STATE_DIR/.env"
umask 022

# 技能：仓库里的覆盖工作区里的同名技能（技能是代码，受 Git 管理）
if [ -d /opt/agent-platform/skills ]; then
  cp -R /opt/agent-platform/skills/. "$WORKSPACE_DIR/skills/"
  echo "[entrypoint] synced skills: $(ls /opt/agent-platform/skills | tr '\n' ' ')"
fi

chown -R node:node "$STATE_DIR"

# 以 node 用户前台运行 Gateway（容器主进程）
exec su -s /bin/sh node -c "cd /home/node && exec openclaw gateway run"
