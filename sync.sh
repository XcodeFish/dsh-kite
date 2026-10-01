#!/usr/bin/env bash
# 一键同步：重启中继 + 校验各组件版本一致性 + 提示是否需要重启 DSH。
# 用法：./sync.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "=== 1. 最新提交 ==="
LAST_COMMIT_TS=$(git log -1 --format=%ct)
git log -1 --format="  %h %ad %s" --date=format:"%H:%M:%S"

echo
echo "=== 2. 重启中继（代码改动即生效） ==="
if launchctl kickstart -k "gui/$(id -u)/com.dsh-kite.relay" 2>/dev/null; then
  echo "  中继已重启"
else
  echo "  ⚠ launchctl 重启失败，尝试直接启动"
  pkill -f "relay/server.mjs" 2>/dev/null
  nohup "$ROOT/relay/start-local.sh" >/dev/null 2>&1 & disown
  echo "  已直接启动"
fi
sleep 2
curl -s --max-time 4 http://127.0.0.1:8787/healthz | sed 's/^/  健康: /'
echo

echo "=== 3. 各组件版本一致性检查 ==="
RELAY_PID=$(pgrep -f "relay/server.mjs" | head -1)
if [ -n "$RELAY_PID" ]; then
  RELAY_START=$(ps -p "$RELAY_PID" -o lstart= | xargs -I{} date -j -f "%a %b %d %T %Y" "{}" +%s 2>/dev/null || echo 0)
  if [ "$RELAY_START" -lt "$LAST_COMMIT_TS" ]; then
    echo "  ⚠ 中继启动早于最新提交（若刚重启过请忽略）"
  else
    echo "  ✓ 中继已是最新"
  fi
fi

HOST_PID=$(pgrep -f "Resources/app/lib/host.js" | head -1)
if [ -n "$HOST_PID" ]; then
  HOST_START=$(ps -p "$HOST_PID" -o lstart= | xargs -I{} date -j -f "%a %b %d %T %Y" "{}" +%s 2>/dev/null || echo 0)
  if [ "$HOST_START" -lt "$LAST_COMMIT_TS" ]; then
    echo "  ✗ DSH 宿主启动早于最新提交 —— 【必须重启 DSH】才能加载插件新代码"
  else
    echo "  ✓ DSH 宿主已是最新"
  fi
else
  echo "  ? 未找到 DSH 宿主进程"
fi
echo

echo "=== 4. 端到端自检（不需要人工操作） ==="
node --test test/*.test.mjs 2>&1 | grep -E "^# (pass|fail)" | sed 's/^/  /'
echo

echo "=== 5. 当前可用的配对入口 ==="
PORT=$(lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null | grep -E "DSH|DeepSeek" | awk '{print $9}' | grep -o '[0-9]*$' | head -20 | while read p; do
  if curl -s -o /dev/null -w "%{http_code}" --max-time 1 "http://127.0.0.1:$p/kite" 2>/dev/null | grep -qE "^(200|401|303)$"; then echo "$p"; break; fi
done)
if [ -n "$PORT" ]; then
  echo "  DSH web 端口: $PORT"
  echo "  面板地址（需宿主会话）: http://127.0.0.1:$PORT/kite"
else
  echo "  ⚠ 未找到插件路由端口"
fi
