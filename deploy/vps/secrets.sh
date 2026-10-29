#!/usr/bin/env bash
# 在终端里交互式填入两把密钥（输入不回显、不进命令日志），然后启动/重启服务。
# 用法：bash /opt/ai_gateway/deploy/vps/secrets.sh
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "没有 .env，先跑 setup.sh"; exit 1; }

has() { grep -Eq "^$1=.+" .env; }

missing=()
for k in ANTHROPIC_API_KEY NOTION_TOKEN; do has "$k" || missing+=("$k"); done

if [ "${#missing[@]}" -gt 0 ]; then
  if [ ! -t 0 ]; then
    echo "还缺：${missing[*]}。在终端里运行：bash $(pwd)/secrets.sh"
    exit 0
  fi
  for k in "${missing[@]}"; do
    read -r -s -p "$k（粘贴后回车，不回显）: " v; echo
    v="${v//[$'\r\n\t ']/}"
    [ -n "$v" ] || { echo "$k 不能为空"; exit 1; }
    sed -i "s|^$k=.*|$k=$v|" .env
    echo "$k 已写入"
  done
fi

echo "== 启动 =="
docker compose up -d --build
sleep 8
docker compose ps

PUBLIC_HOST="$(grep '^PUBLIC_HOST=' .env | cut -d= -f2-)"
TOKEN="$(grep '^OPENCLAW_GATEWAY_TOKEN=' .env | cut -d= -f2-)"
cat <<EOF

部署完成。
  Control UI / Gateway: https://$PUBLIC_HOST
  手机 app 填：        wss://$PUBLIC_HOST   token 见下
  Gateway token:        $TOKEN
看日志：docker compose -f /opt/ai_gateway/deploy/vps/docker-compose.yml logs -f openclaw
EOF
