/**
 * dsh-kite 公网中继（方案 §9）。
 *
 * 职责边界（严格）：接受 Connector 出站 WSS（Bearer 鉴权）；接受手机 WSS 升级与
 * 普通 HTTPS 请求并按路由转发；限流、连接上限、帧大小上限；健康检查与指标。
 * 绝不做：不持有设备公钥、不解密 sealed 帧、不持久化消息、不做信任判断 ——
 * 中继是可用性组件，不是安全组件（真正的 ACL 校验在 Connector）。
 *
 * 路由模型：
 *   /connector      Connector 出站 WSS（子协议 ra-bearer.<token>；?c=<connectorId>）
 *   /device         thin client 信令通道（pair/auth/sealed 帧 opaque 直通）
 *   其它任意路径    手机 PWA：HTTP → http-head/body 帧；WS 升级 → ws-open 桥
 *
 * 手机路由无需信任：deviceId 从 ra-device cookie 的 payload 段 best-effort 解出
 * （仅作路由提示；真伪由 Connector 的票据验签兜底）；配对链接带 ?c=<connectorId>。
 *
 * 环境变量：
 *   PORT                监听端口（默认 8787）
 *   TLS_KEY / TLS_CERT  PEM 路径（生产必配；或前置 caddy/nginx 终结 TLS）
 *   RELAY_TOKENS        逗号分隔接入令牌（空 = 开放，仅限本地开发）
 *   MAX_DEVICES         单连接器设备上限（默认 8）
 *   MAX_PHONE_PER_DEVICE 单设备并发手机 socket 上限（默认 4）
 */
import http from 'http';
import https from 'https';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID, createHash, verify as edVerify, createPublicKey, KeyObject } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { gzipSync } from 'node:zlib';

// ---- 二进制承载帧编解码（与 transport/frames.js 保持协议一致的内联副本）----
// ★ 刻意内联而非 import：中继的部署纪律是「自包含单文件」（build-bundle 只带
//   server.mjs + ws 依赖，/opt/ra-relay 下没有 ../transport/）。2026-10-02 事故：
//   一度写成 import '../transport/frames.js'，服务器上解析成 /opt/transport/… 直接
//   ERR_MODULE_NOT_FOUND 循环崩溃。改动协议时两边必须同步改 —— 测试
//   test/bin-frames.test.mjs + relay.integration.test.mjs 会同时覆盖两侧。
const BIN_SEPARATOR = 0x00;
const BIN_PAYLOAD_FIELD = {
  'http-body': 'chunk',
  'http-res-body': 'chunk',
  'ws-data': 'data'
};
class FrameError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---- Pair-Proof 设备归属表（2026-10-02 审查定稿）----
// ★ owners.json 持久化路径：默认 /opt/ra-relay 旁的数据目录不可写（systemd
//   ProtectSystem=strict + User=ra-relay），因此显式用环境变量 OWNER_STATE_DIR，
//   install.sh 里 create StateDirectory=ra-relay（即 /var/lib/ra-relay）。
//   未配置或不可写时降级为「仅内存」（重启后靠连接器重发 claim 恢复 —— 连接器
//   每次连接都会重放 claim）。
const OWNERS_FILE = (() => {
  const dir = process.env.OWNER_STATE_DIR;
  if (!dir) return null;
  try { mkdirSync(dir, { recursive: true }); return dir + '/owners.json'; }
  catch { console.error('[ra-relay] OWNER_STATE_DIR 不可写，owner 表降级为内存模式'); return null;
  }
})();
/** deviceId → { connectorId, sig, ts, challenge, pubKey }：验签通过的归属记录。 */
const deviceOwners = new Map();
const CLAIM_PUBKEY_ID_BIND = true; // sha256(pubKey) 必须等于 deviceId（公钥-身份自绑死）
if (OWNERS_FILE) {
  try {
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(OWNERS_FILE, 'utf8')))) deviceOwners.set(k, v);
    if (deviceOwners.size) console.log(`[ra-relay] 设备归属表恢复：${deviceOwners.size} 条`);
  } catch { /* 首次启动无文件 —— 正常 */ }
}
let ownersFlushTimer = null;
function persistOwners() {
  if (!OWNERS_FILE) return;
  clearTimeout(ownersFlushTimer);
  ownersFlushTimer = setTimeout(() => {
    try { writeFileSync(OWNERS_FILE, JSON.stringify(Object.fromEntries(deviceOwners))); }
    catch (error) { console.error('[ra-relay] owners.json 写入失败:', error.message); }
  }, 500);
}
function isBinEligible(frame, minPayload = 4096) {
  if (!frame || typeof frame !== 'object') return false;
  const field = BIN_PAYLOAD_FIELD[frame.kind];
  if (!field) return false;
  const v = frame[field];
  return typeof v === 'string' && v.length >= Math.ceil(minPayload * 4 / 3);
}
function encodeBinFrame(frame) {
  const field = BIN_PAYLOAD_FIELD[frame.kind];
  if (!field) throw new FrameError('bad-frame', `${frame.kind}: not a binary-eligible kind`);
  const payload = Buffer.from(frame[field], 'base64url');
  const head = { ...frame };
  delete head[field];
  return Buffer.concat([Buffer.from(JSON.stringify(head), 'utf8'), Buffer.from([BIN_SEPARATOR]), payload]);
}
function decodeBinFrame(buf) {
  if (!Buffer.isBuffer(buf)) throw new FrameError('bad-frame', 'binary frame must be a Buffer');
  const at = buf.indexOf(BIN_SEPARATOR);
  if (at === -1 || at === 0 || at > 4096) throw new FrameError('bad-frame', 'binary frame: separator not found or head too large');
  let frame;
  try {
    frame = JSON.parse(buf.subarray(0, at).toString('utf8'));
  } catch {
    throw new FrameError('bad-json', 'binary frame head is not valid JSON');
  }
  const field = BIN_PAYLOAD_FIELD[frame?.kind];
  if (!field) throw new FrameError('unknown-kind', `binary frame has non-binary kind ${JSON.stringify(frame?.kind)}`);
  if (field in frame) throw new FrameError('bad-frame', `binary frame head must not carry "${field}"`);
  frame[field] = buf.subarray(at + 1).toString('base64url');
  return frame;
}

// 守护弹性：中继是可用性组件，未捕获异常/拒绝只记日志不退出（launchd KeepAlive 之外的二道防线）。
process.on('uncaughtException', (err) => console.error('[ra-relay] uncaught:', err?.stack || err));
process.on('unhandledRejection', (err) => console.error('[ra-relay] unhandled rejection:', err?.stack || err));

