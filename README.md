# dsh-kite — DSH 手机远程访问插件

> **本项目原名 `dsh-remote-access`，2026-10 起更名 dsh-kite**（"风筝"：本机握线轴，连接器把线放到中继，手机在另一端握住；线只能放出去不能收进来 —— 即纯出站架构）。历史文档中的旧名均指本项目。
>
> 更名影响面：管理面板路由 `/remote-access` → `/kite`；数据目录自动迁移（已配对设备与密钥原样保留）；env 覆盖变量改为 `DSH_KITE_RELAY_URL` / `DSH_KITE_RELAY_TOKEN`；手机配对链接为 `/kite/pair`。

让手机在**任意网络**（4G/5G、异地 WiFi）下连接并操作 DSH。**纯出站架构**：本机不开任何入站端口、不依赖 DSH Desktop、不依赖第三方隧道服务。

---

## 0. 一图看懂

```text
手机 PWA ──WSS/HTTPS──► 公网中继（自建，只转发）◄──出站 WSS── 本机插件 Connector（DSH 宿主进程内）
                                                                        │ 仅回环
                                                                        ▼
                                                          Host WebServer 127.0.0.1:<随机端口>
                                                   （请求由 Connector 重建：Host=127.0.0.1:port + 注入 loopback cookie）
```

- 本机**零入站监听**；Connector 是出站发起方，天然穿透 NAT。
- 手机永远拿不到启动令牌：令牌只在 Connector 内存里出现一次（换 cookie），不落盘、不出机。
- DSH 全部 API 面（PWA / 终端 / 文件 / 审批 / `$events`）零翻译复用 —— Connector 是通用反向代理。

**路由语义（真机事故沉淀，2026-10）**：手机侧请求分两类 —— 带 `?c=<connectorId>` 的导航请求由中继精确路由；浏览器随后加载的相对路径资源（`./assets/*`）与 WS（`/api/remote.mux`）**不带 c**，只能靠 `ra-device` cookie 查中继设备路由表。这条表由连接器上报（连接建立时 + **每次配对成功后立即**），中继只做查询。任何一环漏上报都会表现为「页面骨架在、资源 401 → 白屏」。

## 1. 硬性前置条件（不满足 = 全部 403）

**DSH NEXT 设置里必须开启「浏览器访问」（Browser Access）。**

原因：桌面外壳给每条路由（含回环自访问）套 browser-access 门，请求带不上 Electron 渲染器头时一律 403。开启后普通浏览器放行，宿主认证（cookie）仍然生效。这只影响回环语义，不开任何端口。

## 2. 安装（本机）

```bash
# 1) 源码即安装目录（link: 直连，改代码无需拷贝）
git clone https://github.com/XcodeFish/dsh-kite.git ~/.dsh/plugin-src/dsh-kite

# 2) 在 desktop profile 声明依赖
#    ~/.dsh/profiles/desktop/package.json 的 dependencies 增加一行：
#      "dsh-kite": "link:$HOME/.dsh/plugin-src/dsh-kite"
#    然后重启 DSH NEXT（代码变更必须重启才生效）。

# 3) 验证：访问 http://127.0.0.1:<web端口>/kite —— 应看到管理面板。
```

Node 版本：`^22.19.0 || >=24.0.0`（用全局 `WebSocket`，插件本体零外部依赖；中继依赖 `ws`）。

## 3. 配置

插件自带默认配置（`cordis.patch.yml`），可在 profile patch 层覆盖：

```yaml
- id: kite
  config:
    relayUrl: 'wss://relay.example.com'   # 出站中继；空 = 待机（仅本地面板可用）
    relayToken: '<与中继 RELAY_TOKENS 匹配>'
    remoteAgentPreset: 'default'           # 远程 session/create 注入的 agent preset
    allowedAgentPresets: ['default']       # 远程可指定的白名单（之外 403）
    allowTerminal: false                   # 远程终端写类方法
    allowUpload: false                     # 远程 /api/session/uploadFileBinary
    pairingTtlSeconds: 120                 # 配对令牌有效期
    ticketTtlHours: 12                     # 设备票据有效期
```

