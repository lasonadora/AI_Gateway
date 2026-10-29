# OpenClaw Gateway 镜像（Railway / Fly / VPS 通用）
# 基于官方镜像，不改核心代码；只加一个启动脚本，把我们的配置、技能和 Notion MCP 放进去。
FROM ghcr.io/openclaw/openclaw:latest

USER root

# Notion 官方 MCP server 预装进镜像，启动时不用 npx 临时下载
RUN npm install -g @notionhq/notion-mcp-server@latest

# 我们自己的配置模板、启动脚本、MCP 包装脚本和技能（随仓库走，受 Git 管理）
COPY deploy/openclaw.json5 /opt/agent-platform/openclaw.json5
COPY deploy/entrypoint.sh  /opt/agent-platform/entrypoint.sh
COPY deploy/notion-mcp.sh  /opt/agent-platform/notion-mcp.sh
COPY skills/                /opt/agent-platform/skills/
RUN chmod +x /opt/agent-platform/entrypoint.sh /opt/agent-platform/notion-mcp.sh

# 状态目录：配置、会话、记忆、工作区都在这里；持久卷挂在这个路径
ENV OPENCLAW_STATE_DIR=/home/node/.openclaw
ENV OPENCLAW_GATEWAY_BIND=lan
ENV OPENCLAW_SKIP_ONBOARDING=1

EXPOSE 18789
ENTRYPOINT ["/opt/agent-platform/entrypoint.sh"]
