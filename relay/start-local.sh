#!/usr/bin/env bash
# 本机自测中继：绑定 127.0.0.1:8787（dev 模式无 TLS，仅回环可访问）。
# 令牌存放在 relay/.local-token（0600，首次自动生成）；插件配置必须使用同一令牌。
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
TOKEN_FILE="$DIR/.local-token"
if [[ ! -s "$TOKEN_FILE" ]]; then
  umask 077
  (openssl rand -hex 24 2>/dev/null || node -e "console.log(require('crypto').randomBytes(24).toString('hex'))") > "$TOKEN_FILE"
  echo "[ra-relay] 已生成接入令牌 → $TOKEN_FILE"
fi
TOKEN="$(cat "$TOKEN_FILE")"
echo "[ra-relay] RELAY_TOKENS=$TOKEN   （插件 relayToken 必须与此一致）"
# launchd 等非交互环境下 node 不在 PATH：优先用 nvm 的绝对路径。
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" && -x "$HOME/.nvm/versions/node/v22.23.2/bin/node" ]]; then
  NODE_BIN="$HOME/.nvm/versions/node/v22.23.2/bin/node"
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "[ra-relay] 找不到 node（请安装 Node 22+ 或调整 PATH）" >&2
  exit 1
fi
exec env HOST=127.0.0.1 PORT=8787 RELAY_TOKENS="$TOKEN" "$NODE_BIN" "$DIR/server.mjs"
