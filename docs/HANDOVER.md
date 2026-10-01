# dsh-kite 交接文档

> 面向接手继续开发的 AI/工程师。写于 2026-10-01，覆盖当天一整轮真机排障与修复。
>
> **2026-10-01 更名备注**：项目已由 dsh-remote-access 更名 **dsh-kite**（包名/插件 id/面板路由/数据目录/env 变量名已同步改，数据目录一次性自动迁移）。本文所有旧名均指本项目；文中服务器地址等部署环境信息已替换为 `<VPS_IP>` 占位符 —— 真实值只存在于运维侧，不入库。
> **读法建议**：先读 §1 与 §2 建立心智模型，再读 §5（配置化设计，本次交接重点），
> §7 的陷阱清单建议逐条照抄，能省掉重复踩坑的时间。

---

## 1. 一页速览

**这是什么**：让手机通过公网访问本机 DSH（DeepSeek Harness）Web GUI 的插件。
纯出站架构——本机不开任何入站端口，所有连接由本机主动发起。

**当前状态**（2026-10-01 18:50）：

| 项 | 状态 |
|---|---|
| 插件版本 | `dsh-kite@0.1.0`（自有版本线，与 DSH 版本号体系无关） |
| 宿主 | DSH NEXT `2.0.15-next`；`dsh-api-session-controller@0.1.7-rc.2` |
| 中继 | <VPS_IP>（Ubuntu 24.04），Caddy v2.11.4，监听 127.0.0.1:8787 |
| 公网入口 | `https://<VPS_IP>:8443`（Let's Encrypt 签发的**裸 IP 证书**，7 天短期档，Caddy 自动续） |
| 测试 | 121 单测 + 9 层门禁全绿（`npm run verify`，退出码 0） |
| 已知未解 | §6：17:00 那次历史加载失败的成因（见该节，别当成已修完） |

**下一步该做什么**（按优先级）：

1. **部署中继解耦层**（§4.3）——线上中继还没有这层，见 §6 的说明。
2. **实现配置化面板**（§5）——这是用户点名要的下一块能力。
3. **上行分片**（§8 遗留项）——对称补齐，非阻塞。

---

## 2. 架构与数据流

```
手机 PWA ──(WSS)──► 公网中继(VPS) ──(WSS, 纯出站)──► 连接器(本机,插件内) ──(裸 upgrade + Cookie)──► 127.0.0.1 DSH
   ▲                                                                                                        │
   └──────────────────────────── 同一条 WS 桥上的双向字节流 ──────────────────────────────────────────────┘
```

三段各自的职责边界（**方案 §9.1 定的，别越界**）：

| 段 | 职责 | 明确不做 |
|---|---|---|
| 中继（VPS） | 配对转发 + 限流 | 不持有设备公钥、不解密、不持久化、**不做信任判断**。它是可用性组件，不是安全组件。 |
| 连接器（本机插件） | 设备身份校验、权限收敛、审计、loopback 桥 | 不暴露本机端口 |
| 手机 PWA | 持有设备私钥（WebCrypto，不可导出，存 IndexedDB） | 不持有中继令牌 |

**关键设计事实**：

- 设备私钥在手机浏览器里生成，**按 origin 隔离**。换公网入口 = 换 origin = 手机里没有私钥 = **必须重新扫码配对**。这不是 bug，是预期行为，面板文案必须写清楚。
- 中继的 connectorId 是**连接器公钥的指纹**（`sha256(ed25519.pub || x25519.pub)` 前 32 位 hex）。当前值 `<connectorId 指纹>`。
- 本机零入站端口：中继只看到 WSS 出站连接。

### 2.1 自研协议（连接器 ↔ 中继）

JSON 文本帧，`kind` 判别：

