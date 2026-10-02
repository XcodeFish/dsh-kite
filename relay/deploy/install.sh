#!/usr/bin/env bash
# ============================================================================
# dsh-kite 中继安装脚本（在服务器上以 sudo 执行）
#
#   sudo ./install.sh               安装 / 更新（幂等，可反复执行）
#   sudo ./install.sh --uninstall   完整卸载，恢复到安装前状态
#   sudo ./install.sh --help        查看说明
#
# 三条设计原则：
#   1. 非侵入 —— 只往 ACLI 的官方扩展点 /etc/caddy/acli.d/sites/ 增加一个文件，
#      主 /etc/caddy/Caddyfile 一个字不改。
#   2. 可回滚 —— 任何一步失败（含证书获取失败）自动撤销本次全部改动。
#   3. 幂等  —— 重复执行不换令牌、不重建账号、不丢已有配置。
#
# 环境变量可覆盖：PUBLIC_IP / PUBLIC_PORT / RELAY_PORT
# ============================================================================
set -euo pipefail

# 公网 IP 不设默认值：部署环境信息不该硬编码进仓库，缺省时直接报错并给出用法。
PUBLIC_IP="${PUBLIC_IP:-}"
PUBLIC_PORT="${PUBLIC_PORT:-8443}"
RELAY_PORT="${RELAY_PORT:-8787}"
RELAY_USER="ra-relay"
RELAY_DIR="/opt/ra-relay"
ENV_DIR="/etc/ra-relay"
ENV_FILE="${ENV_DIR}/env"
TOKEN_FILE="${ENV_DIR}/relay-token.txt"
UNIT_FILE="/etc/systemd/system/ra-relay.service"
CADDY_SITE_DIR="/etc/caddy/acli.d/sites"
CADDY_SITE="${CADDY_SITE_DIR}/ra-relay.caddy"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE_BACKUP=""
CADDY_TOUCHED=0   # 只有动过 Caddy 才在回滚时重启它 —— 否则会白白中断其他 owner 的站点

C_CYAN=$'\033[1;36m'; C_RED=$'\033[1;31m'; C_GRN=$'\033[1;32m'; C_YEL=$'\033[1;33m'; C_OFF=$'\033[0m'
log()  { printf '%s[relay]%s %s\n' "$C_CYAN" "$C_OFF" "$*"; }
ok()   { printf '%s[relay]%s %s\n' "$C_GRN" "$C_OFF" "$*"; }
warn() { printf '%s[relay]%s %s\n' "$C_YEL" "$C_OFF" "$*" >&2; }
die()  { printf '%s[relay:失败]%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

port_in_use() { ss -lntH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${1}$"; }

wait_cmd() {
  local tries="$1" i; shift
  for ((i = 1; i <= tries; i++)); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

rollback() {
  warn "检测到失败，开始回滚本次改动……"
  if [ "$CADDY_TOUCHED" = "1" ]; then
    if [ -n "$SITE_BACKUP" ] && [ -f "$SITE_BACKUP" ]; then
      mv -f "$SITE_BACKUP" "$CADDY_SITE"
    else
      rm -f "$CADDY_SITE"
    fi
    systemctl restart caddy >/dev/null 2>&1 || true
  fi
  systemctl disable --now ra-relay >/dev/null 2>&1 || true
  warn "已回滚：Caddy 片段移除、ra-relay 停用。主 Caddyfile 从未被修改。"
}

do_uninstall() {
  log "卸载 dsh-kite 中继"
  systemctl disable --now ra-relay >/dev/null 2>&1 || true
  rm -f "$UNIT_FILE" "$CADDY_SITE"
  rm -f "${CADDY_SITE}".bak.* 2>/dev/null || true
  systemctl daemon-reload
  if caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    systemctl restart caddy
    log "Caddy 已恢复（仅移除片段）"
  else
    warn "移除片段后 Caddy 配置仍未通过校验 —— 请手工检查 /etc/caddy/Caddyfile"
  fi
  rm -rf "$RELAY_DIR"
  ok "中继已卸载。保留了 ${ENV_DIR}（令牌）；不需要就 rm -rf ${ENV_DIR}"
  log "运行账号 ${RELAY_USER} 保留未删；不需要的话 userdel ${RELAY_USER}"
  exit 0
}

case "${1:-}" in
  --uninstall|-u) do_uninstall ;;
  --help|-h) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
  "") ;;
  *) die "未知参数：$1（用 --help 查看用法）" ;;
