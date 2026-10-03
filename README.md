# dsh-kite — DSH 手机远程访问插件

让手机在**任意网络**（4G/5G、异地 WiFi）下连接并操作 DSH。**纯出站架构**：本机不开任何入站端口、不依赖第三方隧道服务。

> 原名 `dsh-remote-access`，2026-10 起更名 dsh-kite（历史文档中的旧名均指本项目）。

## 原理

```text
手机 PWA ──WSS/HTTPS──► 公网中继（自建，只转发）◄──出站 WSS── 本机插件 Connector（DSH 宿主进程内）
                                                                        │ 仅回环
                                                                        ▼
                                                          Host WebServer 127.0.0.1:<随机端口>
```

- 本机零入站监听，Connector 出站接入中继，天然穿透 NAT。
- DSH 全部 API 面（PWA / 终端 / 文件 / 审批）零翻译复用 —— Connector 是通用反向代理。
- 手机私钥在手机本地生成（WebCrypto，不可导出）；配对令牌一次性、120 秒过期。

## 前置条件

DSH 设置里必须开启「**浏览器访问**」（Browser Access），否则所有请求 403。

## 安装（本机）

```bash
git clone https://github.com/XcodeFish/dsh-kite.git ~/.dsh/plugin-src/dsh-kite
```

在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 增加：

```json
"dsh-kite": "link:$HOME/.dsh/plugin-src/dsh-kite"
```

重启 DSH（代码变更必须重启才生效），访问 `http://127.0.0.1:<web端口>/kite` 看到管理面板即成功。

Node 版本：`^22.19.0 || >=24.0.0`。插件本体零外部依赖；中继依赖 `ws`。

## 部署中继（公网 VPS）

```bash
# Mac：打包（ws 依赖一起打进包，服务器不需要 npm install）
cd ~/.dsh/plugin-src/dsh-kite/relay/deploy
./build-bundle.sh

# 上传并安装（幂等；失败自动回滚）
scp dist/ra-relay.tar.gz user@<VPS_IP>:/tmp/
ssh user@<VPS_IP> 'tar xzf /tmp/ra-relay.tar.gz -C /tmp && sudo PUBLIC_IP=<VPS_IP> /tmp/ra-relay/install.sh'

# Mac：把插件指向新中继（令牌来自安装脚本输出）
./switch-relay.sh --url wss://<VPS_IP>:8443 \
                  --public https://<VPS_IP>:8443 \
                  --token <令牌>
```

- `PUBLIC_IP` 必填；云防火墙放行 **TCP 8443**。
- `dist/` 不入库，每个克隆各自打包。
- 细节见 [relay/deploy/README.md](relay/deploy/README.md)。

## 使用流程

1. 打开 DSH Web GUI 左侧栏底部的「**手机远程**」条目 → `/kite` 面板。
2. 「生成配对二维码」→ 二维码 + 一次性链接（2 分钟有效，用后即焚）。
3. 手机扫码 → 自动生成密钥并完成配对 → 手机显示 **6 位校验码**。
4. 桌面核对校验码一致 → 点「确认并进入 DSH」。
5. 手机即得完整 PWA；设备票据 12 小时，过期后凭私钥免扫码重连。

中继地址/令牌可在面板「中继接入」区直接修改（测试连接 → 应用并重连），无需改文件、无需重启。

无 VPS 时的替代路径：

| 路径 | 适用 |
|---|---|
| Tailscale serve | 有 tailnet：本地跑 relay，`relayUrl` 填 `ws://127.0.0.1:8787` |
| 本机自测 | `node relay/server.mjs`（或 `relay/start-local.sh`），配对链接在 Mac 浏览器打开 |

## 配置

默认配置即可用，需要覆盖时在 profile patch 层：

```yaml
- id: kite
  config:
    relayUrl: 'wss://relay.example.com'   # 出站中继；空 = 待机
    relayToken: '<与中继 RELAY_TOKENS 匹配>'
    allowTerminal: false                   # 远程终端写类方法
    allowUpload: false                     # 远程上传
    pairingTtlSeconds: 120                 # 配对令牌有效期
    ticketTtlHours: 12                     # 设备票据有效期
```

优先级：env（`DSH_KITE_RELAY_URL` / `DSH_KITE_RELAY_TOKEN`）> 面板覆盖 > patch > 默认。

数据目录：`$DSH_HOME/plugin-data/dsh-kite/<profile>/`（密钥与设备表 0600）。

## 撤销与急停

- 撤销设备：面板单台/全部撤销，即时生效并断开在线连接。
- kill switch：立即断开中继并停止重连（持久化，重启 DSH 后仍生效）。

## 测试

```bash
npm test        # 单测
npm run verify  # 全链路验收（单测 + 面板 e2e + 配对 + 全链 e2e）
```

> 改了代码没生效 → 重启 DSH（宿主只在启动时加载插件模块）。
