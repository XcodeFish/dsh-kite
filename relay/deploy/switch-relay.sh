#!/usr/bin/env bash
# ============================================================================
# Mac 侧：把 dsh-kite 的中继指向切到指定地址
#
#   ./switch-relay.sh --url wss://<VPS_IP>:8443 \
#                     --public https://<VPS_IP>:8443 \
#                     --token <令牌>
#
#   # 切回本机自测中继
#   ./switch-relay.sh --url ws://127.0.0.1:8787 --token "$(cat ../.local-token)"
#
# 只改 cordis.patch.yml 里 "- id: kite" 块的
# relayUrl / relayPublicUrl / relayToken 三行；改前自动备份，改后校验行数。
# 不重启 DSH —— 重启会让当前对话中断，交给你自己挑时间。
# ============================================================================
set -euo pipefail

CONF="${DSH_PROFILE_PATCH:-$HOME/.dsh/profiles/desktop/cordis.patch.yml}"
URL=""; PUB=""; TOKEN=""

while [ $# -gt 0 ]; do
  case "$1" in
    --url)    URL="${2:-}";   shift 2 ;;
    --public) PUB="${2:-}";   shift 2 ;;
    --token)  TOKEN="${2:-}"; shift 2 ;;
    --conf)   CONF="${2:-}";  shift 2 ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

[ -n "$URL" ] || { echo "缺少 --url（例如 wss://<VPS_IP>:8443）" >&2; exit 1; }
[ -n "$TOKEN" ] || { echo "缺少 --token" >&2; exit 1; }
case "$URL" in
  wss://*|ws://*) ;;
  *) echo "--url 必须是 wss:// 或 ws:// —— 插件会静默丢弃其它协议（防误配 http）" >&2; exit 1 ;;
esac
[ -f "$CONF" ] || { echo "配置文件不存在：$CONF" >&2; exit 1; }
grep -qE '^- id: kite[[:space:]]*$' "$CONF" \
  || { echo "在 $CONF 里找不到 '- id: kite' 块" >&2; exit 1; }

[ -n "$PUB" ] || PUB="$(printf '%s' "$URL" | sed -e 's|^ws|http|' -e 's|/*$||')"

BAK="${CONF}.bak.$(date +%Y%m%d-%H%M%S)"
cp -p "$CONF" "$BAK"

awk -v q="'" -v url="$URL" -v pub="$PUB" -v tok="$TOKEN" '
  /^- id: kite[[:space:]]*$/      { inblk = 1; print; next }
  inblk && /^- /                           { inblk = 0 }
  inblk && /^[[:space:]]*relayUrl:/        { ind = $0; sub(/[^[:space:]].*$/, "", ind); print ind "relayUrl: " q url q; next }
  inblk && /^[[:space:]]*relayPublicUrl:/  { ind = $0; sub(/[^[:space:]].*$/, "", ind); print ind "relayPublicUrl: " q pub q; next }
  inblk && /^[[:space:]]*relayToken:/      { ind = $0; sub(/[^[:space:]].*$/, "", ind); print ind "relayToken: " q tok q; next }
  { print }
' "$BAK" > "$CONF"

if [ "$(wc -l < "$BAK")" != "$(wc -l < "$CONF")" ]; then
  cp -p "$BAK" "$CONF"
  echo "改写后行数变化，已从备份还原：$BAK" >&2
  exit 1
fi

echo "已更新 $CONF"
echo "  备份：$BAK"
echo
echo "--- 变更后 ---"
awk '/^- id: kite[[:space:]]*$/{f=1} f && /^- /&& !/kite/{f=0} f' "$CONF" | grep -E '^[- ]|relay' | head -8
echo
echo "★ 重启 DSH NEXT 后生效。重启会中断当前对话会话，这是正常的。"
