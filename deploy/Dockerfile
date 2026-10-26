# OpenClaw Gateway on Railway
# 基于官方镜像，不改核心代码；只加一个启动脚本，把我们的配置和技能放进去。
FROM ghcr.io/openclaw/openclaw:latest

USER root

# 我们自己的配置模板和技能（随仓库走，受 Git 管理）
COPY deploy/openclaw.json5 /opt/agent-platform/openclaw.json5
COPY deploy/entrypoint.sh  /opt/agent-platform/entrypoint.sh
COPY skills/                /opt/agent-platform/skills/
RUN chmod +x /opt/agent-platform/entrypoint.sh

# 状态目录：配置、会话、记忆、工作区都在这里；Railway 的持久卷挂在这个路径
ENV OPENCLAW_STATE_DIR=/home/node/.openclaw
ENV OPENCLAW_GATEWAY_BIND=lan
ENV OPENCLAW_SKIP_ONBOARDING=1

EXPOSE 18789
ENTRYPOINT ["/opt/agent-platform/entrypoint.sh"]