**面板可视化配置**：「中继接入」区可直接改中继地址/令牌/公网入口 —— 「测试连接」→「应用并重连」两步确认后写入 `relay-override.json`（0600）并即时重连，无需改文件、无需重启 DSH。注意：① 改公网入口 = 所有已配对手机要重新扫码；② 优先级 **env > 面板覆盖 > patch > 默认**；③ 令牌永不明文回显（只显示 sha256 指纹前 8 位）。

env 覆盖（调试用）：`DSH_KITE_RELAY_URL` / `DSH_KITE_RELAY_TOKEN`。

数据目录：`$DSH_HOME/plugin-data/dsh-kite/<profile>/`（密钥/设备表/审计/kill switch，密钥与设备表 0600）。

## 4. 中继部署（公网 VPS，打包脚本一键）

```bash
# ── Mac：打包（ws 依赖一起打进包，服务器不需要 npm install）──
cd ~/.dsh/plugin-src/dsh-kite/relay/deploy
./build-bundle.sh        # 打印 server.mjs 与 tarball 的 sha256

# ── 上传并安装（幂等；失败自动回滚）──
scp dist/ra-relay.tar.gz user@<VPS_IP>:/tmp/
ssh user@<VPS_IP> 'tar xzf /tmp/ra-relay.tar.gz -C /tmp && sudo PUBLIC_IP=<VPS_IP> /tmp/ra-relay/install.sh'

# ── Mac：把插件指向新中继（用安装脚本输出的令牌）──
./switch-relay.sh --url wss://<VPS_IP>:8443 \
                  --public https://<VPS_IP>:8443 \
                  --token <令牌>
```

> ⚠️ **`PUBLIC_IP` 必填**（写进 Caddy 站点与 IP 证书校验目标，脚本刻意不设默认值）。
> ⚠️ `dist/` 不入库 —— **每个克隆各自打包**，不要复用别的克隆的旧包。
> 控制台唯一动作：云防火墙/安全组放行 **TCP 8443**。
> 细节（Caddy ACLI 扩展点、IP 短期证书、flush_interval）见 [`relay/deploy/README.md`](relay/deploy/README.md)。

**核验**（装完必做）：

```bash
md5sum /opt/ra-relay/server.mjs                    # 服务器上，与打包输出的 sha256 对应核对
systemctl show ra-relay -p ActiveEnterTimestamp    # 必须是「刚刚」—— install.sh 会 restart
curl -s http://127.0.0.1:8787/healthz              # 服务器本机回环
```

| 端点 | 用途 |
|---|---|
| `WSS /connector?c=<connectorId>` | Connector 出站接入（子协议 `ra-bearer.<token>` 鉴权） |
| `WSS /device` / 其它任意路径 | 手机：HTTP/WS 全桥接到 Connector；手机侧 WS 已协商 **permessage-deflate**（实时流线上字节省 ~81%） |
| `GET /healthz` `/metrics` | 健康检查 / Prometheus 指标 |

中继职责边界：配对转发 + 限流（单 IP 60/min、设备连接上限、1 MiB 帧上限、8 MiB 请求体上限、30s 响应看门狗）+ 连接器 keepalive（30s 无 pong 剔除）+ 手机 socket 保活（60s）。中继唯一持久化与信任判断是 **Pair-Proof 归属验签**（`owners.json`，见 §7）；不解密业务流量、不读用户数据。

## 5. 使用流程

**入口**：DSH Web GUI 右下角「手机远程」悬浮按钮 → `/kite` 面板。

1. 面板「生成配对二维码」→ **二维码 + 一次性链接**（2 分钟有效，用后即焚）。
2. **手机扫码** → 手机本地生成 Ed25519 密钥（WebCrypto，私钥不可导出，存 IndexedDB）→ 挑战-应答完成配对 → 手机显示 **6 位校验码**。配对成功的那一刻，新设备已进入中继路由表（无需重连/刷新）。
3. **核对校验码**：手机与面板一致才点「确认并进入 DSH」（用户成为信任根，防中继作恶抢配）。
4. 之后手机访问中继即得完整 PWA；设备票据 12h，过期后凭私钥免扫码重连。
5. 撤销：面板单台/全部撤销，即时生效并断开在线连接；**kill switch** 立即断开中继并停止重连（持久化，重启 DSH 后仍生效）。

### 手机怎么访问（三条路径，按场景选）

