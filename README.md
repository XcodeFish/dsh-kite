# dsh-kite — DSH 手机远程访问插件

> **本项目原名 `dsh-remote-access`，2026-10 起更名 dsh-kite**（"风筝"：本机握线轴，连接器把线放到中继，手机在另一端握住；线只能放出去不能收进来 —— 即纯出站架构）。历史文档中的旧名均指本项目。
>
> ⚠️ 更名影响面：管理面板路由 `/remote-access` → `/kite`；数据目录 `plugin-data/dsh-remote-access` → `plugin-data/dsh-kite`（首次启动自动整体迁移，已配对设备与密钥原样保留）；env 覆盖变量改为 `DSH_KITE_RELAY_URL` / `DSH_KITE_RELAY_TOKEN`；profile patch 的 `- id: remote-access` 需改为 `- id: kite`。**手机配对链接与中继 reserved 路径同步改为 `/kite/pair`、`/kite/welcome` —— 需重新部署中继（`relay/deploy/`）后配对才可用**。

让手机在**任意网络**（4G/5G、异地 WiFi）下连接并操作 DSH。**纯出站架构**：本机不开任何入站端口、不依赖 DSH Desktop、不依赖第三方隧道服务。

对应技术方案：`DSH-手机远程访问插件-完整方案-2026-09-30.md`（下称「方案」）。本实现覆盖方案 §8 的插件结构全量 + §9 中继 + §14.1 契约测试；与方案的三处有意偏差见 §8。

---

## 0. 一图看懂

```text
手机 PWA ──WSS/HTTPS──► 公网中继（自建，只转发）◄──出站 WSS── 本机插件 Connector（DSH 宿主进程内）
                                                                        │ 仅回环
                                                                        ▼
                                                          Host WebServer 127.0.0.1:<随机端口>
                                                   （请求由 Connector 重建：Host=127.0.0.1:port + 注入 loopback cookie）
```

- 本机**零入站监听**（`lsof -iTCP -sTCP:LISTEN` 不新增公网监听）；Connector 是出站发起方，天然穿透 NAT。
- 手机永远拿不到启动令牌：令牌只在 Connector 内存里出现一次（换 cookie），不落盘、不出机。
- DSH 全部 API 面（PWA / 终端 / 文件 / 审批 / `$events`）零翻译复用 —— Connector 是通用反向代理。

## 1. 硬性前置条件（不满足 = 全部 403）

**DSH NEXT 设置里必须开启「浏览器访问」（Browser Access）。**

原因（已在 0.1.7-rc.2 源码核实）：桌面外壳用 `dsh-desktop-next/webserver` 替换了上游 webserver，给**每一条路由**（含插件注册的路由与回环自访问）套 browser-access 门：请求带不上 Electron 渲染器头 `x-dsh-desktop-renderer` 时，`browserAccess=false`（默认）一律 403 `Browser access is disabled`。开启后，普通浏览器/本进程 fetch 归类为「browser」放行，宿主认证（cookie）仍然生效。这只影响回环语义，不开任何端口。

## 2. 安装（本机）

```bash
# 1) 源码即安装目录（link: 直连，改代码无需拷贝；相对路径会被 parseInstallSpec 拒绝）
#    本仓库位置：~/.dsh/plugin-src/dsh-kite

# 2) 在 desktop profile 声明依赖（照 dsh-session-messenger 的先例）
#    ~/.dsh/profiles/desktop/package.json 的 dependencies 增加一行：
#      "dsh-kite": "link:/Users/<you>/.dsh/plugin-src/dsh-kite"
#    然后重启 DSH NEXT（代码变更必须重启才生效）。

# 3) 验证：DSH 起来后，从「设置 → 在浏览器打开」进入 Web GUI（拿宿主 cookie），
#    访问 http://127.0.0.1:<web端口>/kite —— 应看到管理面板。
```

Node 版本：`^22.19.0 || >=24.0.0`（用全局 `WebSocket`，插件零外部依赖）。

## 3. 配置（cordis.patch.yml）

插件自带默认配置（见 `cordis.patch.yml`），可在 profile 的 patch 层按 id 覆盖：