esac

[ "$(id -u)" = "0" ] || die "需要 root：sudo $0 ${1:-}"
[ -n "$PUBLIC_IP" ] || die "缺少 PUBLIC_IP 环境变量（服务器公网 IP，用于 Caddy 站点与 IP 证书验证）：sudo PUBLIC_IP=<公网IP> $0 ${1:-}"

# ---------------------------------------------------------------- 预检
log "预检"
[ "$(uname -s)" = "Linux" ] || die "这是服务器端脚本，只能在 Linux 上运行（当前 $(uname -s)）—— Mac 侧请用 build-bundle.sh / switch-relay.sh"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "未找到 node —— 中继需要 Node ^22.19.0 或 >=24"
NODE_VER="$("$NODE_BIN" -v)"
NODE_MAJ="${NODE_VER#v}"; NODE_MAJ="${NODE_MAJ%%.*}"
NODE_MIN="${NODE_VER#v${NODE_MAJ}.}"; NODE_MIN="${NODE_MIN%%.*}"
if [ "$NODE_MAJ" = "22" ]; then
  [ "$NODE_MIN" -ge 19 ] || die "node $NODE_VER 过低：需要 ^22.19.0 或 >=24"
elif [ "$NODE_MAJ" -lt 24 ]; then
  die "node $NODE_VER 不受支持：需要 ^22.19.0 或 >=24"
fi
log "    node $NODE_VER  @ $NODE_BIN"

command -v caddy >/dev/null || die "未找到 caddy"
log "    $(caddy version | head -1)"
[ -f /etc/caddy/Caddyfile ] || die "未找到 /etc/caddy/Caddyfile"
[ -d "$CADDY_SITE_DIR" ] || die "未找到 $CADDY_SITE_DIR —— 这台机器上的 Caddy 不是 ACLI 托管的？"
[ -f "$SRC_DIR/server.mjs" ] || die "部署包不完整：缺少 server.mjs"
[ -d "$SRC_DIR/node_modules/ws" ] || die "部署包不完整：缺少 node_modules/ws（请用 build-bundle.sh 打包）"

if port_in_use "$RELAY_PORT" && [ ! -f "$UNIT_FILE" ]; then
  die "端口 $RELAY_PORT 已被占用，且不是本中继 —— 请用 RELAY_PORT=其他端口 重跑"
fi
if port_in_use "$PUBLIC_PORT" && [ ! -f "$CADDY_SITE" ]; then
  die "端口 $PUBLIC_PORT 已被占用，且不是本中继 —— 请用 PUBLIC_PORT=其他端口 重跑"
fi
log "    端口 $RELAY_PORT（本机回环）与 $PUBLIC_PORT（公网 HTTPS）可用"

# ---------------------------------------------------------------- 1. 账号
log "1/6 运行账号 $RELAY_USER"
if id -u "$RELAY_USER" >/dev/null 2>&1; then
  log "    已存在，跳过"
else
  useradd --system --no-create-home --shell /usr/sbin/nologin --user-group "$RELAY_USER"
  log "    已创建系统账号（无家目录、不可登录）"
fi

# ---------------------------------------------------------------- 2. 文件
log "2/6 安装中继文件到 $RELAY_DIR"
install -d -m 0755 "$RELAY_DIR"
install -m 0644 "$SRC_DIR/server.mjs" "$RELAY_DIR/server.mjs"
install -m 0644 "$SRC_DIR/package.json" "$RELAY_DIR/package.json"
install -m 0644 "$SRC_DIR/ra-relay.caddy.tpl" "$RELAY_DIR/ra-relay.caddy.tpl"
install -m 0644 "$SRC_DIR/ra-relay.service.tpl" "$RELAY_DIR/ra-relay.service.tpl"
rm -rf "$RELAY_DIR/node_modules"
cp -R "$SRC_DIR/node_modules" "$RELAY_DIR/node_modules"
chown -R root:root "$RELAY_DIR"
log "    server.mjs + ws@$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$RELAY_DIR/node_modules/ws/package.json" | head -1)（离线依赖，服务器侧无需 npm install）"