| 路径 | 适用 | 说明 |
|---|---|---|
| **VPS 中继（生产路径）** | 任意网络 4G/5G | 按 §4 部署 |
| **Tailscale serve** | 无 VPS、有 tailnet | 本地跑 relay，`tailscale serve`，`relayUrl` 填 `ws://127.0.0.1:8787` |
| **本机自测** | 先走通全流程 | `node relay/server.mjs`（或 `relay/start-local.sh`），配对链接在 Mac 浏览器打开 |

> 为什么手机必须走 HTTPS：配对页要用 WebCrypto（安全上下文限定），设备 cookie 带 `Secure`。`relayUrl` 为 `ws://`（本地联调）时 cookie 自动不带 `Secure`。

## 6. 权限收敛

| 层 | 行为 |
|---|---|
| 会话预设 | 远程 `session/create` 强制注入 `remoteAgentPreset`；白名单外 403 |
| 危险方法 | 终端写类 / 上传 / plugin 写操作 / 社区市场 / HMR：默认 403 + 审计 + 可读原因 |
| 请求重建 | 只复制白名单头（cookie + content-type），`Origin`/`Sec-Fetch-*`/伪造渲染器头全部丢弃；宿主 `Set-Cookie` 永不回给手机 |
| 未知终端方法 | 默认拒绝 |

**已知边界（诚实清单）**：`/api/remote.mux` 内部的 RPC 词汇是 DSH 自己的语义协议，承载层无法逐帧过滤；收敛依赖 ① 预设锁定 ② 宿主审批 ask 策略 ③ 审计。若要更硬的保证，把 profile 的 `permission.defaultPreset` 配成 `workspace-write` 及以下再开远程。

审批与提问：`approval/request` 与 `user-questions/request` 由宿主转发到所有已连接客户端 —— 手机 PWA 同样收到审批卡片，首个应答生效；本插件旁听审计（`approvals/responders.js`），绝不抢答。

## 7. 安全边界与残余风险

- **信任链**：手机私钥（不可导出）→ 设备公钥 ACL（Connector 本地 0600）→ 一次性配对 token（120s、用后即焚、timingSafeEqual）→ 6 位校验码（SHA256(devPub‖connPub)，防中继抢配）→ 挑战-应答票据（12h、nonce LRU、±60s 时间窗、counter 单调）。
- **PWA 模式的 TLS 终结点在中继**（E2E 不适用于未改造的 PWA）。thin-client sealed 模式（X25519+HKDF+AEAD，中继只见密文）的加密原语与帧已就绪（`transport/e2e.js`）。
- 配对链接泄露窗口 = 120s 且单次有效；**真正的长期凭据是设备私钥**（在手机里），不是 URL。
- 残余风险：Connector 持全权 loopback cookie（单一信任点，靠小代码量 + 审计 + host-adapter 收口）；中继域名被劫持时 PWA 模式退化为「对中继的 TLS 信任」；手机丢失 → 面板一键撤销。
- **Pair-Proof（设备归属密码学绑定）**：配对完成时手机私钥签名 `(challenge ‖ connectorId ‖ ts)`，连接器经 `device-claim` 帧交中继自主验签，归属持久化到中继 `/var/lib/ra-relay/owners.json` —— 同 token 下任何其它机器（克隆/备份扩散的连接器）都无法声明这些设备的路由。换机 = 面板撤销 + 重扫（新密钥 → 新 claim 覆盖）。
- P0：kill switch（面板/`killswitch.json`）→ 撤销全部设备 → 关中继。

## 8. 性能（公网隧道实测，2026-10-02）

打开一个大会话的全链路流量账单：首开 ~21MB（92% 是带 `rev=` 指纹的代码包，中继已加 `cache-control: immutable` 强缓存，**二次打开命中浏览器缓存**）；历史消息本身已是分页增量 + gzip（`/api/session/attachment` 原始 375KB，线上传输 ~100KB）。

已落地的传输优化：

| 优化 | 位置 | 效果 |
|---|---|---|
| 带指纹资源 `immutable` 强缓存 | 中继 | 二次打开省 92% 流量 |
| 响应 gzip（level 6） | 连接器 | JSON/JS 响应省 75–85% |
| **permessage-deflate** | 中继↔手机 WS | 实时流省 **81%**（真实载荷基准） |
| **二进制承载帧** | 连接器↔中继 WS | 大载荷免 b64+JSON 膨胀，省 25% + 解码 CPU ~5x |