| kind | 方向 | 说明 |
|---|---|---|
| `hello-ack` | 中继→连接器 | 握手，`{proto:1, caps:['http','ws','pair','auth']}` |
| `http-head` / `http-body` / `http-res` | 双向 | HTTP 桥（`chunk` + `final` 已有分片语义） |
| `ws-open` / `ws-accept` / `ws-data` / `ws-close` | 双向 | WS 桥。**`ws-data` 的 `fin` 位会被原样透传到手机侧的 WebSocket** |
| `pair-*` / `auth-*` | 双向 | 配对与票据挑战 |

**`ws-data.data` 是 base64**。这是今天所有体积问题的根源，见 §3。

### 2.2 协议事实（DSH 侧，今天逐个实测出来的）

这些是**踩过坑才挖出来的**，写实现前先看：

| 事实 | 值 |
|---|---|
| mux 端点 | `/api/remote.mux`（WS） |
| HTTP RPC 信封 | `POST /api/<namespace>/<method>`，body `{type:'client-request', rpcId, method, payload}` |
| RPC 的 `payload` | 必须是 `{args: {...}}`，且 args 是**纯对象**（不是数组） |
| 参数字段名 | **按方法而异**：`session/list` 用 `_request`，`session/follow` 用 `request` |
| endpoint 命名 | `` `${descriptor.namespace}/${descriptor.method}` `` |
| `session/follow` 的 address | **结构化对象** `{kind:'session', sessionId:'session-<uuid>'}`，不是裸字符串 |
| mux open 帧 | `{type:'open', streamId, endpoint, payload}` |
| 事件总线 endpoint | `$events`（`$` 前缀是特例） |

实测可用的最小复现见 `test/session-stream.probe.mjs`——**不需要手机、不需要浏览器**就能对着真实 DSH 开流并 dump 帧。

---

## 3. 体积与阈值：今天最核心的量化结论

**问题链条**：

```
DSH 的 opening snapshot 是单个 WS 消息
  → 连接器 base64 编码（× 4/3）
  → 包进 ws-data JSON 信封
  → connector→relay 那一跳的帧体积 = ceil(payload/3)*4 + ~137B
  → 中继的 maxPayload / MAX_FRAME_BYTES = 1 MiB
```

**实测数字**（本会话，199 步时）：

| 量 | 值 |
|---|---|
| snapshot 原始 payload | **701,529 B** |
| 过中继时（base64 + 信封） | **935,522 B** |
| 占 1 MiB 上限 | **89.2%** |
| 剩余余量 | 113,054 B（按会话增速，约一两轮长对话） |
| 会话增速 | 25 分钟内 568,779 → 935,522 B |

**越过上限会发生什么**（这是今天最反直觉的一点）：

不是丢那一帧——`ws` 的 `maxPayload` 会在**解析层**拒掉并以 **1009 掐断整条连接器连接**，
**所有流同时死**。而且因为 `message` 事件从不触发，服务器侧连它的体积都记不下来
（现场 `largestFrameBytes` 只显示 568,779，因为更大的那些帧从没进过账）。

手机端看到的报错是这两条之一（**它们指向的都是「流上少了一帧」**，不是「数据太大」）：

- `session assistant stream skipped revision 1 (gateway/internal)`
- `session event stream emitted an entry before its opening cursor (gateway/internal)`

**修复后的验证信号**：

```
largestFrameBytes = 699,188  =  512 KiB × 4/3 + 137  （与设计值逐字节吻合，占上限 66.7%）
```

修复前这个数一路爬向 1 MiB；修复后它被钉在 66.7% 不动。**这个数就是分片是否生效的客观判据**，
可以从外网 `curl https://<VPS_IP>:8443/healthz` 直接读。

### 3.1 两个阈值，别搞混

| 常量 | 位置 | 值 | 作用 |
|---|---|---|---|
| `MAX_FRAME_BYTES` | relay/server.mjs | 1 MiB | **应用层**上限：超过则丢这一帧并计数（`outbound_frame_too_large` 等） |
| `MAX_WIRE_FRAME_BYTES` | relay/server.mjs | 16 MiB | **ws 层** `maxPayload`：必须**严格大于**应用层上限，否则退化成「整条连接死」 |
| `FRAGMENT_PAYLOAD_BYTES` | proxy/upgrade.js | 512 KiB | 连接器下行分片阈值 |

