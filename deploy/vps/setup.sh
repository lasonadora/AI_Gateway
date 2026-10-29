#!/usr/bin/env bash
# 在 VPS 上第一次部署 OpenClaw Gateway。以 root 运行，交互式问三把钥匙。
# 前提：仓库已 clone 到 /opt/ai_gateway（见 README 的"VPS 部署"）。
set -euo pipefail
cd "$(dirname "$0")"

echo "== 1/4 安装 Docker =="
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq docker.io docker-compose-v2 curl openssl >/dev/null
  systemctl enable --now docker >/dev/null
fi
docker --version && docker compose version

# 小内存机器（2 GiB）加 2 GiB swap，防止构建镜像或 npx 时被 OOM 杀掉
if [ ! -f /swapfile ] && [ "$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)" -lt 3072 ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "已加 2 GiB swap"
fi

echo "== 2/4 公网地址 =="
IP="$(curl -4 -fsS https://ifconfig.me || hostname -I | awk '{print $1}')"
PUBLIC_HOST="${PUBLIC_HOST:-$(echo "$IP" | tr . -).sslip.io}"   # 免费域名，自动指向这台机器的 IP
echo "Gateway 地址将是 https://$PUBLIC_HOST"

echo "== 3/4 密钥（只存在本机 .env，不进 Git） =="
if [ -f .env ]; then
  echo ".env 已存在，沿用。要改就编辑 $(pwd)/.env 后重新 docker compose up -d"
else
  read -r -p "ANTHROPIC_API_KEY: " ANTHROPIC_API_KEY
  read -r -p "NOTION_TOKEN: " NOTION_TOKEN
  read -r -p "OPENCLAW_GATEWAY_TOKEN（留空自动生成）: " OPENCLAW_GATEWAY_TOKEN
  OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-$(openssl rand -hex 24)}"
  read -r -p "时区 [Asia/Shanghai]: " OPENCLAW_TZ
  OPENCLAW_TZ="${OPENCLAW_TZ:-Asia/Shanghai}"
  umask 077
  cat > .env <<EOF
PUBLIC_HOST=$PUBLIC_HOST
OPENCLAW_GATEWAY_TOKEN=$OPENCLAW_GATEWAY_TOKEN
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
NOTION_TOKEN=$NOTION_TOKEN
OPENCLAW_TZ=$OPENCLAW_TZ
EOF
fi

echo "== 4/4 构建并启动 =="
docker compose up -d --build
sleep 5
docker compose ps

TOKEN="$(grep '^OPENCLAW_GATEWAY_TOKEN=' .env | cut -d= -f2-)"
cat <<EOF

部署完成。
  Control UI / Gateway: https://$PUBLIC_HOST
  手机 app 填：        wss://$PUBLIC_HOST   token 见下
  Gateway token:        $TOKEN
看日志：docker compose -f /opt/ai_gateway/deploy/vps/docker-compose.yml logs -f openclaw
EOF