规划中：局域网直连模式（同网段手机直连 Mac，消除 2×VPS RTT）。

## 9. 测试与探针

```bash
npm test          # 151 项测试（帧/E2E/票据/设备存储/配对/策略/凭据/重建/审计/中继集成/真机回归）
npm run probe     # 离线宿主契约断言（DSH 升级后先跑这个）
npm run verify    # 全链路：单测 + 面板 e2e + 配对流 + 全链 e2e + 浏览器模拟 + WS 复验
node test/live-public-pair.verify.mjs   # 线上验收：真实走一遍公网配对 + 资源路由检查
```

**真机回归测试**（`test/relay.integration.test.mjs`，每条都源自真实事故，带 A/B 反证）：

- 多连接器时 `c` 参数精确路由，不抽奖（配对卡死事故）；
- 不回 pong 的僵尸连接器被 keepalive 剔除；
- 无法路由的 ra-device 必须立刻应答，不得静默吞掉请求（挂死事故）；
- 手机建 WS（URL 不带 c）不得把设备挤出路由表（实时同步丢失事故）；
- 配对完成后连接器必须自发上报设备表（白屏 / Failed to load plugins 事故）；
- 路由条目不随手机 socket 断开消失（连接不稳定事故）；
- 未认证 `?d=` 不得改写已发布设备的路由（路由劫持，探针 `route-hijack.probe.mjs` 复现 → 加固后未复现）；
- Pair-Proof：合法 claim 绑定归属 / 伪造 claim 拒绝 / claim 绑定 connectorId 防重放换主。

在宿主内的三假设探针：管理面板 → 「运行探针」，期望 `overall:"ok"`。任何 failed → 先查「浏览器访问」是否开启（最常见的 403 来源）。

## 10. 排障

| 症状 | 处置 |
|---|---|
| 面板/代理全部 403 `Browser access is disabled` | 开「浏览器访问」（§1） |
| 手机白屏（骨架在、资源 401） | 设备不在中继路由表。升级到 ≥ 524c989 并重启 DSH（§0 路由语义） |
| 「Failed to load plugins · HTML did not preload」 | 同上 —— 连接器未在配对成功后上报设备表 |
| 手机 503「中继未就绪」 | connector 不在线：看面板 relay 状态；核对 relayUrl/relayToken |
| 实时数据不更新、越用越卡 | 老版本中继的 WS 路由 bug（c38cf6e 前）。升级中继 |
| 改了代码没生效 | 重启 DSH（宿主只在启动时加载插件模块） |
| 部署后行为像旧版 | 先核 `md5sum /opt/ra-relay/server.mjs`（§4）—— 多半是包没更新或服务没真正 restart（uptime 会说实话） |
| 疑似设备路由被其它连接器污染 | 中继日志 `journalctl -u ra-relay \| grep -E '设备路由冲突\|拒绝无凭证\|设备归属'`——Pair-Proof 后有归属的设备不可能被抢注 |

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
relay/                独立中继（唯一允许依赖 ws：server.mjs + deploy/ 一键部署包）
test/                 151 项测试 + 离线宿主探针 + 线上验收脚本
```

## 12. 与设计方案的有意偏差（ADR 补记）

1. **AEAD 用 AES-256-GCM 而非 ChaCha20-Poly1305**：浏览器 WebCrypto 无 ChaCha20，thin client 需零依赖加解密；同为 256-bit AEAD。
2. **PWA 模式下 E2E 不生效**：M0 客户端是未改造的上游 PWA，物理上无法实现 sealed 帧；该模式下中继 TLS 即边界。
3. **审批不注册应答者**：`dsh-api-remotes` 已把审批请求转发给全部远程客户端，插件抢答会制造双确认歧义。落地：旁听审计 + 依赖 PWA 应答。
4. **Bearer 令牌走子协议而非 headers**：Node 全局 WebSocket 不支持自定义头；令牌经 `Sec-WebSocket-Protocol: ra-bearer.<token>`，不落 URL 日志。