**为什么 maxPayload 必须大于应用层上限**：相等时超限帧在 ws 解析层就被拒 → 1009 掐连接
→ 所有流同时死，且体积无记录。解耦后超限帧会走到应用层：被计数、被记体积、按帧丢弃，
连接与其他流不受影响。这两者的差异有回归测试钉住（见 §4.4）。

---

## 4. 2026-10-01 的变更与实证

所有改动都遵循同一纪律：**每条修复必须有「把缺陷放回去、测试必须变红」的反证**。

### 4.1 丢帧可观测（P0）

**动因**：客户端报 revision 跳号时，服务器侧**零证据**——四条丢帧/断连路径全是静默的。

| 原静默点 | 现在 |
|---|---|
| `send()` 三处 `return false`，调用方普遍不检查返回值 | 每个分支持 reason 落计数：`socket_not_open` / `outbound_frame_too_large` / `socket_buffer_full` |
| 入站超大帧直接 `return` | 计数 + 记 size |
| `maxPayload` 触发的 ws error **无任何处理** | 新增 `ws.on('error')`，记 code + message |
| 积压断桥只打一行日志 | 计入 `downlink_backpressure`，关闭码统一归档 |

暴露面：`/metrics`（`ra_relay_dropped_by_reason_total` 等）+ `/healthz`（`dropped` / `droppedByReason` / `largestFrameBytes`）。
日志**必须限流**（前 5 次逐条、之后每 100 次一条），否则风暴会冲掉首因。

### 4.2 上行桥的两个真缺陷（proxy/upgrade.js）

旧实现有两条队列（`pending` 升级前 + `writeQueue` 背压中），由此产生：

- **重复写入**：`socket.write(chunk)` 返回 `false` 只表示「已接受、请稍后再写」——
  数据已被 Node 缓冲并**会**写出；旧代码却又把它 push 进 `writeQueue`，之后 flush 会**再写一遍**。
- **滞留 + 乱序**：升级后清空 `pending` 的循环遇到 `false` 就 `break`，剩下的帧永远留在数组里
  （drain 回调只清 `writeQueue`，不碰 `pending`）；而后续帧因队列为空会直接 `socket.write`
  **绕过它们** → 后发先至。

**修法**：合并成**单条 `outbox`** + `draining` 标志，顺序由数据结构本身保证，
不再依赖两个回调互相记得对方。

### 4.3 下行分片（根治）

**做法**：连接器把超过 512 KiB 的 DSH 帧拆成多个 `ws-data` 信封，
**靠 WebSocket 原生分片让浏览器重组**：

- 首个分片带原 opcode，其余用 `OP_CONT(0)`
- **只有末片继承原来的 `fin`**，所以 DSH 自己发分片时语义不被打断
- 中继已经原样透传 `fin`；`ws` 的 `Sender` 在 `_firstFragment` 为 false 时自动产出
  continuation 帧（见 `ws/lib/sender.js` 约 371-390 行）

**为什么这个方案好**：中继与手机侧**都零改动**，浏览器原生重组。

**⚠️ 必须避开的弯路**：WS **协议级**分片（`fin:false`）解决不了 `maxPayload`——
`ws` 是按**重组后的整条消息**算上限的。所以分片必须做在**连接器的 `ws-data` 信封层**，
不是内层 DSH 帧上。

**中继侧配套**：`maxPayload` 与 `MAX_FRAME_BYTES` 解耦（16 MiB），见 §3.1。

### 4.4 回归测试与反证结果

