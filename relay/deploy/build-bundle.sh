#!/usr/bin/env bash
# ============================================================================
# Mac 侧：打包中继部署包
#
# 把 ws 依赖（零运行时依赖，196K）一起打进包里 —— 服务器侧因此**不需要**
# npm install，也就不依赖服务器能访问 npm registry（境内机器上这常常是最先翻车的一步）。
# ============================================================================
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
relay_dir="$(cd "$here/.." && pwd)"
out_dir="$here/dist"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

[ -f "$relay_dir/server.mjs" ] || { echo "缺少 $relay_dir/server.mjs" >&2; exit 1; }
if [ ! -d "$relay_dir/node_modules/ws" ]; then
  echo "缺少 $relay_dir/node_modules/ws" >&2
  echo "先在 Mac 上执行：(cd $relay_dir && npm install --omit=dev)" >&2
  exit 1
fi
[ -f "$here/README.md" ] || { echo "缺少 $here/README.md" >&2; exit 1; }

mkdir -p "$out_dir" "$stage/ra-relay"
install -m 0644 "$relay_dir/server.mjs" "$relay_dir/package.json" "$stage/ra-relay/"
cp -R "$relay_dir/node_modules" "$stage/ra-relay/node_modules"
rm -f "$stage/ra-relay/node_modules/.package-lock.json"
install -m 0755 "$here/install.sh" "$stage/ra-relay/install.sh"
install -m 0644 "$here/ra-relay.caddy.tpl" "$here/ra-relay.service.tpl" "$here/README.md" "$stage/ra-relay/"

# --no-xattrs：不带 macOS 的 com.apple.provenance 扩展属性，
# 否则 Linux 侧解包会刷几十行 "Ignoring unknown extended header keyword" 噪音。
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$out_dir/ra-relay.tar.gz" -C "$stage" ra-relay

echo "打包完成：$out_dir/ra-relay.tar.gz"
ls -lh "$out_dir/ra-relay.tar.gz"
# ★ 打出可核对的指纹：server.mjs 决定服务器行为，tarball 还要受 README/install.sh 影响。
#   没有这两个数，就无法判断「VPS 上跑的到底是哪一版」—— 2026-10-02 真机事故：
#   修复提交在仓库里，但上传的是**另一个克隆**里 21:28 的旧包，行为毫无变化却以为已修复。
echo "  server.mjs sha256 : $(shasum -a 256 "$relay_dir/server.mjs" | cut -d' ' -f1)"
echo "  tarball    sha256 : $(shasum -a 256 "$out_dir/ra-relay.tar.gz" | cut -d' ' -f1)"
echo
echo "下一步（两条命令）："
echo "  scp $out_dir/ra-relay.tar.gz user@<VPS_IP>:/tmp/"
echo "  ssh user@<VPS_IP> 'tar xzf /tmp/ra-relay.tar.gz -C /tmp && sudo PUBLIC_IP=<VPS_IP> /tmp/ra-relay/install.sh'"
echo
echo "★ 注意：dist/ 不入库，每个克隆各打各的包。上传前先确认你 scp 的就是刚打出来的这一个："
echo "    shasum -a 256 $out_dir/ra-relay.tar.gz"