const PORT = Number(process.env.PORT || 8787);
const RELAY_TOKENS = new Set(String(process.env.RELAY_TOKENS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const MAX_DEVICES = Number(process.env.MAX_DEVICES || 8);
const MAX_PHONE_PER_DEVICE = Number(process.env.MAX_PHONE_PER_DEVICE || 4);
const MAX_FRAME_BYTES = 1024 * 1024;
/**
 * ★ ws 层的 maxPayload 必须【严格大于】应用层的 MAX_FRAME_BYTES，不能相等（2026-10-01 根治）。
 *
 * 相等时会发生什么：超限帧在 ws 解析层就被拒并抛 error → 以 1009 掐断【整条连接】，
 * 所有流同时死；而且因为 message 事件从不触发，我们连它的体积都记不下来 ——
 * 真机现场正是如此：客户端报 entry before opening cursor / skipped revision，
 * 服务器侧 largestFrameBytes 却只显示 568KB（更大的帧从未进过账）。
 *
 * 留出余量后，超大帧会走到应用层：被计数、被记下体积、按帧丢弃，连接与其他流都不受影响。
 * 16 MiB 是给 base64（膨胀 4/3）和信封字段留的余量，不是留给 DSH 消息的 ——
 * DSH 消息由连接器侧分片控制在 512 KiB 以内，走不到这里。
 */
const MAX_WIRE_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** 单条桥的下行积压上限（超过则关闭该桥，让客户端重连并用 session 游标追平）。 */
const MAX_PHONE_BUFFER_BYTES = 8 * 1024 * 1024;
/** WebSocket 发送缓冲上限（连接器/手机任一侧超限即拒发，避免静默丢帧）。 */
const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 110_000; // 高于 Cloudflare 524 阈值（100s），保证我们能先给出明确错误而非 CF 超时页
const CONNECT_RATE = { windowMs: 60_000, max: 60 };

const metrics = {
  connectorConnects: 0, phoneConnects: 0, httpRequests: 0, wsBridges: 0, rejected: 0,
  bytesRelayed: 0, startedAt: Date.now(),
  // ---- 丢帧观测（P0，2026-10-01）------------------------------------------------
  // 动因：客户端报「session assistant stream skipped revision N」时，服务器侧零证据 ——
  // 因为下面这些丢帧/断连路径以前全是静默的：
  //   ① send() 超限/缓冲满 → 返回 false，调用方普遍忽略返回值
  //   ② 入站超大帧 → 直接 return（实际上 maxPayload 先生效，见 ③）
  //   ③ maxPayload === MAX_FRAME_BYTES → 超大帧让 ws 抛 error，整条连接死掉（1009）
  //      且当时没有任何 ws.on('error')，只能被全局 uncaughtException 兜住，连接级上下文全丢
  //   ④ 下行/上行积压超限 → 主动 close(1013)，客户端重连后 resume
  // 诊断「差一帧」这类故障，缺的就是这几组的计数与首次样本。
  dropped: 0,
  droppedByReason: new Map(),
  closesByCode: new Map(),
  largestFrameBytes: 0
};

/** 记录见过的最大帧。判断「是不是撞上 MAX_FRAME_BYTES」全看它。 */
function noteFrame(bytes) {
  if (bytes > metrics.largestFrameBytes) metrics.largestFrameBytes = bytes;
}

/**
 * 记一次丢帧。返回值恒为 false，方便 `return recordDrop(...)` 就地替换旧的无信号 return。
 * ★ 日志必须限流：一次风暴能瞬间刷爆 journald，反而把首因冲掉。
 *   策略：每个 reason 前 5 次逐条记（拿到首因与首个样本），之后每 100 次记一条。
 */
function recordDrop(reason, detail) {
  const entry = metrics.droppedByReason.get(reason) ?? { count: 0, firstAt: Date.now(), lastAt: 0, sample: null };
  entry.count += 1;
  entry.lastAt = Date.now();
  if (detail) entry.sample = detail;
  metrics.droppedByReason.set(reason, entry);
  metrics.dropped += 1;
  if (entry.count <= 5 || entry.count % 100 === 0) {
    console.log(`[ra-relay] 丢帧 reason=${reason} count=${entry.count}${detail ? ` ${JSON.stringify(detail)}` : ''}`);
  }
  return false;
}

/** 记一次连接关闭。只对非正常码（非 1000/1001）计数 —— 1006/1009/1013 才是要找的东西。 */
function recordClose(peer, code, reason) {
  const key = `${peer}:${code}`;
  const entry = metrics.closesByCode.get(key) ?? { count: 0, lastAt: 0, sample: null };
  entry.count += 1;
  entry.lastAt = Date.now();
  entry.sample = String(reason ?? '').slice(0, 120);
  metrics.closesByCode.set(key, entry);
  if (code !== 1000 && code !== 1001) {
    console.log(`[ra-relay] 连接关闭 peer=${peer} code=${code} reason=${entry.sample}（非正常，累计 ${entry.count}）`);
  }
}

/** connectorId → connector ws */
const connectors = new Map();
/** deviceId → { connectorId, phones:Set<ws> } */
const devices = new Map();
/**
 * connectorId → Set<deviceId>：连接器**权威上报**过的设备表（`devices` 帧）。
 *
 * ★ 2026-10-02 真机事故（界面「一直显示重新连接」）：devices 条目的生命周期一度被绑在
 *   「这台手机此刻还有没有 socket 开着」上 —— 手机合盖/退后台/被杀，最后一条 socket
 *   close 就把条目删掉（旧 907 行），而连接器只在**重连/配对完成**时才重报设备表
 *   （transport/relay-client.js 的 publishDevices 三个调用点），于是该设备此后所有
 *   **只带 ra-device cookie** 的请求全部失去路由键：
 *     · 前端全部相对路径请求（/api/*、assets）→ 中继 401/503（走不到连接器）
 *     · 不带 c 的 /api/remote.mux 实时通道 → 中继 4503 直接掐掉 → 界面永远「重新连接」
 *   单连接器部署被「唯一连接器兜底」（connectorFor 的 connectors.size===1 分支）掩盖；
 *   一旦中继上同时挂着 2 个连接器，兜底失效，症状就是刷新也没用的死锁。
 *   本表是「条目该不该留」的唯一判据：连接器上报过的设备，条目必须常驻。
 */
const publishedDevices = new Map();
/** 设备所有权冲突去重日志：deviceId:connectorId → 已告警过（防日志风暴）。 */
const conflictLogged = new Set();
/**
 * streamId → 挂起会话：{ res? , phone?, timer?, connectorId }
 * 另有两个信令键：`pair:<channel>` 与 `ch:<channel>` → { phone }
 */
const streams = new Map();
/** 每 IP 连接速率 */
const connectRate = new Map();

// ---- 连接器存活探测（keepalive）----
// ★ 真机事故 2026-10-01：连接器侧 TCP 半开（机器休眠/断网/换网）后 socket 不会立刻
//   触发 close，僵尸条目永久占住 connectors 表 —— size===2 让「单连接器兜底」失效，
//   多连接器兜底又把请求投进尸体，请求黑洞化（手机无限转圈到 110s 看门狗）。
//   中继主动 ping：一个周期内没见到 pong 就 terminate，走 on('close') 的既有清理
//   （摘设备路由表、给挂起 HTTP 流回 502）。ws/浏览器/undici 客户端在协议层自动回 pong。
const _pingEnv = Number(process.env.RELAY_CONNECTOR_PING_MS);
const CONNECTOR_PING_MS = Number.isFinite(_pingEnv) && _pingEnv >= 1000 ? _pingEnv : 30_000;
const connectorAlive = new WeakMap(); // connector ws → 上个周期是否见到 pong
const binCaps = new WeakSet();        // 已协商 caps 'bin' 的 socket（connector 或 phone）→ 可收发二进制承载帧
setInterval(() => {
  for (const [id, ws] of connectors) {
    if (ws.readyState !== 1) continue;
    if (connectorAlive.get(ws) === false) {
      console.log(`[ra-relay] 连接器无响应（${CONNECTOR_PING_MS}ms 内未回 pong），剔除 c=${id.slice(0, 12)}`);
      try { ws.terminate(); } catch { /* close 事件兜底 */ }
      continue;
    }
    connectorAlive.set(ws, false);
    try { ws.ping(); } catch { /* readyState 竞态，下轮再判 */ }
  }
}, CONNECTOR_PING_MS);

// ---- 手机 socket 存活探测（keepalive）----
// ★ 真机事故 2026-10-02（与 publishedDevices 同一条因果链的另一半）：手机「合盖/退后台/
//   被系统杀掉/换网」时 socket 常常不送 FIN，中继这边 readyState 仍是 OPEN 的**幽灵**条目 ——
//   它既占住 MAX_PHONE_PER_DEVICE 名额（攒够 4 条后，重新打开浏览器建 mux 一律被 4429
//   「too many connections」挡回，界面永远「重新连接」），又让条目永不回收。
//   与连接器同样周期 ping：一个周期内没见到 pong 即 terminate，走既有 close 清理。
//   （ping/pong 是协议层自动应答，页面退到后台、JS 被冻结也会回；回不了 = 连接真的没了。）
const _phonePingEnv = Number(process.env.RELAY_PHONE_PING_MS);
const PHONE_PING_MS = Number.isFinite(_phonePingEnv) && _phonePingEnv >= 1000 ? _phonePingEnv : 60_000;
const phoneAlive = new WeakMap(); // phone ws → 上个周期是否见到 pong
setInterval(() => {
  for (const entry of devices.values()) {
    for (const ws of [...entry.phones]) {
      if (ws.readyState !== 1) {
        entry.phones.delete(ws); // 已死但 close 还没跑到：先让位，避免占名额
        continue;
      }
      if (phoneAlive.get(ws) === false) {
        console.log('[ra-relay] 手机 socket 无响应（一个 ping 周期未回 pong），剔除幽灵连接');
        try { ws.terminate(); } catch { /* close 事件兜底 */ }
        continue;
      }
      phoneAlive.set(ws, false);
      try { ws.ping(); } catch { /* readyState 竞态，下轮再判 */ }
    }
  }
}, PHONE_PING_MS);

function rateLimit(ip) {
  const now = Date.now();
  let entry = connectRate.get(ip);
  if (!entry || now - entry.start > CONNECT_RATE.windowMs) {
    entry = { start: now, count: 0 };
    connectRate.set(ip, entry);
  }
  entry.count += 1;
  return entry.count <= CONNECT_RATE.max;
}

/**
 * 发送一帧。★ 必须做背压检查：
 * 旧实现忽略 ws 的发送缓冲，直接 ws.send() 并恒返回 true —— 大会话（如 39 轮
 * 715 步）推送高频 assistant-stream 帧时缓冲膨胀，极端情况下丢帧，表现为客户端
 * 「session assistant stream skipped revision N」（真机事故 2026-10-01）。
 * @returns false 表示未发送（调用方须决定重试/断连，不得静默丢弃）。
 *
 * ★ P0（2026-10-01）：旧实现三处 `return false` 全无信号，而调用方（552/568 等）
 *   普遍不检查返回值 —— 于是「帧被丢掉」这件事在服务器侧完全不可见。
 *   现在每个分支出处都带 reason 落进 recordDrop，再也不会无声。
 */
function send(ws, frame) {
  if (!ws || ws.readyState !== 1) {
    return recordDrop('socket_not_open', { readyState: ws?.readyState ?? null, kind: frame?.kind });
  }
  // ★ 二进制承载帧：该 socket 协商过 'bin' 且帧适合（大载荷）→ 免 b64+JSON 膨胀。
  //   phone socket 与 connector socket 各自记录协商结果（binCaps WeakSet）。
  if (binCaps.has(ws) && isBinEligible(frame)) {
    let bin;
    try {
      bin = encodeBinFrame(frame);
    } catch (error) {
      return recordDrop('bin_encode_failed', { kind: frame?.kind, message: String(error?.message ?? error).slice(0, 120) });
    }
    noteFrame(bin.length);
    if (bin.length > MAX_WIRE_FRAME_BYTES) {
      return recordDrop('outbound_frame_too_large', { size: bin.length, limit: MAX_WIRE_FRAME_BYTES, kind: frame?.kind });
    }
    if (ws.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
      return recordDrop('socket_buffer_full', { bufferedAmount: ws.bufferedAmount, size: bin.length, kind: frame?.kind });
    }
    metrics.bytesRelayed += bin.length;
    ws.send(bin, { binary: true });
    return true;
  }
  const text = JSON.stringify(frame);
  const size = Buffer.byteLength(text);
  noteFrame(size);
  if (size > MAX_FRAME_BYTES) {
    return recordDrop('outbound_frame_too_large', { size, limit: MAX_FRAME_BYTES, kind: frame?.kind });
  }
  // 背压：超过上限时拒绝本次发送（调用方会断开桥，让客户端用 session 游标追平，
  // 而不是让帧在内存里无限排队直至乱序/丢失）。
  if (ws.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
    return recordDrop('socket_buffer_full', { bufferedAmount: ws.bufferedAmount, size, kind: frame?.kind });
  }
  metrics.bytesRelayed += size;
  ws.send(text);
  return true;
}

/** 从 ra-device cookie（`v1.<body>.<sig>`）best-effort 解 deviceId（只作路由提示）。 */
function routeHintFromCookie(header) {
  if (typeof header !== 'string') return null;
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1 || segment.slice(0, at).trim() !== 'ra-device') continue;
    const parts = segment.slice(at + 1).trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return null;
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      return typeof payload.deviceId === 'string' ? payload.deviceId : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 解析某请求/升级应发往的 connector ws。候选路由键按可靠性依次尝试：
 * cookie 的 deviceId → 链接的 c 参数（每个候选先查设备路由表，再按 connectorId 精确匹配）。
 *
 * ★ c 参数必须参与精确匹配（真机事故 2026-10-01）：配对完成后手机才第一次带上
 *   ra-device cookie，而刚配对的设备要等连接器下次上报才进路由表 —— cookie 提示
 *   必然未命中；此时 welcome 链接里的 c=<connectorId> 是唯一确定性凭据。旧实现
 *   在 cookie 未命中后直接掉进「多连接器投第一个」的抽奖，把请求送进错误/僵尸
 *   连接器，手机卡死在「配对完成，正在进入 DSH…」。
 */
function connectorFor(req, url) {
  const cookieHint = routeHintFromCookie(req.headers.cookie);
  const cParam = url.searchParams.get('c');
  for (const hint of [cookieHint, cParam]) {
    if (!hint) continue;
    const entry = devices.get(hint);
    if (entry) {
      const ws = connectors.get(entry.connectorId);
      if (ws) return { ws, deviceId: hint };
    }
    if (connectors.has(hint)) return { ws: connectors.get(hint), deviceId: 'pair' };
    // hint 存在但查不到映射 → 尝试下一个候选（设备表可能刚更新、cookie 可能陈旧）。
    // ★ 真机事故 2026-09-30：旧实现只认「hint 完全为空」才兜底，导致带陈旧 cookie
    //   的真实请求被拒（界面卡在「重新连接中…」、每次请求都要等超时）。
  }

  // ★ 兜底：单连接器场景（本插件最常见部署形态）下，把请求投给唯一的在线连接器。
  //   中继不做信任判断 —— 真正的准入仍由连接器验签（ticket）裁决，中继只是转发。
  if (connectors.size === 1) {
    const first = connectors.entries().next().value;
    return { ws: first[1], deviceId: cookieHint ?? cParam ?? 'pair' };
  }

  // 多连接器时的配对路径兜底（配对阶段尚无有效凭据；走到这里说明两个候选键都未命中）：
  if (connectors.size > 1
      && (url.pathname === '/kite/pair' || url.pathname.startsWith('/kite/pair/')
          || url.pathname === '/kite/welcome')) {
    const first = connectors.entries().next().value;
    console.log(`[ra-relay] 多连接器兜底：${url.pathname} 无确定路由键（cookie=${cookieHint ?? '无'} c=${cParam ?? '无'}），投给第一个连接器`);
    return { ws: first[1], deviceId: 'pair' };
  }
  return null;
}

// ---- HTTP 面 ----

function handleHealth(res) {
  // dropped / largestFrameBytes 一并暴露：手机上打不开 /metrics，但 /healthz 是常用入口，
  // 这两个数就是「有没有丢帧、最大帧离 1 MiB 上限还有多远」的现场快照。
  const droppedByReason = {};
  for (const [reason, entry] of metrics.droppedByReason) droppedByReason[reason] = entry.count;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    connectors: connectors.size,
    devices: devices.size,
    uptimeMs: Date.now() - metrics.startedAt,
    dropped: metrics.dropped,
    droppedByReason,
    largestFrameBytes: metrics.largestFrameBytes,
    frameLimitBytes: MAX_FRAME_BYTES
  }));
}

