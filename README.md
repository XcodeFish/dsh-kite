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

```bash
# ★ 大响应完整性验收（2026-10-03 事故后新增；回环测不出，必须让消费端真的慢读）：
#   期望：40/40 帧全部送达。旧码会在 32/40 处静默停住，且不产生任何错误帧。
node --test test/relay-backpressure.test.mjs test/connector-backpressure.test.mjs
```

> **为什么这条验收必须存在**：本地回环永远瞬时排干发送缓冲，`write()` 恒返回 true，
> 于是「大响应截断」这类 bug 在单测与桌面端**全绿**（它确实绿了整整一天）。
> 只有让消费端**故意慢读**，背压路径才会被走到 —— 而手机经公网时，这事每时每刻都在发生。

| 端点 | 用途 |
|---|---|
| `WSS /connector?c=<connectorId>` | Connector 出站接入（子协议 `ra-bearer.<token>` 鉴权） |
| `WSS /device` / 其它任意路径 | 手机：HTTP/WS 全桥接到 Connector；手机侧 WS 已协商 **permessage-deflate**（实时流线上字节省 ~81%） |
| `GET /healthz` | 健康检查（公开；只含数字与计数） |
| `GET /metrics` | Prometheus 指标（**需 `Authorization: Bearer <RELAY_TOKENS>` 或 `?token=`**，否则 404） |

中继职责边界：配对转发 + 入口限流（`/connector` 与配对端点严格 **60/min/IP**，其余手机流量 **600/min/IP**；可用 `RELAY_RATE_*_PER_MIN` 覆盖）+ 设备上限（`MAX_DEVICES`，默认 8/连接器）+ 1 MiB 帧上限 + 8 MiB 请求体上限 + 110s 响应看门狗 + 连接器 keepalive（30s 无 pong 剔除）+ 手机 socket 保活（60s）。中继唯一持久化与信任判断是 **Pair-Proof 归属验签**（`owners.json`，见 §7）；不解密业务流量、不读用户数据。`kick` 有归属校验（非归属连接器踢不动）。

**中继启动是 fail-closed**：`RELAY_TOKENS` 为空且未显式 `ALLOW_OPEN=1` 时**拒绝启动**（旧行为是静默放行一切、仅打一行日志）。本机联调用 `ALLOW_OPEN=1`，生产必须配令牌 —— 旧版以 OPEN 运行的中继升级后会拒绝启动，属预期（先配 token 再启）。日志只记 pathname，不记查询串（一次性配对令牌不落 journald）。中继侧 socket 已关 permessage-deflate 上下文接管并收窄客户端压窗口（防解压膨胀）。

## 5. 使用流程

**入口**：DSH Web GUI **左侧栏底部的「手机远程」条目**（与「上下文洞察」并列，在 Settings 之上）→ `/kite` 面板。

入口位置由 `menuEntry` 配置控制（`cordis.patch.yml` 或 profile patch 层）：

| 取值 | 效果 |
|---|---|
| `'sidebar'`（默认） | 仅左侧栏条目（侧栏收起时自动退化为 36px 圆形图标） |
| `'both'` | 左侧栏条目 + 右下角悬浮按钮 |
| `'floating'` | 仅右下角悬浮按钮（旧行为） |
| `false` | 两者都不注入（面板仍可直接访问 `/kite`） |

左侧栏条目走 `dsh.client` web 半包（`admin/sidebar-entry.js`），注册在官方槽位 `sidebar.footer.action`（`order: 20` → 排在「上下文洞察」`order: 10` 之下；改为 `order: 5` 即排到它上方）。悬浮按钮走 `webserver/index-inject`。两者共享同一套面板引擎与认证，**入口与面板是解耦的**：即便关掉悬浮按钮，`'sidebar'` 模式下仍会注入面板引擎，侧栏条目照常可用。