```yaml
- id: kite
  config:
    relayUrl: 'wss://relay.example.com'   # 出站中继；空 = 待机（仅本地面板可用）
    relayToken: '<与中继 RELAY_TOKENS 匹配>'
    remoteAgentPreset: 'default'           # 远程 session/create 注入的 agent preset
    allowedAgentPresets: ['default']       # 远程可指定的白名单（之外 403）
    allowTerminal: false                   # 远程终端写类方法（create/write/resize/rename/close/environment）
    allowUpload: false                     # 远程 /api/session/uploadFileBinary
    pairingTtlSeconds: 120                 # 配对令牌有效期
    ticketTtlHours: 12                     # 设备票据有效期
```

env 覆盖（调试用，优先于 patch）：`DSH_KITE_RELAY_URL` / `DSH_KITE_RELAY_TOKEN`。

数据目录：`$DSH_HOME/plugin-data/dsh-kite/<profile>/`（宿主进程没有 `DSH_PROFILE`，实际落 `default/`；密钥/设备表/审计/kill switch 都在这里，密钥与设备表 0600）。更名前（v0.1 时代）的 `dsh-remote-access` 目录会在首次启动时**整体自动迁移**过来，已配对手机无需重新扫码。

## 4. 中继部署（公网 VPS）

```bash
# 任一有 Node 22 的 VPS（建议香港/新加坡，方案 §9.3）
scp -r relay/ you@vps:/opt/ra-relay && ssh you@vps
cd /opt/ra-relay && npm install --omit=dev

# 生成令牌与证书（TLS 必配；或前置 caddy/nginx 终结 TLS）
export RELAY_TOKENS="$(openssl rand -hex 24)"
export TLS_KEY=/etc/letsencrypt/live/relay.example.com/privkey.pem
export TLS_CERT=/etc/letsencrypt/live/relay.example.com/fullchain.pem
export PORT=443
node server.mjs   # 建议配 systemd（Restart=always）
```

| 端点 | 用途 |
|---|---|
| `WSS /connector?c=<connectorId>` | Connector 出站接入（子协议 `ra-bearer.<token>` 鉴权） |
| `WSS /device` / 其它任意路径 | 手机：`/device` 为 thin-client 信令；其余路径 HTTP/WS 全桥接到 Connector |
| `GET /healthz` `/metrics` | 健康检查 / Prometheus 指标 |

中继职责边界（严格，方案 §9.1）：只配对转发 + 限流（单 IP 60/min、设备连接上限、1 MiB 帧上限、8 MiB 请求体上限、30s 响应看门狗）。不持有设备公钥、不解密、不持久化、不做信任判断 —— **中继是可用性组件，不是安全组件**。

## 5. 使用流程

**入口**：重启后 DSH Web GUI 右下角会出现「手机远程」悬浮按钮（`webserver/index-inject` 注入，与官方 client-ui 插件同通道；`menuEntry: false` 可关）。点击进入 `/kite` 面板；没有入口时也可从「设置 → 在浏览器打开」进入后手动访问 `http://127.0.0.1:<web端口>/kite`。

1. 面板「生成配对二维码」→ 显示**二维码 + 一次性链接**（2 分钟有效，用后即焚）。
2. **手机相机/浏览器扫码**打开配对页 → 手机本地生成 Ed25519 密钥（WebCrypto，私钥不可导出，存 IndexedDB）→ 挑战-应答完成配对 → 手机显示 **6 位校验码**。
3. **核对校验码**：手机与面板显示一致才点「确认并进入 DSH」（用户成为信任根，防中继作恶抢配 —— 方案 §6.2）。
4. 之后手机访问中继域名即得完整 PWA；设备票据 12h，过期后凭 IndexedDB 私钥免扫码重连（挑战-应答）。
5. 撤销：面板单台撤销/全部撤销，即时生效并断开在线连接；**紧急停用（kill switch）** 立即断开中继并停止重连（持久化，重启 DSH 后仍生效，面板可恢复）。

### 手机怎么访问（三条路径，按场景选）