function handleMetrics(res) {
  const uptime = Math.floor((Date.now() - metrics.startedAt) / 1000);
  const lines = [
    '# TYPE ra_relay_connectors gauge', `ra_relay_connectors ${connectors.size}`,
    '# TYPE ra_relay_devices gauge', `ra_relay_devices ${devices.size}`,
    '# TYPE ra_relay_http_requests_total counter', `ra_relay_http_requests_total ${metrics.httpRequests}`,
    '# TYPE ra_relay_ws_bridges_total counter', `ra_relay_ws_bridges_total ${metrics.wsBridges}`,
    '# TYPE ra_relay_rejected_total counter', `ra_relay_rejected_total ${metrics.rejected}`,
    '# TYPE ra_relay_bytes_total counter', `ra_relay_bytes_total ${metrics.bytesRelayed}`,
    '# TYPE ra_relay_uptime_seconds gauge', `ra_relay_uptime_seconds ${uptime}`,
    // ---- 丢帧观测（P0）----
    '# TYPE ra_relay_dropped_total counter', `ra_relay_dropped_total ${metrics.dropped}`,
    '# TYPE ra_relay_largest_frame_bytes gauge',
    `ra_relay_largest_frame_bytes ${metrics.largestFrameBytes}`,
    '# TYPE ra_relay_frame_limit_bytes gauge', `ra_relay_frame_limit_bytes ${MAX_FRAME_BYTES}`,
    '# TYPE ra_relay_wire_frame_limit_bytes gauge', `ra_relay_wire_frame_limit_bytes ${MAX_WIRE_FRAME_BYTES}`,
    // 带 label 的两个家族：TYPE 行必须**只出现一次**，不能跟着样本一起循环发
    // （重复 TYPE 行不是合法 Prometheus 文本；初版就是循环里发的，已由测试反证）。
    '# TYPE ra_relay_dropped_by_reason_total counter',
    '# TYPE ra_relay_ws_close_total counter'
  ];
  for (const [reason, entry] of [...metrics.droppedByReason].sort((a, b) => b[1].count - a[1].count)) {
    lines.push(`ra_relay_dropped_by_reason_total{reason="${reason}"} ${entry.count}`);
  }
  for (const [key, entry] of [...metrics.closesByCode].sort((a, b) => b[1].count - a[1].count)) {
    const [peer, code] = key.split(':');
    lines.push(`ra_relay_ws_close_total{peer="${peer}",code="${code}"} ${entry.count}`);
  }
  lines.push('');
  res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
  res.end(lines.join('\n'));
}