1. 面板「生成配对二维码」→ **二维码 + 一次性链接**（2 分钟有效，用后即焚）。
2. **手机扫码** → 手机本地生成 Ed25519 密钥（WebCrypto，私钥不可导出，存 IndexedDB）→ 挑战-应答完成配对 → 手机显示 **6 位校验码**。配对成功的那一刻，新设备已进入中继路由表（无需重连/刷新）。
3. **核对校验码**：手机**本地计算**（`crypto.subtle`，不再显示服务端回传值），面板侧独立算同一个值，一致才点「确认并进入 DSH」。算法与 `identity/pairing.js` 的 `verificationCode()` 逐字节一致：`SHA256(设备公钥B64 ‖ "|" ‖ 连接器公钥B64)` 取**前 3 字节大端序** `% 1000000`，再左补零到 6 位（**不是**「摘要前 6 个字符」——那会得到完全不同的数字）。连接器公钥来自**桌面面板生成的配对链接**（`&pk=`），不经中继转手 —— 中继若偷换手机提交的公钥，两端数字必然不一致。
   **边界（如实说明）**：配对页的 JS 本身经中继下发，一个能改写页面的中继同样能改写这段本地计算，所以校验码**挡不住「能改写客户端的中继」**；它能挡住的是字段替换/竞速式中继，以及从日志读到配对令牌后抢配的第三方。要对抗恶意中继，只有 thin-client sealed 模式或局域网/Tailscale 直连（见 §7）。
4. 之后手机访问中继即得完整 PWA；设备票据 12h，过期后凭私钥免扫码重连。
5. 撤销：面板单台/全部撤销，即时生效并断开在线连接；**kill switch** 立即断开中继并停止重连（持久化，重启 DSH 后仍生效），且对**在途请求**逐个复检（HTTP 503 / WS 4403），不是只写文件。

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

- **信任链**：手机私钥（不可导出）→ 设备公钥 ACL（Connector 本地 0600）→ 一次性配对 token（120s、用后即焚、timingSafeEqual）→ 6 位校验码（SHA256(devPub‖connPub)，手机本地计算，**防公钥替换/竞速抢配**；不改写页面的中继）→ 挑战-应答票据（12h、nonce LRU、±60s 时间窗、counter 单调）。
- **PWA 模式的 TLS 终结点在中继**（E2E 不适用于未改造的 PWA）。thin-client sealed 模式（X25519+HKDF+AEAD，中继只见密文）的加密原语与帧已就绪，**但 `transport/e2e.js` 目前仅被测试引用、未接生产链路，且是裸 ECDH 无认证 —— 不能算既有防线**，只是待交付的半成品。
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
npm test          # 194 项测试（帧/E2E/票据/设备存储/配对/策略/凭据/重建/审计/中继集成/入口模式/移动皮肤/安全回归/真机回归）
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
- Pair-Proof：合法 claim 绑定归属 / 伪造 claim 拒绝 / claim 绑定 connectorId 防重放换主；
- **大响应背压不截断**（`test/relay-backpressure.test.mjs` + `test/connector-backpressure.test.mjs`，2026-10-03 白屏事故）：中继侧 `res.write()===false` 必须完整送达、连接器侧同步循环必须等 `drain`；两个测试都刻意用「慢读」制造背压 —— 回环全速读取**不会**触发，这正是该 bug 长期漏测的原因。

在宿主内的三假设探针：管理面板 → 「运行探针」，期望 `overall:"ok"`。任何 failed → 先查「浏览器访问」是否开启（最常见的 403 来源）。

## 10. 排障

| 症状 | 处置 |
|---|---|
| 面板/代理全部 403 `Browser access is disabled` | 开「浏览器访问」（§1） |
| 手机白屏（骨架在、资源 401） | 设备不在中继路由表。升级到 ≥ 524c989 并重启 DSH（§0 路由语义） |
| 「Failed to load plugins · HTML did not preload」 | 同上 —— 连接器未在配对成功后上报设备表 |
| **手机白屏 + 「Failed to load plugins」+ `import failed`，而桌面打开同 URL 一切正常** | **大响应被截断**（2026-10-03 双根因，见 §13）。桌面走回环不触发，只有手机经公网会中招。需**中继与连接器同时升级**（重启 DSH） |
| 手机 503「中继未就绪」 | connector 不在线：看面板 relay 状态；核对 relayUrl/relayToken |
| 实时数据不更新、越用越卡 | 老版本中继的 WS 路由 bug（c38cf6e 前）。升级中继 |
| **配对二维码区一直停在「等待手机提交…」，而下方设备表已出现新设备** | 面板缺配对终态来源（2026-10-03 修复，§13）。症状成因：配对成功那一刻会话即从 `pending` 删除，旧码只判断「列表是否非空」→ 列表转空后什么都不做，初始文案永驻；手机若在两次轮询（旧码 5 秒）之间完成，连「已出校验码」的中间态都观察不到。现由 `pairing.last()` 提供成功/失败/过期/中止四种终态。修复需**重启 DSH** |
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
                      ├─ menu-entry.js     悬浮按钮注入（webserver/index-inject）
                      ├─ sidebar-entry.js  左侧栏条目（dsh.client web 半包，sidebar.footer.action 槽）
                      └─ panel-client.js   面板引擎（浮层 + 认证；暴露 window.__DSH_KITE_OPEN__ 供侧栏调用）
