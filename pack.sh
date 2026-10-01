#!/usr/bin/env bash
# ============================================================================
# dsh-kite 完整打包
#
#   ./pack.sh              打包（不跑测试）
#   ./pack.sh --verify     先跑门禁与单测，绿了才打包
#
# 产出两个互相独立的包：
#   ① dsh-kite-<日期>-<rev>.tar.gz  完整插件源码（本机安装/归档/换机）
#   ② ra-relay-<日期>-<rev>.tar.gz           中继部署包（服务器用，自带 ws 依赖）
#
# 安全口径：文件清单来自 `git ls-files --cached --others --exclude-standard` ——
# 它自动挡掉 .gitignore 里的一切（node_modules、relay/bin 的 38MB cloudflared、
# relay/.local-token 本机令牌、relay/deploy/dist）。打包前还会扫一遍凭据特征。
# ============================================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd)"
OUT="$ROOT/dist"
RUN_VERIFY=0
[ "${1:-}" = "--verify" ] && RUN_VERIFY=1

if [ "$RUN_VERIFY" = "1" ]; then
  echo "== 门禁 + 单测 =="
  npm run verify
fi

STAMP="$(date +%Y%m%d)"
REV="$(git rev-parse --short HEAD 2>/dev/null || echo 'nogit')"
DIRTY="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
BASE="dsh-kite-${STAMP}-${REV}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$OUT"

# ---- 文件清单（git 口径，自动排除被 ignore 的一切）----
# 用 -z + xargs -0：文件名含空格也安全；且不依赖 bash 4 的 mapfile
# （macOS 自带 bash 3.2，第一次写就踩了这个）。
git ls-files --cached --others --exclude-standard -z > "$STAGE/.filelist"
FILE_COUNT="$(tr -dc '\0' < "$STAGE/.filelist" | wc -c | tr -d ' ')"
[ "$FILE_COUNT" -gt 0 ] || { echo "文件清单为空，中止" >&2; exit 1; }

# ---- 防线：产物绝不能进包 ----
# 根 dist/ 若未被 gitignore，`git ls-files --others` 会把上一次的 tar.gz 收进来，
# 于是包里有包，再跑一次包里有「含包的包」—— 体积指数增长且极难察觉。
# 第一次写就踩了（160K → 392K）。这里显式拦死。
STRAY="$(tr '\0' '\n' < "$STAGE/.filelist" | grep '\.tar\.gz$' || true)"
if [ -n "$STRAY" ]; then
  echo "★ 文件清单里出现打包产物，已中止（多半是 dist/ 没被 gitignore）：" >&2
  echo "$STRAY" >&2
  exit 1
fi

# ---- 凭据扫描：任何疑似密钥/令牌一律拦下 ----
echo "== 凭据扫描（$FILE_COUNT 个文件）=="
PATTERN="(BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|relayToken:[^A-Za-z0-9]*[0-9a-f]{32,}|RELAY_TOKENS=[0-9a-f]{16,})"
HITS="$(xargs -0 grep -InE "$PATTERN" < "$STAGE/.filelist" 2>/dev/null || true)"
if [ -n "$HITS" ]; then
  echo "★ 发现疑似凭据，已中止打包：" >&2
  echo "$HITS" >&2
  exit 1
fi
echo "  未发现凭据 ✓（预期：relayToken 在本仓库是空串，真实令牌只存在于 profile 与服务器）"

# ---- ① 完整源码包 ----
mkdir -p "$STAGE/$BASE"
tar -cf - --null -T "$STAGE/.filelist" | tar -xf - -C "$STAGE/$BASE"
{
  echo "# $BASE"
  echo
  echo "- 打包时间: $(date -Iseconds)"
  echo "- git rev : $REV（工作区改动 $DIRTY 项）"
  echo "- 版本号  : $(node -p "require('./package.json').version" 2>/dev/null || echo unknown)"
  echo
  echo "## 本包内容"
  echo
  echo '```'
  (cd "$STAGE/$BASE" && find . -type f | sort | sed 's|^\./||')
  echo '```'
  echo
  echo "## 安装（见 DEPLOY.md §1）"
  echo
  echo '```bash'
  echo "DSH_HOME=\"\$HOME/.dsh\" node \\"
  echo "  '/Applications/DSH NEXT.app/Contents/Resources/app/lib/plugin-cli.js' \\"
  echo "  desktop add \"link:<本包解压后的绝对路径>\""
  echo "# 然后重启 DSH NEXT"
  echo '```'
} > "$STAGE/$BASE/MANIFEST.md"
tar --no-xattrs -czf "$OUT/${BASE}.tar.gz" -C "$STAGE" "$BASE"

# ---- ② 中继部署包 ----
if [ -x "$ROOT/relay/deploy/build-bundle.sh" ]; then
  (cd "$ROOT/relay/deploy" && ./build-bundle.sh >/dev/null)
  cp "$ROOT/relay/deploy/dist/ra-relay.tar.gz" "$OUT/ra-relay-${STAMP}-${REV}.tar.gz"
fi

# ---- 汇总 ----
echo
echo "== 产出 =="
for f in "$OUT"/*.tar.gz; do
  printf '  %-46s %8s\n' "$(basename "$f")" "$(du -h "$f" | cut -f1)"
done
echo
echo "源码包文件数: $FILE_COUNT   工作区未提交改动: ${DIRTY} 项"
echo "解包与内容清单见包内 MANIFEST.md"
