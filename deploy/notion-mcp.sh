#!/bin/sh
# OpenClaw 以 stdio 方式拉起官方 Notion MCP server 的包装脚本。
# NOTION_TOKEN 优先用进程环境里的；没有就从 ~/.openclaw/.env 读（entrypoint 写入，权限 600）。
STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
if [ -z "${NOTION_TOKEN:-}" ] && [ -f "$STATE_DIR/.env" ]; then
  set -a
  . "$STATE_DIR/.env"
  set +a
fi
exec notion-mcp-server