/**
 * 中继的未路由提示页：区分三种情况，让用户自助定位，而不是只看到一句「未就绪」。
 *   ① 有连接器在线 + 裸访问根路径 → 说明需要先在桌面端生成配对链接
 *   ② 无连接器在线 → 桌面 DSH 的连接器没连上（提示检查面板徽章）
 *   ③ 带了配对参数但无人接 → 链接过期或被替换
 */
function renderRelayHint({ hasConnector, path }) {
  const isBare = path === '/' || path === '';
  const title = hasConnector ? '需要配对链接' : 'DSH 连接器不在线';
  const body = isBare
    ? (hasConnector
      ? '本中继已连接到一个 DSH 实例，但本页面没有携带配对/设备凭据。<br><br>请在桌面端 DSH 打开「<b>手机远程</b>」面板（右下角悬浮按钮），点「生成配对二维码」，然后用手机扫描二维码打开——那才是正确的入口。'
      : '桌面端 DSH 没有连上中继。<br><br>请在桌面端打开「<b>手机远程</b>」面板确认状态徽章是「已连接」；若显示「待机」或「重试中」，检查插件配置里的 relayUrl / relayToken 是否与中继一致，然后重启 DSH。')
    : '该配对链接已失效或已被替换。<br><br>配对链接 2 分钟内有效且一次性使用。请在桌面端「<b>手机远程</b>」面板重新生成。<br><br><button onclick="location.reload()" style="margin-top:1rem;padding:.6rem 1.1rem;border:1px solid #2f81f7;background:#2f81f7;color:#fff;border-radius:.5rem;font-size:.95rem;cursor:pointer">重新加载本页</button>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH 远程访问</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#0e1116;color:#e6e8eb;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:1.5rem;box-sizing:border-box">
<main style="max-width:28rem;line-height:1.75"><h1 style="font-size:1.35rem;margin:0 0 1rem">${title}</h1><p style="color:#9aa4b2;margin:0">${body}</p></main></body></html>`;
}

function handlePhoneHttp(req, res) {
  console.error(`[ra-relay][dbg] +${Date.now() % 100000} req ${req.method} ${req.url}`);
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/healthz') return handleHealth(res);
  if (url.pathname === '/metrics') return handleMetrics(res);
  // ★ 只对 HTML/API 禁止缓存（配对页、状态接口必须新鲜）；静态资源放行浏览器缓存。
  //   真机事故 2026-10-01：全局 no-store 导致 57 个客户端模块（~10MB）每次刷新全量重下，
  //   经隧道要 100+ 秒 → 表现为「同步很慢」。资源 URL 带 ?rev= 指纹，可安全长缓存。
  const isAsset = /\/(assets|plugins)\/|\.(js|mjs|css|map|woff2?|ttf|png|jpe?g|svg|webp|ico|wasm)(\?|$)/i.test(url.pathname);
  if (!isAsset) {
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('pragma', 'no-cache');
  }
  metrics.httpRequests += 1;
  const routed = connectorFor(req, url);
  console.error(`[ra-relay][dbg] +${Date.now() % 100000} routed ${req.url} → cid=${routed?.ws ? connectorIdOf(routed.ws) : 'NULL'}`);
  if (!routed?.ws) {
    // 诊断：未路由请求记录关键事实（不含敏感值），便于定位是 c 缺失/错配还是连接器离线。
    const rawCookie = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
    const hasDeviceCookie = /(^|;\s*)ra-device=/.test(rawCookie);
    console.log(`[ra-relay] 未路由 ${req.method} ${url.pathname} c=${url.searchParams.get('c') ?? '(无)'} cookieHint=${routeHintFromCookie(req.headers.cookie) ?? '(无)'} hasRaDevice=${hasDeviceCookie} cookieNames=[${rawCookie.split(';').map((s) => s.split('=')[0].trim()).filter(Boolean).join(',')}] connectors=${connectors.size} devices=${devices.size}`);
    // ★ 兜底：带了 ra-device 但解析失败（例如旧格式票据）—— 不能在这里「路由」。
    //   真机事故 2026-10-02：这里原本写的是 `return { ws: first[1], deviceId: 'pair' };`
    //   但本函数返回 void（第 780 行 handler 直接丢弃返回值），且**没有任何 res 写入** ——
    //   于是请求既不转发也不应答，socket 上什么都不发生，手机一直转到超时
    //   （实测 HTTP 000 / 12s，连试三次全中；不带 cookie 同一 URL 立刻 401）。
    //   这正是「配对完成后卡在进入 DSH」的第二种成因：票据在设备表里查不到路由键时，
    //   旧实现把请求吞掉了。正确做法是**应答**，让客户端立刻拿到可读结论而不是挂死：
    //   设备票据由连接器验签裁决，但连接器都还没收到请求，谈不上裁决。
    //   直接回 401 配对引导（与连接器侧 pairRequiredPage 的语义一致）。
    if (hasDeviceCookie && connectors.size > 0) {
      metrics.rejected += 1;
      console.log(`[ra-relay] ra-device 无法解析为路由键且非单连接器兜底场景 → 401 配对引导（不再静默吞掉请求）`);
      res.writeHead(401, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
        pragma: 'no-cache'
      });
      res.end(renderRelayHint({ hasConnector: true, path: url.pathname }));
      return;
    }
    metrics.rejected += 1;
    res.writeHead(503, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      pragma: 'no-cache',
      expires: '0',
      vary: '*'
    });
    res.end(renderRelayHint({ hasConnector: connectors.size > 0, path: url.pathname }));
    return;
  }
  const connector = routed.ws;
  const routeDeviceId = routed.deviceId;
  const streamId = randomUUID();
  const chunks = [];
  let size = 0;
  let aborted = false;
  let settled = false;

  // ★ 看门狗只覆盖「等连接器回应」阶段；一旦响应头到达就清除（流式/长请求可能远超此值）。
  //   旧实现的 30s 会在长请求上误杀，表现为 Cloudflare 524 / context canceled / EOF
  //   （真机事故 2026-09-30：DSH 的 /api/session/list 等接口响应较慢）。
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    streams.delete(streamId);
    res.writeHead(504, { 'content-type': 'text/plain' });
    res.end('connector timeout');
  }, REQUEST_TIMEOUT_MS);

  res.on('close', () => {
    // close 在响应正常结束后也会触发；这里只清理**尚未拿到响应头**的挂起流，
    // 避免把仍在途的连接器响应误判为取消。
    clearTimeout(timer);
    if (!settled) streams.delete(streamId);
    else streams.delete(streamId);
  });
  req.on('error', () => streams.delete(streamId));
  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      clearTimeout(timer);
      streams.delete(streamId);
      res.writeHead(413, { 'content-type': 'text/plain' });
      res.end('body too large for relay');
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (aborted) return;
    const body = Buffer.concat(chunks);
    streams.set(streamId, { res, connectorId: routeDeviceId, resourceUrl: req.url ?? '/' });
    const head = {
      kind: 'http-head',
      deviceId: routeDeviceId,
      streamId,
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: {
        cookie: typeof req.headers.cookie === 'string' ? req.headers.cookie : '',
        'content-type': typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : '',
        // ★ 客户端是否接受 gzip —— 连接器据此决定是否压缩响应（DSH 桌面壳覆盖了
        //   webserver 的 compression 配置，上游不压缩，由连接器补做以降低隧道传输量）。
        //   这是中继→连接器的内部头，不经代理白名单，不影响「转发给 DSH 的头集合」契约。
        'accept-encoding': typeof req.headers['accept-encoding'] === 'string' ? req.headers['accept-encoding'] : ''
      }
    };
    const headSent = send(connector, head);
    console.error(`[ra-relay][dbg] +${Date.now() % 100000} head sent ${req.url} → ok=${headSent}`);
    if (!headSent) {
      clearTimeout(timer);
      streams.delete(streamId);
      if (!settled) {
        settled = true;
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('connector offline');
      }
      return;
    }
    // 分片发送（≤256KiB 原始字节，避免超 1 MiB 帧上限被静默丢弃）；空 body 也发 final 帧。
    const CHUNK = 256 * 1024;
    for (let offset = 0; offset < body.length || offset === 0; offset += CHUNK) {
      const piece = body.subarray(offset, offset + CHUNK);
      const final = offset + CHUNK >= body.length;
      if (!send(connector, { kind: 'http-body', deviceId: routeDeviceId, streamId, chunk: piece.toString('base64url'), final })) break;
      if (final) break;
    }
  });
}

// ---- WebSocket 面 ----

// maxPayload 用【线上帧上限】而非应用层上限 —— 见 MAX_WIRE_FRAME_BYTES 的说明。
// ★ perMessageDeflate 实际只压**手机浏览器**的流量：/connector 的连接器握手虽也经
//   此 wss，但连接器是 Node 内置 WebSocket（undici），不实现 pmd，握手时不带
//   pmd 扩展头，协商自然不成立 —— 配置对它无副作用。assistant 实时流（平均
//   29KB/条 assistant/message）走 base64 JSON 帧全程无压缩，是「同步不跟手」的
//   主因之一（真机 2026-10-02）；pmd 在中继↔手机这段把 JSON 文本压回 ~15–25%。
//   threshold：<1KB 的帧不值得压（控制帧/小 RPC 占多数，避免 CPU 空转）。
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_WIRE_FRAME_BYTES,
  perMessageDeflate: {
    threshold: 1024,
    noDelay: true
  }
});

function bearerFromProtocols(protocols) {
  for (const proto of protocols ?? []) {
    if (typeof proto === 'string' && proto.startsWith('ra-bearer.')) return proto.slice('ra-bearer.'.length);
  }
  return null;
}

function handleUpgrade(req, socket, head) {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/connector') {
    const token = bearerFromProtocols(req.headers['sec-websocket-protocol']?.split(/,\s*/)) ?? url.searchParams.get('token');
    if (RELAY_TOKENS.size > 0 && (!token || !RELAY_TOKENS.has(token))) {
      metrics.rejected += 1;
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnector(ws, url));
    return;
  }
  // 手机侧：任意路径的升级（/device 信令通道，或 /api/remote.mux 等 PWA WS）都桥到 connector。
  wss.handleUpgrade(req, socket, head, (ws) => onPhoneSocket(ws, url, req));
}

function onConnector(ws, url) {
  const connectorId = url.searchParams.get('c');
  if (!connectorId) {
    ws.close(4400, 'missing connector id');
    return;
  }
  metrics.connectorConnects += 1;
  connectors.get(connectorId)?.close(4000, 'replaced');
  connectors.set(connectorId, ws);
  connectorAlive.set(ws, true);
  ws.on('pong', () => connectorAlive.set(ws, true));
  for (const entry of devices.values()) {
    if (entry.connectorId === connectorId) entry.connectorId = connectorId; // 重连后路由已由 key 对齐
  }
  // hello-ack 恒宣告 'bin'（中继单方面支持）。真正启用二进制承载的判据是
  //   binCaps（连接器 hello 宣告过 bin 才登记）—— 双向各自的发送路径独立查表。
  //   'claim' 宣告 Pair-Proof 支持：连接器只在 caps 含 'claim' 时才发 device-claim
  //   （旧中继对未知 kind 会 1002 断连重连 —— 绝不能盲发）。
  send(ws, { kind: 'hello-ack', proto: 1, caps: ['http', 'ws', 'pair', 'auth', 'bin', 'claim'] });

  // ★ maxPayload === MAX_FRAME_BYTES，所以超大帧会在 ws 解析层就被拒并抛 error，
  //   根本走不到下面那句 data.length 检查（那句实际是死代码，保留作二道防线）。
  //   没有 error 处理时，这个 error 只能被全局 uncaughtException 兜住 ——
  //   连接死了、断在哪、死因是什么，全部丢失。这是 P0 里最关键的一个补点。
  ws.on('error', (error) => {
    recordDrop('ws_error', {
      peer: 'connector',
      connectorId: connectorId.slice(0, 12),
      code: error?.code ?? null,
      message: String(error?.message ?? error).slice(0, 200)
    });
  });

  ws.on('message', (data, isBinary) => {
    noteFrame(data.length);
    const limit = isBinary ? MAX_WIRE_FRAME_BYTES : MAX_FRAME_BYTES;
    if (data.length > limit) {
      recordDrop('inbound_frame_too_large', { dir: 'connector', size: data.length, limit });
      return;
    }
    let frame;
    try {
      // ★ 二进制消息 = 二进制承载帧（仅当该连接器协商过 'bin' 才可能合法出现）。
      if (isBinary) {
        if (!binCaps.has(ws)) return recordDrop('bin_frame_unnegotiated', { dir: 'connector', size: data.length });
        frame = decodeBinFrame(data);
      } else {
        frame = JSON.parse(data.toString('utf8'));
      }
    } catch (error) {
      recordDrop(isBinary ? 'bad_bin_frame' : 'bad_json', { dir: 'connector', size: data.length, message: String(error?.message ?? '').slice(0, 120) });
      ws.close(1002, isBinary ? 'bad binary frame' : 'bad json');
      return;
    }
    relayConnectorFrame(ws, frame);
  });

  ws.on('close', (code, reason) => {
    recordClose('connector', code, reason);
    if (connectors.get(connectorId) === ws) connectors.delete(connectorId);
    publishedDevices.delete(connectorId); // 该连接器的权威设备表随之下线（条目已在下面清掉）
    for (const [deviceId, entry] of [...devices]) {
      if (entry.connectorId === connectorId) {
        for (const phone of entry.phones) {
          if (phone.readyState === 1) phone.close(1001, 'connector offline');
        }
        devices.delete(deviceId);
      }
    }
    for (const [streamId, stream] of [...streams]) {
      if (stream.connectorId !== connectorId && stream.res === undefined && stream.phone === undefined) continue;
      // 只清理属于该 connector 的挂起项：http 流用 res，PWA 桥用 phone。
      const isThisConnector = (stream.connectorId === connectorId) || (stream.res !== undefined);
      if (!isThisConnector) continue;
      clearTimeout(stream.timer);
      if (stream.res && !stream.res.destroyed) {
        stream.res.writeHead(502, { 'content-type': 'text/plain' });
        stream.res.end('connector disconnected');
      }
      if (stream.phone && stream.phone.readyState === 1) stream.phone.close(1001, 'connector offline');
      streams.delete(streamId);
    }
  });
}

/** Connector → 手机方向帧路由。 */
/** 反查某连接器 ws 对应的 connectorId。 */
function connectorIdOf(ws) {
  for (const [id, sock] of connectors) if (sock === ws) return id;
  return null;
}

function relayConnectorFrame(connectorWs, frame) {
  const kind = frame.kind;
  if (kind === 'http-res-head' || kind === 'http-res-body' || kind === 'http-error') {
    const stream = streams.get(frame.streamId);
    if (!stream?.res || stream.res.destroyed) {
      streams.delete(frame.streamId);
      return;
    }
    if (kind === 'http-res-head') {
      clearTimeout(stream.timer);
      const headers = { ...(frame.headers ?? {}) };
      if (!headers['content-type']) headers['content-type'] = 'application/octet-stream';
      // ★ 带指纹的资源（?rev=xxx / /assets/xxx-hash.js）允许浏览器强缓存：
      //   内容是内容寻址的，换版本必换 URL，因此可 immutable。这直接消除
      //   「每次刷新重下 0.4MB+、经隧道要 20s」的核心痛点（真机 2026-10-01）。
      const url = stream.resourceUrl || '';
      const fingerprint = /(?:\?|&)rev=/.test(url) || /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\./.test(url);
      if (fingerprint && !frame.headers?.['cache-control']) {
        headers['cache-control'] = 'public, max-age=31536000, immutable';
      }
      stream.pendingHeaders = headers;
      stream.res.writeHead(frame.status ?? 502, headers);
      return;
    }
    if (kind === 'http-res-body') {
      const chunk = Buffer.from(frame.chunk ?? '', 'base64url');
      metrics.bytesRelayed += chunk.length;
      if (frame.final) {
        stream.res.end(chunk);
        streams.delete(frame.streamId);
      } else {
        stream.res.write(chunk);
      }
      return;
    }
    // 业务错误按插件给的 status 回（4xx），仅真正未知回 502 —— 避免被 Cloudflare 用
    // 自有 HTML 覆盖而让前端 JSON 解析崩溃。
    const status = Number.isInteger(frame.status) && frame.status >= 400 && frame.status < 500 ? frame.status : 502;
    stream.res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    stream.res.end(JSON.stringify({ error: frame.code ?? 'relay/error', message: frame.message ?? '' }));
    streams.delete(frame.streamId);
    return;
  }
  if (kind === 'ws-data' || kind === 'ws-close') {
    const stream = streams.get(frame.streamId);
    if (!stream?.phone) return;
    if (kind === 'ws-data') {
      const payload = Buffer.from(frame.data ?? '', 'base64url');
      noteFrame(payload.length);
      metrics.bytesRelayed += payload.length;
      if (stream.phone.readyState !== 1) {
        recordDrop('downlink_phone_not_open', { streamId: frame.streamId, readyState: stream.phone.readyState, size: payload.length });
        return;
      }
      // ★ 下行流控：手机消费慢时 ws 内部会排队，无上限则内存膨胀。
      //   超过上限即关闭该桥（让客户端重连并靠 session 游标追平，而不是无限积压）。
      //   ⚠ 但这正是 revision 跳号的触发场景之一：断桥 → 客户端重连 → resume。
      //     P0 先让它可数可见；是否改语义（换关闭码 / 让客户端重取 snapshot）等数据说话。
      if (stream.phone.bufferedAmount > MAX_PHONE_BUFFER_BYTES) {
        recordDrop('downlink_backpressure', {
          streamId: frame.streamId,
          bufferedAmount: stream.phone.bufferedAmount,
          limit: MAX_PHONE_BUFFER_BYTES,
          size: payload.length
        });
        try { stream.phone.close(1013, 'downlink backpressure'); } catch { /* ignore */ }
        streams.delete(frame.streamId);
        return;
      }
      stream.phone.send(payload, { binary: frame.opcode !== 1, fin: frame.fin !== false });
      return;
    }
    if (stream.phone.readyState === 1) stream.phone.close(frame.code ?? 1000, 'connector closed');
    streams.delete(frame.streamId);
    return;
  }
  if (kind === 'pair-result' || kind === 'pair-challenge' || kind === 'auth-challenge' || kind === 'auth-result') {
    const key = kind === 'pair-result' ? `pair:${frame.channel}` : `ch:${frame.channel}`;
    const stream = streams.get(key);
    if (stream?.phone) send(stream.phone, frame);
    return;
  }
  if (kind === 'device-claim') {
    // ★ Pair-Proof（2026-10-02 审查定稿）：配对凭证验签 —— 归属从「声明」升格为
    //   「密码学事实」。连接器转发手机在配对时对 (challenge ‖ connectorId ‖ ts)
    //   的 Ed25519 签名原件；中继用帧内 pubKey 自主验签。
    //   防伪造: sig 只有持有手机私钥者能产生；pubKey 与 deviceId 自绑死
    //   （sha256(pubKey) 的 b64url 前 22 字符 == deviceId），拿自己的公钥只能
    //   认领一个无意义的新 id。防重放漂移: 签名内容绑定 challenge + connectorId，
    //   同一凭证对「别的连接器」永远验不过。
    const ownerConnId = connectorIdOf(connectorWs);
    const claim = frame;
    // ① 公钥与 deviceId 自绑
    const derived = createHash('sha256').update(Buffer.from(claim.pubKey, 'base64')).digest();
    const derivedId = Buffer.from(derived).toString('base64url').slice(0, 22);
    if (CLAIM_PUBKEY_ID_BIND && derivedId !== claim.deviceId) {
      recordDrop('claim_id_mismatch', { deviceId: claim.deviceId.slice(0, 12), derived: derivedId.slice(0, 12) });
      return;
    }
    // ② 验签：消息字节串必须与手机端一致（admin/panel.js: ASCII 拼接 challenge+connectorId+ts）
    //    连接器签名时用的是自己的 fingerprint —— 签名里的 connectorId 与发送者身份绑定
    const expectedOwner = ownerConnId;
    if (!expectedOwner) return;
    const msg = Buffer.concat([
      Buffer.from(claim.challenge, 'utf8'),
      Buffer.from(expectedOwner, 'utf8'),
      Buffer.from(String(claim.ts), 'utf8')
    ]);
    let ok = false;
    try {
      const pubRaw = Buffer.from(claim.pubKey, 'base64');
      const jwk = { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(pubRaw).toString('base64url') };
      ok = edVerify(null, msg, createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(claim.sig, 'base64url'));
    } catch { ok = false; }
    if (!ok) {
      recordDrop('claim_verify_failed', { deviceId: claim.deviceId.slice(0, 12) });
      return;
    }
    // ③ 验签通过 → 写归属（最后有效 claim 胜：换机重配会产生新 claim 覆盖旧归属）
    const prev = deviceOwners.get(claim.deviceId);
    deviceOwners.set(claim.deviceId, { connectorId: expectedOwner, challenge: claim.challenge, sig: claim.sig, ts: claim.ts, pubKey: claim.pubKey });
    persistOwners();
    if (prev && prev.connectorId !== expectedOwner) {
      console.log(`[ra-relay] 设备归属迁移: deviceId=${claim.deviceId.slice(0, 12)} ${prev.connectorId.slice(0, 8)} → ${expectedOwner.slice(0, 8)}（新 claim 覆盖）`);
    }
    console.log(`[ra-relay] 设备归属确认: deviceId=${claim.deviceId.slice(0, 12)} → ${expectedOwner.slice(0, 8)}`);
    return;
  }
  if (kind === 'devices') {
    // 连接器上报已配对设备：更新路由表。
    // ★ Pair-Proof 语义（2026-10-02 审查后定稿）: 有 claim（owners 表）记录的设备
    //   只认 owner；无 claim 的设备维持【最后上报者赢】（向后兼容旧连接器）。
    const ids = Array.isArray(frame.deviceIds) ? frame.deviceIds : [];
    const connectorId = connectorIdOf(connectorWs);
    if (connectorId) {
      // ★ 先登记「权威设备表」：条目该不该留以它为准（见 publishedDevices）。
      publishedDevices.set(connectorId, new Set(ids.filter((id) => typeof id === 'string' && id.length > 0)));
      // 清理该连接器下已不再上报的设备
      for (const [deviceId, entry] of [...devices]) {
        if (entry.connectorId === connectorId && !ids.includes(deviceId) && entry.phones.size === 0) {
          devices.delete(deviceId);
        }
      }
      let rejected = 0;
      for (const deviceId of ids) {
        if (typeof deviceId !== 'string' || deviceId.length === 0) continue;
        // ★ 有密码学归属的设备：只认 owner 连接器的上报；他人的上报直接忽略
        const owner = deviceOwners.get(deviceId);
        if (owner && owner.connectorId !== connectorId) {
          rejected++;
          if (!conflictLogged.has(deviceId + ':' + connectorId)) {
            console.log(`[ra-relay] 拒绝无凭证的设备路由声明: deviceId=${deviceId.slice(0, 12)} 归属 ${owner.connectorId.slice(0, 8)}，来源 ${connectorId.slice(0, 8)}`);
            conflictLogged.add(deviceId + ':' + connectorId);
          }
          continue;
        }
        const existing = devices.get(deviceId);
        if (existing) {
          // 无 claim 的设备维持【最后上报者赢】+ 冲突日志可观测
          if (existing.connectorId !== connectorId && !conflictLogged.has(deviceId + ':' + connectorId)) {
            console.log(`[ra-relay] 设备路由冲突（无 claim）: deviceId=${deviceId.slice(0, 12)} 由 ${existing.connectorId.slice(0, 8)} 改归 ${connectorId.slice(0, 8)}`);
            conflictLogged.add(deviceId + ':' + connectorId);
          }
          existing.connectorId = connectorId;
        } else {
          devices.set(deviceId, { connectorId, phones: new Set() });
        }
      }
      console.log(`[ra-relay] 设备路由表更新：connector=${connectorId.slice(0, 8)} devices=${ids.length}${rejected ? `（拒绝他人 owned ${rejected} 条）` : ''}`);
    }
    return;
  }
  if (kind === 'kick') {
    const entry = devices.get(frame.deviceId);
    if (entry) {
      for (const phone of entry.phones) {
        if (phone.readyState === 1) phone.close(4403, 'device revoked');
      }
      devices.delete(frame.deviceId);
    }
    // ★ Pair-Proof：kick 同时清除归属（撤销 = owner 事实消除；重配对产生新 claim）。
    deviceOwners.delete(frame.deviceId);
    persistOwners();
    return;
  }
  if (kind === 'hello') {
    // ★ caps 'bin' 协商：连接器宣告且中继支持 → 双向启用二进制承载帧。
    if (Array.isArray(frame.caps) && frame.caps.includes('bin')) binCaps.add(connectorWs);
    return;
  }
  // ping / pong / 未知帧：中继不裁定协议，静默计数。
}

function onPhoneSocket(ws, url, req) {
  metrics.phoneConnects += 1;
  const cParam = url.searchParams.get('c');
  const routed = connectorFor(req, url) ?? (cParam && connectors.has(cParam) ? { ws: connectors.get(cParam), deviceId: 'pair' } : null);
  if (!routed?.ws) {
    ws.close(4503, 'connector offline');
    return;
  }
  // ★ 真实 connectorId 只能从**已解析出的 socket** 反查，不能取 URL 的 c 参数。
  //   真机事故 2026-10-02：浏览器建 WS 用相对路径 `/api/remote.mux`（**不带 c**），
  //   于是 `url.searchParams.get('c')` 为 null；而下面第 696 行拿它跟
  //   `entry.connectorId`（真实指纹）比较，`"0cb0526a…" !== null` 恒真 →
  //   每次手机建 WS 都被判成「换连接器了」→ 重建 entry 并**覆盖掉该设备原有登记**。
  //   后果是自我破坏的：手机一连实时通道，自己就被挤出路由表，随后所有不带 c 的
  //   请求（首页 + 全部 assets）全 401 → 界面能开但**数据不再实时同步**；
  //   且下次刷新又白屏。因果已实测：WS 前 HTTP 200 ✓ → 建一次 WS → WS 后 HTTP 401 ✗。
  const connectorId = connectorIdOf(routed.ws) ?? cParam;
  const claimedDeviceId = url.searchParams.get('d') ?? routeHintFromCookie(req.headers.cookie) ?? `pair-${randomUUID().slice(0, 8)}`;
  const channel = url.searchParams.get('ch');
  const connector = routed.ws;

  // ★ 认证收紧（2026-10-02 审查 P0-3）：?d= 与 ?c= 都是未认证的 URL 参数，旧逻辑
  //   允许任意公网客户端借一个在线 connectorId 改写【已发布设备】的路由（实测
  //   route-hijack.probe.mjs：无需 token、无需签名即可实时劫持 + 断连删条目）。
  //   收紧后：真实设备条目（任一连接器权威上报过）只能由「归属连接器自身」的
  //   连接建立来登记/触碰；别人的设备一律不写表 —— 该 socket 若真持有效票据，
  //   连接器侧验票后由 ws-data/ws-open 正常桥接，不受影响；若没有，本就进不来。
  //   pair-<random> 临时条目（配对信令）与未发布设备维持原语义。
  const publishedOwner = (() => {
    for (const [connId, set] of publishedDevices) {
      if (set.has(claimedDeviceId)) return connId;
    }
    return null;
  })();
  if (publishedOwner && publishedOwner !== connectorId) {
    console.log(`[ra-relay] 拒绝未认证路由改写：deviceId=${claimedDeviceId.slice(0, 12)} 属 ${publishedOwner.slice(0, 8)}，来路连接器=${String(connectorId).slice(0, 8)}`);
    recordDrop('route_hijack_blocked', { deviceId: claimedDeviceId.slice(0, 12), owner: publishedOwner.slice(0, 8), via: String(connectorId).slice(0, 8) });
    ws.close(4403, 'device belongs to another connector');
    return;
  }

  let entry = devices.get(claimedDeviceId);
  if (!entry || entry.connectorId !== connectorId) {
    // 新设备或换连接器（换机/重连到另一实例）：重建登记。
    //   connectorId 修正后，同一设备+同一连接器的重复连接会走「entry 保留」分支，
    //   不再覆盖登记，也就不会丢掉 entry.phones（kick/断线时要逐个 close 的通道集合）。
    entry = { connectorId, phones: new Set() };
    devices.set(claimedDeviceId, entry);
  }
  if (entry.phones.size >= MAX_PHONE_PER_DEVICE) {
    ws.close(4429, 'too many connections');
    return;
  }
  entry.phones.add(ws);
  phoneAlive.set(ws, true);
  ws.on('pong', () => phoneAlive.set(ws, true));

  // 信令通道（/device?ch=）：pair/auth 帧按 channel 回路。
  if (url.pathname === '/device' && channel) {
    streams.set(`ch:${channel}`, { phone: ws });
    streams.set(`pair:${channel}`, { phone: ws });
  }

  // PWA WS 桥：升级即开桥（手机 101 已完成；数据泵开始）。
  if (url.pathname !== '/device') {
    const streamId = randomUUID();
    metrics.wsBridges += 1;
    streams.set(streamId, { phone: ws });
    send(connector, {
      kind: 'ws-open',
      deviceId: claimedDeviceId,
      streamId,
      path: req.url ?? '/',
      headers: { cookie: typeof req.headers.cookie === 'string' ? req.headers.cookie : '' }
    });
    ws.on('error', (error) => {
      recordDrop('ws_error', {
        peer: 'phone',
        code: error?.code ?? null,
        message: String(error?.message ?? error).slice(0, 200)
      });
    });
    ws.on('message', (data, isBinary) => {
      noteFrame(data.length);
      // ★ 这里以前也是静默 return —— 手机上行超过 512KB 就无声消失（P0 补上出处）。
      if (data.length > 512 * 1024) {
        recordDrop('uplink_frame_too_large', { dir: 'phone', size: data.length, limit: 512 * 1024, streamId });
        return;
      }
      // ★ 上行帧必须检查发送结果：失败即关桥（客户端重连后用游标追平），
      //   绝不静默丢弃 —— 丢一帧就会让 assistant-stream 的 revision 断档。
      const okSent = send(connector, {
        kind: 'ws-data',
        deviceId: claimedDeviceId,
        streamId,
        fin: true,
        opcode: isBinary ? 2 : 1,
        data: Buffer.from(data).toString('base64url')
      });
      if (!okSent) {
        // send() 内部已 recordDrop（socket_not_open / outbound_frame_too_large / socket_buffer_full），
        // 这里只负责断桥决策。
        try { ws.close(1013, 'uplink backpressure'); } catch { /* ignore */ }
        streams.delete(streamId);
      }
    });
    ws.on('close', (code, reason) => {
      recordClose('phone', code, reason);
      send(connector, { kind: 'ws-close', deviceId: claimedDeviceId, streamId, code: 1000 });
      streams.delete(streamId);
    });
  }

  ws.on('message', (data, isBinary) => {
    // /device 信令帧：opaque 直通（pair-begin/auth-begin/sealed 等）。
    // ★ 保持 JSON 文本-only：信令帧小且字段杂，二进制无收益；PWA 配对页/未来 thin
    //   client 均未实现 bin 编码，此处若放开会破坏兼容（bin 协商只覆盖 connector 面）。
    if (url.pathname !== '/device') return; // 非信令路径由上面那条 handler 处理，不是丢帧
    if (isBinary) return recordDrop('device_binary_frame', { size: data.length, channel });
    noteFrame(data.length);
    if (data.length > MAX_FRAME_BYTES) {
      return recordDrop('device_frame_too_large', { size: data.length, limit: MAX_FRAME_BYTES, channel });
    }
    let frame;
    try {
      frame = JSON.parse(data.toString('utf8'));
    } catch {
      return recordDrop('bad_json', { dir: 'phone-device', size: data.length, channel });
    }
    if (!frame || typeof frame !== 'object') return;
    frame.deviceId = frame.deviceId ?? claimedDeviceId;
    send(connector, frame);
  });
  ws.on('close', (code, reason) => {
    recordClose('phone', code, reason);
    entry.phones.delete(ws);
    phoneAlive.set(ws, false);
    if (entry.phones.size === 0 && devices.get(claimedDeviceId) === entry) {
      // ★ 只回收「没有权威依据」的条目（未上报的 ad-hoc 声称、`d=` 临时 id）；
      //   连接器上报过的设备条目必须留在表里 —— 否则手机一关，它自己就再也回不来，
      //   见 publishedDevices 的说明（真机事故 2026-10-02：界面一直显示重新连接）。
      const published = publishedDevices.get(entry.connectorId)?.has(claimedDeviceId) === true;
      if (!published) devices.delete(claimedDeviceId);
    }
    if (channel) {
      streams.delete(`ch:${channel}`);
      streams.delete(`pair:${channel}`);
    }
  });
}

// ---- 装配 ----

const handler = (req, res) => handlePhoneHttp(req, res);
const server = process.env.TLS_KEY && process.env.TLS_CERT
  ? https.createServer({ key: readFileSync(process.env.TLS_KEY), cert: readFileSync(process.env.TLS_CERT) }, handler)
  : http.createServer(handler);
server.on('upgrade', handleUpgrade);
// HOST 环境变量可限定绑定面（本机自测建议 127.0.0.1，避免把 dev 模式中继暴露到局域网）。
const HOST = process.env.HOST || undefined;
server.listen(PORT, HOST, () => {
  const proto = process.env.TLS_KEY ? 'wss/https' : 'ws/http（开发模式，生产必须配 TLS）';
  const bound = server.address()?.port ?? PORT;
  console.log(`[ra-relay] listening on ${HOST ?? '0.0.0.0'}:${bound} (${proto}); tokens=${RELAY_TOKENS.size ? 'configured' : 'OPEN — 仅限本地开发'}`);
});