| 路径 | 适用 | 说明 |
|---|---|---|
| **VPS 中继（生产路径）** | 任意网络 4G/5G | 按 §4 部署 `relay/` 到公网 VPS（域名 + TLS），把 `relayUrl`/`relayToken` 填入插件配置并重启 DSH。这是方案的正解路径 |
| **Tailscale serve** | 无 VPS、有 tailnet | 本地跑 relay，`tailscale serve https / http://127.0.0.1:8787`，手机访问 `https://<设备名>.<tailnet>.ts.net`（真证书 HTTPS）；`relayUrl` 填 `ws://127.0.0.1:8787` |
| **本机自测** | 先在 Mac 上走通全流程 | 本地跑 `node relay/server.mjs`，`relayUrl` 填 `ws://127.0.0.1:8787`，在 Mac 浏览器打开配对链接（localhost 是安全上下文，WebCrypto 可用） |

> 为什么手机必须走 HTTPS：配对页要用 WebCrypto 生成设备密钥（安全上下文限定），设备 cookie 带 `Secure` —— 纯 `http://<局域网IP>` 打开配对页会被浏览器拒绝。所以「手机连局域网 IP」不可行，必须三者之一：VPS TLS / Tailscale / 本机 localhost 自测。`relayUrl` 为 `ws://`（本地联调）时设备 cookie 自动不带 `Secure` 属性。

审批与提问（R5/R7）：`approval/request` 与 `user-questions/request` 已由宿主 `dsh-api-remotes` 转发到**所有已连接客户端** —— 手机 PWA 经代理同样收到审批卡片，首个应答生效；本插件旁听审计每次审批（`approvals/responders.js`，绝不抢答）。

## 6. 权限收敛（方案 §7 落地）

| 层 | 行为 |
|---|---|
| 会话预设 | 远程 `session/create` 强制注入 `remoteAgentPreset`；显式要求白名单外 preset 一律 403（已核实 0.1.7-rc.2 的字段名是 `agentPreset`，未知 id 宿主天然报 `agent-preset/not-found`，fail closed） |
| 危险方法 | 终端写类 / 上传 / plugin 写操作 / 社区市场 / HMR `/plugins/events`：默认 403 + 审计 + 可读原因 |
| 请求重建 | 只复制白名单头（cookie + content-type），`Origin`/`Sec-Fetch-*`/`X-Forwarded-*`/伪造渲染器头全部丢弃；宿主 `Set-Cookie` 永不回给手机 |
| 未知终端方法 | 默认拒绝（白名单外不放行） |

**已知边界（诚实清单）**：`/api/remote.mux` 内部的 RPC 词汇（终端、会话 prompt 等）是 DSH 自己的语义协议，承载层无法逐帧过滤；收敛依赖 ① session/create 预设锁定 ② 宿主审批 ask 策略 ③ 审计。**权限预设（sandbox 档位）是会话内用户可切的另一条轴** —— 提权动作会走审批 ask；若要更硬的保证，把 profile 的 `permission.defaultPreset` 配成 `workspace-write` 及以下再开远程。

## 7. 安全边界与残余风险

- **信任链**：手机私钥（不可导出）→ 设备公钥 ACL（Connector 本地 0600）→ 一次性配对 token（120s、用后即焚、timingSafeEqual）→ 6 位校验码（SHA256(devPub‖connPub)，防中继抢配）→ 挑战-应答票据（12h、nonce LRU 1024、±60s 时间窗、counter 单调）。
- **PWA 模式的 TLS 终结点在中继**（浏览器只认域名证书，E2E 不适用于未改造的 PWA —— 见 §8 偏差 ②）。thin-client sealed 模式（X25519+HKDF+AEAD，中继只见密文）的加密原语与帧已就绪（`transport/e2e.js` + `sealed` 帧），thin client 应用本身在 M2。
- 配对链接泄露窗口 = 120s 且单次有效；**真正的长期凭据是设备私钥**（在中联手机里），不是 URL。
- 残余风险与方案 §11.3 一致：Connector 持全权 loopback cookie（单一信任点，靠小代码量 + 审计 + host-adapter 收口）；中继域名被劫持时 PWA 模式退化为「对中继的 TLS 信任」；手机丢失 → 面板一键撤销（票据最长再活 12h，但撤销即断连且拒新握手）。
- P0：kill switch（面板/`killswitch.json`）→ 撤销全部设备 → 关中继。