relay/                独立中继（唯一允许依赖 ws：server.mjs + deploy/ 一键部署包）
test/                 194 项测试 + 离线宿主探针 + 线上验收脚本 + 真机 Chrome e2e（入口模式 / 配对）
```

## 12. 与设计方案的有意偏差（ADR 补记）

1. **AEAD 用 AES-256-GCM 而非 ChaCha20-Poly1305**：浏览器 WebCrypto 无 ChaCha20，thin client 需零依赖加解密；同为 256-bit AEAD。
2. **PWA 模式下 E2E 不生效**：M0 客户端是未改造的上游 PWA，物理上无法实现 sealed 帧；该模式下中继 TLS 即边界。
3. **审批不注册应答者**：`dsh-api-remotes` 已把审批请求转发给全部远程客户端，插件抢答会制造双确认歧义。落地：旁听审计 + 依赖 PWA 应答。
4. **Bearer 令牌走子协议而非 headers**：Node 全局 WebSocket 不支持自定义头；令牌经 `Sec-WebSocket-Protocol: ra-bearer.<token>`，不落 URL 日志。

## 13. 事故档案：大响应截断（2026-10-03）

**症状**：手机端白屏并报 `Failed to load plugins` / `import failed`；**桌面端打开同一 URL 完全正常**。

**根因（两处，同一类错的两次独立犯案 —— 缺一不可地同时修复）**：

| # | 位置 | 错误写法 | 后果 |
|---|---|---|---|
| ① | `relay/server.mjs` 响应回传 | 把 `res.write(chunk) === false`（**正常的 TCP 背压信号**）当成致命错误 → `res.destroy()` | 头已发出（`200` + `content-length: N`），body 只写一半 → 浏览器判定响应不完整 |
| ② | `transport/relay-client.js` `#sendHttpResponse` | 在**同步 for 循环**里一次性把整个 body 塞进 ws | 10 MB 合并包 = 40 帧 × 341 KB ≈ 13.3 MB 连续入队，同步循环期间事件循环无法推进，`bufferedAmount` 顶穿 8 MB 上限 → `send()` 返回 false → **静默 return**：实测只发出 **32/40 帧**，20% 数据丢失且**无任何错误帧** |

**为什么只有手机中招、且长期漏过测试**：这两条路径都只在「消费端读取变慢」时才触发。
桌面端走 `127.0.0.1` 回环，内核瞬时排干，`write()` 永远返回 true；本地单测同样是回环 ——
**测试环境的物理特性恰好把 bug 遮住了**。手机经公网 + Caddy + TLS，接收窗口必然在传输
大包的某一刻填满，背压不可避免。

**现场证据**（`~/.dsh/plugin-data/dsh-kite/default/audit.jsonl`）：06:25 时间窗内，
两个最大的合并包（`5492860 B` 与 `10461917 B`）被**反复重试 9 次 / 13 次** —— 正是浏览器
「资源没下全 → 重试 → 又没下全」的症状。

**修复与验收**：

```bash
# 单测（含两个新回归测试，均在旧码上验证过会红）
node --test test/*.test.mjs                     # 194/194

# 复现矩阵：生产实测尺寸 × 600ms 慢读
#   旧码 完整 0/3   收到 [0, 0, 0] 字节
#   新码 完整 3/3   收到 [5492860, 5492860, 5492860]
```

**新增可观测面**（`/healthz` 与 `/metrics`）：

| 指标 | 含义 |
|---|---|
| `httpBackpressure` / `ra_relay_http_backpressure_total` | 背压发生次数。**它是正常现象** —— 持续增长且客户端不再报错，就说明修复生效 |
| `httpPendingPeak` / `ra_relay_http_pending_peak_bytes` | 单流未排空字节峰值。用于确认「不断开」没有退化成无界内存 |
| `ra_relay_stream_pending_limit_bytes` | 护栏上限（默认 32 MiB，`RELAY_MAX_STREAM_PENDING_BYTES` 可调）。**只有**超过它才判定对端真死并断开 |

**教训（写进纪律）**：`write()` / `send()` 返回 `false` 是**背压**，不是**错误**。
正确的反应是「等 `drain` 再继续」；若最终确实发不出去，必须**显式回报错误帧** ——
静默 `return` 让失败在两端都不可见，是最贵的写法。