| 测试文件 | 盯死什么 | 反证（放回缺陷后） |
|---|---|---|
| `test/frame-drop-observability.test.mjs` | 观测面孔径齐全；干净握手不产生假阳性；超大帧被计数且**连接存活** | 把 `maxPayload` 改回等于应用层上限 → `必须归因到应用层的 inbound_frame_too_large，实际 {ws_error:1}` |
| `test/upgrade-backpressure.test.mjs` | 背压下不重复、不乱序（按帧解析比 payload 序列） | 把重复写入放回去 → `帧数不匹配 —— 收到 351，应为 350` |
| `test/upgrade-fragmentation.test.mjs` | 超大帧被拆开、可无损重组、**每个信封都远小于中继上限** | 关掉分片 → `700 KiB 的帧必须被拆开，实际只产出 1 个信封` |

**注意**：`test/upgrade-fragmentation` 的第一条断言是量化的体积判据，不是「拆了就行」。
只断言「拆了」而不量化体积，测试就没有能力失败。

---

## 5. 配置化设计（本次交接重点）

### 5.1 目标

把中继接入参数从「改 `cordis.patch.yml` + 重启 DSH」变成「面板里改、点一下、即时生效」。

**动因**：今天换 VPS 时踩到的真实痛点——改配置要动文件、要重启 DSH，而重启会中断会话。
另外 `compression: gzip` 曾被桌面壳重写的 `desktop-next.runtime.patch.json` 覆盖掉，
说明 **profile patch 层不由我们控制**，插件需要一个自己完全拥有的配置面。

### 5.2 数据契约

```jsonc
// $DSH_HOME/plugin-data/dsh-kite/<profile>/relay-override.json   (0600)
{
  "relayUrl": "wss://<VPS_IP>:8443",
  "relayPublicUrl": "https://<VPS_IP>:8443",
  "relayToken": "…",
  "changedAt": 1790846395148
}
```

- 缺失或损坏 → 视为**无覆盖**，静默回退（与 `killswitch.json` 同构，不引入新容错模型）
- `mode 0600`，与 `killswitch.json` / 设备表一致

### 5.3 优先级链

```
env (DSH_KITE_RELAY_URL / _TOKEN)
  > relay-override.json（面板写入）
  > cordis.patch.yml
  > 默认值
```

**为什么把面板覆盖排在 patch 之上**：插件数据目录是插件**唯一完全拥有**的配置面。
反过来把它排在 patch 之下，就等于让不受控的上层再次覆盖用户刚做的选择。

**实现建议**：`readConfig(config, override)` —— 加第二个可选参数，保持纯函数可单测
（现有 `test/config-keys.test.mjs` 就是那么测的）。

### 5.4 落地切片（文件级）

| 文件 | 改什么 | 为什么 |
|---|---|---|
| `admin/panel.js` | 新增 `RelayOverrideStore`，**照抄 `KillSwitch` 的 `load()/get()/set()`** | 已有成熟模式，不发明新轮子 |
| `index.js` | `readConfig(config, override)`；**`relay` 由 `const` 改 `let`** | 箭头函数捕获的是绑定，改成 let 后 `relayStatus: () => relay.status()` 这类 getter 才能看到新实例 |
| `transport/relay-client.js` | 新增 `probeRelay()`，**用临时 connectorId** | 见 §5.5 的坑 |
| `admin/panel.js` 路由 | `GET/POST /kite/api/relay` | 沿用现有 `adminAuth` 门 |
| `admin/panel-client.js` | 新增「中继接入」区：地址输入、令牌输入（**不回显**）、`测试连接` → `应用并重连` | 面板已是原生 DOM 构建 + `api()` 封装，加区块成本很低 |
| `README.md` + `cordis.patch.yml` | 写清四级优先级 | 免得下次又被上层 override 搞懵 |

### 5.5 三个必须先知道的坑

1. **预检探针绝不能复用连接器自己的 connectorId。**
   中继收到同 id 会执行 `connectors.get(id)?.close(4000, 'replaced')`，直接把**线上那条**踢掉。
   必须用临时 id（如 `probe-<random>`）。