# ---------------------------------------------------------------- 3. 令牌
log "3/6 中继令牌"
install -d -m 0750 "$ENV_DIR"
if [ -s "$TOKEN_FILE" ]; then
  TOKEN="$(tr -d ' \t\r\n' < "$TOKEN_FILE")"
  log "    复用已有令牌（不会让已配对设备失效）"
else
  TOKEN="$(openssl rand -hex 24)"
  printf '%s\n' "$TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  log "    已生成新令牌"
fi
# ★ 令牌为空必须中止安装（2026-10-02 审查）：上面的 `[ -s "$TOKEN_FILE" ]` 只看
#   文件大小，一个只含空白/换行的旧令牌文件会走到这里留下空 TOKEN，然后写出
#   `RELAY_TOKENS=` 的 env —— 中继侧 fail-closed 会拒绝启动，白白经历一次
#   「装完不可用 → 回滚」。这里提前判死，并保留下面的既有 rollback 流程。
if [ -z "${TOKEN//[[:space:]]/}" ]; then
  rollback
  die "中继令牌为空（${TOKEN_FILE} 存在但内容为空白，或 openssl 生成失败）—— 已回滚。删除该文件后重跑可生成新令牌：rm -f ${TOKEN_FILE}"
fi
umask 077
cat > "$ENV_FILE" <<EOF
# 由 dsh-kite relay/deploy/install.sh 生成
RELAY_TOKENS=${TOKEN}
PORT=${RELAY_PORT}
HOST=127.0.0.1
MAX_DEVICES=8
MAX_PHONE_PER_DEVICE=4
EOF
chmod 600 "$ENV_FILE"

# ---------------------------------------------------------------- 4. systemd
log "4/6 systemd 单元"
sed -e "s|@NODE@|${NODE_BIN}|g" \
    -e "s|@RELAY_DIR@|${RELAY_DIR}|g" \
    -e "s|@ENV_FILE@|${ENV_FILE}|g" \
    "$SRC_DIR/ra-relay.service.tpl" > "$UNIT_FILE"
chmod 0644 "$UNIT_FILE"
systemctl daemon-reload
systemctl enable ra-relay >/dev/null 2>&1
systemctl restart ra-relay

if ! wait_cmd 15 curl -fsS --max-time 5 "http://127.0.0.1:${RELAY_PORT}/healthz"; then
  journalctl -u ra-relay -n 30 --no-pager || true
  rollback
  die "中继未能在 127.0.0.1:${RELAY_PORT} 就绪"
fi
ok "    中继已就绪：http://127.0.0.1:${RELAY_PORT}/healthz"

# ---------------------------------------------------------------- 5. Caddy
log "5/6 Caddy 站点片段（ACLI 扩展点）"
if [ -f "$CADDY_SITE" ]; then
  SITE_BACKUP="${CADDY_SITE}.bak.$$"
  cp -a "$CADDY_SITE" "$SITE_BACKUP"
  log "    已备份现有片段"
fi
sed -e "s|@PUBLIC_IP@|${PUBLIC_IP}|g" \
    -e "s|@PUBLIC_PORT@|${PUBLIC_PORT}|g" \
    -e "s|@RELAY_PORT@|${RELAY_PORT}|g" \
    "$SRC_DIR/ra-relay.caddy.tpl" > "$CADDY_SITE"
# ★ 必须显式放开读权限：上面第 3 步设了 umask 077，否则文件是 0600 root，
#   以 caddy 用户运行的 Caddy 读不到这个片段，会发现不了站点。
chmod 0644 "$CADDY_SITE"
CADDY_TOUCHED=1

if ! caddy validate --config /etc/caddy/Caddyfile >/tmp/.ra-caddy-validate.log 2>&1; then
  tail -20 /tmp/.ra-caddy-validate.log
  rm -f /tmp/.ra-caddy-validate.log
  rollback
  die "Caddy 配置校验失败"
fi
rm -f /tmp/.ra-caddy-validate.log
log "    caddy validate 通过"