## 14. 事故档案：配对成功却一直「等待手机提交…」（2026-10-03）

**症状**（用户真机截图）：扫二维码配对成功、设备已出现在下方「已配对设备」表里，
二维码区红框内却仍是初始文案 **「等待手机提交…」**。用户无法判断到底连上没有。

**根因：面板没有「配对终态」这个数据源，不是刷新慢。**

配对状态机里，`pairing.complete()` 成功那一刻就把会话从 `pending` 删除了。于是面板每轮
`/status` 能观察到的只有「`pairings` 列表从有到无」，而**四种完全不同的结局在列表里长得
一模一样**：成功 / 挑战验签失败 / 二维码 120 秒过期 / kill switch 清空。

旧浮层代码只有一条分支：

```js
if (list.length > 0) { codeEl.textContent = coded ? coded.code : '等待手机提交…'; }
```

列表转空后**什么都不做** → 初始文案（在 `makePairing` 里写死的「等待手机提交…」）永驻。
手机上那一次真机配对（audit：`pair.create` 11:33:09 → `challenge`/`success` 11:33:21）
手机 12 秒就完成了，而旧浮层 5 秒一轮、且要「恰好撞上已出校验码的中间态」才会进这个分支 ——
**时序上大概率一次都进不去**，这正是截图里的样子。

独立页 `/kite` 曾用时间窗启发式绕过（「上一轮有校验码 + 这一轮消失 + 设备表 2 分钟内有新条目
→ 成功」），但它有三个洞：① 只在已出现过校验码后武装，先提交后失败的路径看不见；
② 失败/过期一律不显示，照样停在「等待手机提交…」；③ 别的连接器刚配对的设备也落进 2 分钟
窗口，会**误报**成功。浮层连这个启发式都没有。

**修复：服务端给确定终态，不再让客户端猜。**

| 层 | 改动 |
|---|---|
| `identity/pairing.js` | 新增单槽终态 `lastOutcome` + `last()`；`complete()` / 验签失败 / 过期 sweep / 重复提交 / `abortAll()` 各自留痕（`done` / `rejected` / `expired` / `reused` / `aborted`）。带**时间单调守卫**，乱序回调不得覆盖更新的结局 |
| `admin/panel.js` | `/kite/api/status` 增 `pairingLast`（旧实例无 `last()` → `null`，面板自动回退旧行为）；`POST /kite/api/pairings` 回 `tokenMasked` 供客户端**认领**自己的那次配对 |
| `admin/panel-client.js`（浮层，截图那个面） | 新 `renderPairOutcome()`：进行中→校验码，成功→`✓ 配对成功` + 3 秒折叠，失败/过期→`✗ 未完成` + 可操作原因；配对展开时轮询 5s → **1.5s** |
| `admin/panel.js`（独立页 `/kite`） | 同样改走 `pairingLast`，删掉时间窗启发式；`window.__pairWatch` 改为按 `tokenMasked` 认领 |

**归属保护**：只有 `last.tokenMasked === 本次配对` 的终态才落到本面板 —— 别人的面板、
或有人拿旧二维码在扫，都不会把结论写到这里（另配 ⑤ 回归用例钉住）。

**验收**（新增 6 个面板 e2e 用例 + 4 个单测，均在旧码上验证过会红）：

```bash
node test/panel.e2e.mjs     # 23/23（旧码 14/20，失败项正是截图症状）
node --test test/*.test.mjs # 199/199
npm run verify              # 全绿
```

**途中抓到的次生 bug（同一处的两个）**：成功态的「3 秒后折叠」用无条件 `setTimeout` 写在
每轮轮询都会执行的渲染函数里 → 定时器被不断续命，**折叠永不触发**；且用户折叠前又点一次
「生成配对二维码」时，上一轮的折叠定时器仍挂着，会在**新配对进行中把二维码区藏掉**。
现改为持有句柄 `pairHideTimer`、只挂一次、新一轮配对时显式撤销。

**教训（写进纪律）**：UI 里出现「等待 X…」这种**过程态**文案时，必须同时定义它的
**终态集合**与**终态来源**。只判断「列表是否为空」等于把「成功」和「失败」合并成
「什么都不做」—— 用户看到的就是一个永远不动的加载态。另：每轮重渲染的渲染函数里
**不得无条件挂定时器**（状态机副作用要幂等）。