2. **改 scheme（`ws://` ↔ `wss://`）会牵动 cookie 语义。**
   `secureCookies` 是在 boot 时从 `cfg.relayUrl.startsWith('wss://')` **捕获**的，
   改 scheme 就得连带重建 pairing/ticket 服务。
   **建议 v1 直接规定面板只收 `wss://`** —— 既绕开这个问题，又防止把远程入口降级成明文。
   只改 host/port 则是干净的。

3. **`relayPublicUrl` 的消费方是 live getter**（`relayPublicUrl: () => cfg.relayPublicUrl`）。
   所以要**原地修改同一个 `cfg` 对象**，或者改成从「有效配置 holder」读；直接替换 `cfg` 变量
   会让 getter 仍指向旧对象。

### 5.6 安全边界（不可削弱）

| 边界 | 现状 | 为什么不能动 |
|---|---|---|
| 管理面板主机专属 | `adminAuth(req, url, deps)` 把关；**设备侧 `policy/methods.js:87` 对 `/kite` 前缀直接 `deny(404,'reserved')`** | 手机若能改 relayUrl，就等于能把连接器指向攻击者的中继，**全程 MITM**。这条边界是整套设计的安全基石。 |
| 令牌不得回显 | 面板只显示掩码/占位 | 否则面板变成凭据展示面 |
| 每次都写审计 | `audit.jsonl` 加 `relay.reconfigure`（**不含令牌本体**，可用哈希前缀） | 与 kill switch 一样可追溯 |

### 5.7 必须提示用户的一件事

**改公网入口 = 所有已配对手机都要重新扫码。**
原因见 §2：设备私钥按 origin 隔离，新 origin 的 IndexedDB 里没有它。
这条必须写进面板的确认文案——今天迁移时就踩过一次。

### 5.8 刻意不做的事（v1 收口）

| 不做 | 原因 |
|---|---|
| 不碰策略类配置（`allowTerminal` / `allowUpload` / `allowedAgentPresets`） | 那是权限面，等于把权限开关搬进 UI，需要重建 `policy`，另开一刀 |
| 不改 `dataDir` | 路径类配置，运行期变更无意义 |
| 不做 `ws://` 输入 | 见 §5.5 坑 2 |
| 不做配置版本历史/回滚 UI | 删文件即回退，不需要更重的机制 |

### 5.9 验收口径

- `test/config-keys.test.mjs` 扩展：四级优先级
- 新 `test/relay-override.test.mjs`：落盘 0600 / 损坏容忍 / **删文件即回退**
- 新 `test/panel-relay-config.test.mjs`：未认证 401、`ws://` 被拒、审计写入、
  **令牌不回显**、**探针不挤掉在线连接器**
- `test/admin-auth.test.mjs` 扩展：新路由仍在 `adminAuth` 之后
- 回滚：删 `relay-override.json` 一个文件，无迁移

---

## 6. 未解决问题（**别当成已修完**）

### 6.1 17:00 那次失败的成因仍未解释

**事实**：17:00 用户复现「历史加载失败」时，中继最大帧只有 **568,779 B**，**在上限之内**；
`dropped = 0`。

**所以**：§4.3 的分片修复解决的是「**我量出来的、必然会发生的那次崩溃**」
（89.2% 且单调增长），**未必**是那次已经发生的失败的成因。

**下一步怎么查**：
1. 跑 `node test/session-stream.probe.mjs <sessionId>` —— 干净复现时 snapshot 是第一帧，
   说明 DSH 行为正确。若失败复现，看帧序列在哪里断。
2. 从外网读 `/healthz` 的 `dropped` / `droppedByReason` / `largestFrameBytes` 三个数。
3. 连接器侧丢帧数在面板状态行（需重启 DSH 后才加载）。

### 6.2 解耦层可能尚未部署到线上

判断方法：`curl -s https://<VPS_IP>:8443/metrics | grep wire_frame_limit`。
没有这一行 = 跑着的是旧中继。部署方式见 `relay/deploy/README.md`。

---

## 7. 陷阱清单（照抄可省时间）

### 7.1 协议/运行时