# 注意：主 Caddyfile 里是 admin off —— `caddy reload` 要连 admin API，在这里通常走不通，
# 所以先试 reload，失败再退到 restart（约 1 秒中断，其他 owner 的站点会短暂不可用）。
if ! systemctl reload caddy >/dev/null 2>&1; then
  log "    reload 不可用（admin off），改用 restart"
  systemctl restart caddy
fi
for ((i = 1; i <= 30; i++)); do systemctl is-active --quiet caddy && break; sleep 1; done
systemctl is-active --quiet caddy || { rollback; die "caddy 未能启动"; }

# ---------------------------------------------------------------- 6. 验证
log "6/6 验证链路（走回环，不依赖云防火墙）"

# ★ 这里刻意【不】用公网 IP 直连自检：
#   云厂商的公网 IP 是 NAT 的（不在网卡上），在机器上 curl 自己的公网 IP 会真的出网卡，
#   撞上控制台的云防火墙 → 包被丢弃 → 超时。
#   那条路径测的是云防火墙而不是我们装的东西，拿它判成败会造成误报回滚
#   （2026-10-01 真机事故：一次本来成功的安装被判失败并回滚）。
#   --connect-to 把 TCP 连接强制指到回环，Host 与证书校验仍用公网 IP，
#   验证的才是「Caddy 站点 + IP 证书 + 反代到中继」这条链路本身。
if ! wait_cmd 30 curl -fsS --max-time 5 --connect-to "${PUBLIC_IP}:${PUBLIC_PORT}:127.0.0.1:${PUBLIC_PORT}" \
      "https://${PUBLIC_IP}:${PUBLIC_PORT}/healthz"; then
  warn "--- caddy 最近日志 ---"
  journalctl -u caddy -n 40 --no-pager | tail -40 || true
  rollback
  die "https 回环验证未通过（Caddy 站点或 IP 证书有问题），已回滚"
fi
ok "    Caddy 站点 + IP 证书 + 反代链路正常"

# 外部可达性只作提示、不作成败判据 —— 云防火墙在控制台侧，脚本改不了也查不到。
if curl -fsS --max-time 8 -o /dev/null "https://${PUBLIC_IP}:${PUBLIC_PORT}/healthz" 2>/dev/null; then
  EXTERNAL_OK=1
  ok "    外网可达（云防火墙已放行 ${PUBLIC_PORT}）"
else
  EXTERNAL_OK=0
  warn "    外网暂不可达 —— 需要去云厂商控制台放行 TCP ${PUBLIC_PORT}（不影响本次安装）"
fi

if [ -n "$SITE_BACKUP" ]; then rm -f "$SITE_BACKUP"; fi

# ---------------------------------------------------------------- 汇总
cat <<EOF

$C_GRN============================================================
 安装完成
------------------------------------------------------------
 中继令牌          : ${TOKEN}
 本机中继（回环）  : http://127.0.0.1:${RELAY_PORT}
 公网 HTTPS 入口   : https://${PUBLIC_IP}:${PUBLIC_PORT}

 运行状态          : systemctl status ra-relay
 日志              : journalctl -u ra-relay -f
 Caddy 日志        : journalctl -u caddy -n 50
 卸载              : sudo $SRC_DIR/install.sh --uninstall
============================================================$C_OFF

EOF

if [ "$EXTERNAL_OK" = "0" ]; then
cat <<EOF
$C_YEL 还差一步：云厂商控制台 → 这台实例的【防火墙 / 安全组】→ 放行 TCP ${PUBLIC_PORT}。$C_OFF
 云防火墙在控制台侧，脚本改不了也查不到；未放行时外部连接会被【丢包】（表现为超时，
 不是拒绝）。放行后从任意外网机器验证：
   curl -sS -o /dev/null -w '%{http_code}\\n' https://${PUBLIC_IP}:${PUBLIC_PORT}/healthz   # 期望 200

EOF
else
  echo " 云防火墙已放行 ${PUBLIC_PORT}，外网可达。"
  echo
fi

cat <<EOF
 Mac 侧接着跑：relay/deploy/switch-relay.sh \\
   --url wss://${PUBLIC_IP}:${PUBLIC_PORT} \\
   --public https://${PUBLIC_IP}:${PUBLIC_PORT} \\
   --token ${TOKEN}

EOF
