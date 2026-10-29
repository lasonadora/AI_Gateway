#!/usr/bin/env bash
# 在 VPS 上第一次部署 OpenClaw Gateway。以 root 运行。
# 前提：仓库已 clone 到 /opt/ai_gateway（见 README 的"VPS 部署"）。
# 可以不交互地跑（比如从云控制台的命令助手）：它装 Docker、加 swap、生成 .env 骨架、预构建镜像；
# 两把密钥由 secrets.sh 在终端里交互式填入（密钥不经过命令日志）。
set -euo pipefail
cd "$(dirname "$0")"
export DEBIAN_FRONTEND=noninteractive

echo "== 1/4 安装 Docker =="
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -qq
  if ! apt-get install -y -qq docker.io docker-compose-v2 curl openssl >/dev/null; then
    echo "apt 里没有 docker，改用官方安装脚本"
    apt-get install -y -qq curl openssl >/dev/null
    curl -fsSL https://get.docker.com | sh
  fi
  systemctl enable --now docker >/dev/null
fi
docker --version && docker compose version

# 小内存机器（2 GiB）加 2 GiB swap，防止构建镜像或安装依赖时被 OOM 杀掉
if [ ! -f /swapfile ] && [ "$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)" -lt 3072 ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "已加 2 GiB swap"
fi

echo "== 2/4 公网地址 =="
IP="$(curl -4 -fsS --max-time 10 https://ifconfig.me || hostname -I | awk '{print $1}')"
PUBLIC_HOST="${PUBLIC_HOST:-$(echo "$IP" | tr . -).sslip.io}"   # 免费域名，自动指向这台机器的 IP
echo "Gateway 地址将是 https://$PUBLIC_HOST"

echo "== 3/4 .env（只存在本机，不进 Git） =="
if [ -f .env ]; then
  echo ".env 已存在，沿用。要改就编辑 $(pwd)/.env 后 docker compose up -d"
else
  umask 077
  cat > .env <<EOF
PUBLIC_HOST=$PUBLIC_HOST
OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 24)
ANTHROPIC_API_KEY=
NOTION_TOKEN=
OPENCLAW_TZ=${OPENCLAW_TZ:-Asia/Shanghai}
EOF
  umask 022
  echo "已生成 .env（Gateway token 已随机生成；两把 API 密钥待填）"
fi

echo "== 4/4 预构建镜像 =="
docker compose build

# 密钥齐了就直接启动；没齐就提示在终端里跑 secrets.sh
bash ./secrets.sh