| 坑 | 真相 |
|---|---|
| 以为 WS 协议级分片能绕开 `maxPayload` | 不能，`ws` 按**重组后的整条消息**算上限 |
| 以为 `socket.write()` 返回 `false` 是「写失败」 | 是「已接受，请稍后」——数据**会**写出，再入队就是**重复写入** |
| 以为加个 `ws.on('error')` 会改变行为 | 会更安全：不加的话 error 事件只能被全局 `uncaughtException` 兜住，连接级上下文全丢 |
| 以为 /healthz 是可靠的自检 | 云厂商公网 IP 是 **NAT** 的、不在网卡上，机器上 curl 自己的公网 IP 会真的出网卡撞云防火墙。自检必须用 `curl --connect-to <ip>:<port>:127.0.0.1:<port>` |
| 以为 TCP 超时 = 服务没起 | 未放行的云防火墙端口表现为**丢包（75 秒超时）**；服务没起是**秒回 RST**。二者可区分 |

### 7.2 工具链（macOS）

| 坑 | 真相 |
|---|---|
| `mapfile` | macOS 自带 **bash 3.2**，没有 mapfile。用 `-z` + `xargs -0` |
| `timeout` | macOS 没有 `timeout`（GNU coreutils）。用工具自身的超时参数 |
| `tar` 带 macOS 扩展属性 | Linux 侧解包会刷几十行 `Ignoring unknown extended header keyword`。打包加 `--no-xattrs` |
| 测试进程「卡死」 | 多半是**服务端 socket 没关**，钉住事件循环 —— `node --test` 表现成卡死而非失败。清理要显式 `destroy()` + `closeAllConnections()` |

### 7.3 工程纪律

- **没跑 grep 前别断言 endpoint 名**：参数字段名**按方法而异**（`_request` vs `request`），
  命名空间是 typert 动态生成的。DSH 的报错信息极其精确，照着改比猜快得多——
  今天就是靠「`missing "request"; unexpected "_request"`」一句话定位的。
- **测试必须有能力失败**：写完后把缺陷放回去跑一遍，红了才算数。
  今天有一次「测试通过」其实是假通过（只产生了一个 reason，而缺陷要两个才显现）。
- **门禁假红要修**：`test/ws-mux.verify.mjs` 曾硬编码 `ws://127.0.0.1:8787`，
  迁移到 VPS 后恒定失败。一个会因为「环境变了」而长期假红的门禁，等于没有门禁，
  还会掩盖真实回归。现已改成跟随插件配置读 `relayUrl`。

---

## 8. 遗留项（按优先级）

| 项 | 说明 |
|---|---|
| 上行分片 | 对称补齐。中继对 phone→relay 的方向有 512 KB 静默上限（现已计数），DSH 侧也需要分片才能收大消息。非阻塞——上行以 JSON 小帧为主，大文件走 HTTP POST |
| 断桥语义 | `downlink_backpressure` 超 8 MiB 时 `close(1013)` 是「宁可断也不丢」的取舍，但对 assistant stream 来说「断」≈「废」。可考虑换成客户端可辨识的关闭码 |
| WS 层压缩 | 可开关 `permessage-deflate`，但会与连接器侧已有的 gzip 重复。需先量收益 |
| 客户端恢复 | **根治「revision 跳号」需要 DSH 客户端配合**：检测到跳号时重取 snapshot，而不是直接抛错。中继是 opaque 字节桥，不解析 DSH 会话协议，伪造不了 snapshot |

---

## 9. 工具链与验收口径

### 9.1 命令

```bash
npm test                     # 121 个单测
npm run verify               # 9 层门禁（含真机探针），退出码 0 为准
node test/session-stream.probe.mjs                # 列出会话
node test/session-stream.probe.mjs <sessionId>    # 对真实 DSH 开流并 dump 帧
./pack.sh --verify           # 门禁 + 打两个包到 dist/
```

### 9.2 部署

