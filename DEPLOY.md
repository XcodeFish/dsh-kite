# dsh-kite 部署说明（v0.2.0）

> 本包**不含第三方依赖**（node_modules / 二进制均未打包）。按下面步骤补齐即可运行。

## 0. 前置条件

| 项 | 要求 |
|---|---|
| Node | `^22.19.0 \|\| >=24.0.0`（用到全局 `WebSocket`、`node:zlib`） |
| DSH | 桌面版 NEXT，且**设置里开启「浏览器访问」**（否则回环请求被 403） |
| 本机入站 | **不需要**开任何端口（纯出站架构） |

## 1. 安装插件（本机）

```bash
# 把本包放到插件源目录（或任意绝对路径）
mkdir -p ~/.dsh/plugin-src && cp -R dsh-kite ~/.dsh/plugin-src/

# 用官方 CLI 装进 desktop profile（link: 必须绝对路径）
DSH_HOME="$HOME/.dsh" node \
  "/Applications/DSH NEXT.app/Contents/Resources/app/lib/plugin-cli.js" \
  desktop add "link:$HOME/.dsh/plugin-src/dsh-kite"

# 重启 DSH NEXT（代码变更必须重启才加载）
```

插件自带默认配置（`cordis.patch.yml`），要改 relay 地址请在 **profile patch 层**覆盖：

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml 追加
- id: kite
  config:
    relayUrl: 'wss://你的中继域名'
    relayToken: '<与中继 RELAY_TOKENS 一致>'
    relayPublicUrl: 'https://你的中继域名'
```

## 2. 运行中继（二选一）

### 2a. 本地自测（最快，仅本机/局域网）

```bash
cd relay && npm install --omit=dev     # 唯一依赖：ws
./start-local.sh                       # 监听 127.0.0.1:8787，令牌写入 relay/.local-token
```

然后 `relayUrl: 'ws://127.0.0.1:8787'`、`relayToken` 取 `.local-token` 内容。

> 手机需要**公网可达的 HTTPS**入口，本地中继需配合隧道（见 2c）。

### 2b. VPS 部署（正式路径，推荐）

```bash
# VPS 上
scp -r relay/ user@vps:/opt/ra-relay && ssh user@vps
cd /opt/ra-relay && npm install --omit=dev
export RELAY_TOKENS="$(openssl rand -hex 24)"      # 记下来，填进插件配置
export TLS_KEY=/etc/letsencrypt/live/域名/privkey.pem
export TLS_CERT=/etc/letsencrypt/live/域名/fullchain.pem
export PORT=443
node server.mjs        # 建议配 systemd（Restart=always）
```

### 2c. 临时隧道（验证用，不适合日常）

```bash
# 下载 cloudflared（本包未含，约 15MB）
curl -L -o relay/bin/cloudflared.tgz \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz
cd relay/bin && tar xzf cloudflared.tgz && chmod +x cloudflared
./cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate
# 输出里的 https://xxx.trycloudflare.com 填进 relayPublicUrl
```

> **注意**：免费快速隧道带宽约 400KB/s、每次重启换域名，DSH 首屏约 20MB
> → 首屏需 20–40 秒。**日常使用请走 2b 的 VPS**。

## 3. 配对手机

1. 桌面 DSH 点右下角「**手机远程**」→ 生成配对二维码
2. 手机扫码 → 页面显示 **6 位校验码**
3. 核对桌面面板与手机**校验码一致** → 点「确认并进入 DSH」

## 4. 自检与维护

```bash
./sync.sh              # 一键：重启中继 + 版本一致性检查 + 跑单测
npm run verify         # 全套 9 层验证（单测 + 端到端 + 浏览器行为 + WS 心跳）
```

数据目录：`$DSH_HOME/plugin-data/dsh-kite/<profile>/`
（`connector-*.json` 连接器密钥、`devices.json` 设备 ACL、`audit.jsonl` 审计、`killswitch.json` 紧急停用）

## 5. 安全要点

- **本机零入站端口**：所有连接由本机主动发起（出站 WSS）
- **令牌不出机**：loopback 凭据只存内存；手机只持有自己的设备私钥（不可导出）
- **6 位校验码**：防止中继作恶抢配（用户是信任根）
- **权限收敛**：远程 `session/create` 强制注入预设；终端写类/上传/插件写默认拒绝
- **紧急停用**：面板「kill switch」立即断开中继并停止重连（持久化）