## 8. 与方案的有意偏差（ADR 补记）

1. **AEAD 用 AES-256-GCM 而非 ChaCha20-Poly1305**（§3.3/5.3）：浏览器 WebCrypto 无 ChaCha20，thin client 需零依赖加解密；同为 256-bit AEAD，安全等级一致。已同步：HKDF 只导出 k_enc（AEAD 自带完整性），counter+方向进 AAD。
2. **PWA 模式下 E2E 不生效**：方案 §10.1 的 M0 客户端是未改造的上游 PWA，物理上无法实现 sealed 帧；该模式下中继 TLS 即边界（§3.1 的「中继只见密文」在 sealed 模式兑现）。这不是放弃 ADR-003，是分模式兑现。
3. **审批不注册应答者**：方案 §7.3 假设插件要答 waterfall；实测发现 `dsh-api-remotes` 已把 `approval/request`、`user-questions/request` 转发给全部远程客户端，插件抢答会制造双确认歧义。落地方案：旁听审计 + 依赖 PWA 应答（R7 验收「手机完成一次审批」由 PWA 达成）。
4. **Bearer 令牌走子协议而非 headers**：方案 §8.3(c) 的 `new WebSocket(url, {headers})` 是 `ws` 包的 API，Node 全局 WebSocket 不支持自定义头；令牌经 `Sec-WebSocket-Protocol: ra-bearer.<token>`（非法字符退化 URL 参数），不落 URL 日志。

## 9. 测试与探针

```bash
npm test          # 81 项契约测试（帧/E2E/票据/设备存储/配对/策略/凭据/重建/ws-codec/审计/中继集成）
npm run probe     # 离线宿主契约断言（DSH 升级后先跑这个 —— 风险 R-05）
```

在宿主内的三假设探针（方案 §8.5 A1–A3）：管理面板 → 「运行探针」，期望 `overall:"ok"`：

- `webServer.port`：无 cookie `GET /` 得 401/303（服务在、认证门在）；
- `credential.exchange`：`authenticatedUrl` → 303 → `dsh-auth-*` cookie；
- `api.forward`：真实 RPC `POST /api/session/list` 非 403（重建请求过 `isTrustedApiRequest`）。

任何 failed → 方案 R-01：先查「浏览器访问」是否开启（最常见的 403 来源），再回 §3 重新选型。

## 10. 排障

| 症状 | 处置 |
|---|---|
| 面板/代理全部 403 `Browser access is disabled` | 开「浏览器访问」（§1）；探针第一项会显示 |
| 探针 `credential.exchange` 失败 | connection 服务缺失或令牌已被消费；重启 DSH 再试 |
| 手机 503「中继未就绪」 | connector 不在线：看面板 relay 状态（killed/standby/retrying + lastError）；核对 relayUrl/relayToken |
| 改了代码没生效 | 重启 DSH（宿主只在启动时加载插件模块） |
| DSH 启动受影响 | 先禁用本插件（profile package.json 移除依赖）再反馈；装载纪律见 `index.js` 头注释（可选注入 + 定时器不触 ctx 属性） |

## 11. 目录

```text
index.js              Cordis 入口（inject 纪律 / 装配 / 探针实现）
host-adapter.js       宿主接触面唯一收口
transport/            出站 WSS + 承载帧（exactKeys）+ E2E 原语
identity/             连接器密钥 / 设备 ACL / 配对 / 票据
policy/               方法黑名单 / 会话预设锁定 / 审计
proxy/                loopback 凭据 / 反向代理 / WS 桥（RFC6455 最小编解码）
approvals/            审批旁听审计
admin/                管理面板 + 手机配对页 + kill switch
relay/                独立中继（唯一允许依赖的组件：ws）
test/                 契约测试 + 离线宿主探针
```