```bash
# 中继（服务器）
cd relay/deploy && ./build-bundle.sh
scp dist/ra-relay.tar.gz user@<VPS_IP>:/tmp/
# 服务器上：
tar xzf /tmp/ra-relay.tar.gz -C /tmp && sudo /tmp/ra-relay/install.sh
# 幂等：令牌从 /etc/ra-relay/relay-token.txt 复用，不会让已配对设备失效

# 卸载（完整回滚）
sudo /tmp/ra-relay/install.sh --uninstall
```

**注意**：`install.sh` 每次都会打印「Mac 侧接着跑 switch-relay.sh …」那三行，
那是**样板提示不是状态**。判断 Mac 有没有连上，看 `/healthz` 的 `connectors` 是否为 1。

### 9.3 外部可观测面

| 端点 | 用途 |
|---|---|
| `/healthz` | `connectors` / `devices` / `dropped` / `droppedByReason` / `largestFrameBytes` / `frameLimitBytes` |
| `/metrics` | Prometheus 文本，含 `ra_relay_dropped_by_reason_total{reason=...}` |

### 9.4 中继部署拓扑（VPS 侧）

- Caddy 由 **ACLI** 托管，主配置尾部有 `import "/etc/caddy/acli.d/sites/*.caddy"`
  —— 这是它留给「需要独立高端口监听器的 owner」的**官方扩展点**，
  所以中继只在那个目录加一个文件，**主 Caddyfile 一个字都不用改**。
- 证书是 Let's Encrypt 给**裸 IP** 签的短期证书，站点片段的 `tls` 段必须
  与 443 站点逐字一致（`profile shortlived` + `disable_tlsalpn_challenge`）才能复用同一张证书。
- 主配置里是 `admin off`，所以 `caddy reload` 走不通，只能 `systemctl restart caddy`（约 1 秒中断）。

---

## 10. 文件地图

```
index.js                      插件入口：readConfig / boot / 管理面装配
cordis.patch.yml              默认配置（relayUrl 默认空串）
host-adapter.js               宿主 webServer 适配

transport/relay-client.js     连接器：与中继的 WSS、帧分发、下行发送（含丢帧计数）
proxy/upgrade.js              WS 桥：loopback 升级、outbox 背压、**下行分片**
proxy/reverse-proxy.js        HTTP 桥
proxy/ws-codec.js             RFC6455 最小帧编解码（含解掩码解析）
proxy/loopback-credential.js  loopback 凭据交换（cookie 不出机）

policy/                       权限收敛：方法黑名单、路径白名单、审计
identity/                     连接器密钥、设备表、票据、配对
admin/panel.js                管理面路由 + KillSwitch（**配置化要照抄这个模式**）
admin/panel-client.js         面板 UI（原生 DOM）+ 状态行（含丢帧显示）

relay/server.mjs              中继本体（部署到 VPS 的那份）
relay/deploy/                 中继部署包：build-bundle.sh / install.sh / Caddy 与 systemd 模板
relay/deploy/README.md        部署与排障手册

test/                         121 个单测 + 真机探针
  session-stream.probe.mjs    ★ 不依赖手机/浏览器的真机复现工具
pack.sh                       完整打包（含凭据扫描）
docs/HANDOVER.md              本文档
```

---

## 11. 给接手者的三条建议

1. **先读 §3 的量化结论再动手**。这一整轮排障最大的教训是：症状（「加载失败」）和
   机制（「单帧体积撞上 base64 后的 1 MiB 硬上限，整条连接被掐」）之间隔了很远，
   靠猜会一路猜错——今天先后排除过「丢帧」「断桥」「超大帧」「带宽慢」四个假设才走对。
   **先量，再改。**

2. **每个结论都要有反证**。今天三次「测试通过」里有两次是假通过
   （一次只产生一个 reason，一次服务端 socket 没关）。把缺陷放回去跑一遍，
   是唯一能证明测试有效的方法。

3. **别把 §6 当成已修完**。今天的修复是真实的、有反证的，但**证据链没有闭合到
   最初那次失败**。诚实标注边界，比宣称「已修复」更有价值。
