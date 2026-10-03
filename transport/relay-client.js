/**
 * 出站传输：Connector → 中继的 WSS 客户端（ADR-001 纯出站；本机零入站端口）。
 *
 * - 用 Node 22 全局 WebSocket（零外部导入）。Bearer 令牌走 Sec-WebSocket-Protocol
 *   子协议（`ra-bearer.<token>`），不进 URL（不落中继访问日志）。
 * - 重连：指数退避 1s→30s + 抖动；hello-ack 后重置。kill switch（admin）置 killed。
 * - 职责：帧路由 + 设备会话状态 + 配对/鉴权帧处理；HTTP 转发核心在 reverse-proxy，
 *   WS 桥在 upgrade.js —— 本文件不碰 ctx.*（定时器安全纪律⑤）。
 */
import { decodeFrame, encodeFrame, decodeBinFrame, encodeBinFrame, isBinEligible, b64d, b64e, MAX_CHUNK_BYTES } from './frames.js';
import { deviceCookieFrom } from '../identity/pairing.js';
import { newChallenge } from '../identity/ticket.js';
import { forwardRequest } from '../proxy/reverse-proxy.js';
import { openLoopbackBridge } from '../proxy/upgrade.js';
import { canonicalizeTarget } from '../policy/methods.js';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;
const HELLO_ACK_TIMEOUT_MS = 10_000;
const MAX_SEND_BUFFER_BYTES = 8 * 1024 * 1024;
/** 单请求体聚合上限（PWA 模式；上传被策略层默认拒绝，此上限只防滥用）。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** 子协议 token 允许的字符（RFC7230 token 子集）；不满足则退化为 URL 查询参数。 */
const SAFE_TOKEN = /^[A-Za-z0-9._~-]+$/;

/** 客户端 WebSocket API 允许的线上 close code；协议语义映射到私有 4xxx。 */
function toClientCloseCode(code) {
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  // RFC 控制码映射到可发送的私有码；其它异常输入统一落到合法上界。
  if (Number.isInteger(code) && code >= 1001 && code <= 1015) return 4000 + (code - 1000);
  return 4999;
}

/** close reason 按 WebSocket 的 123 字节上限截断，而不是按字符数猜测。 */
function clientCloseReason(reason) {
  const text = String(reason ?? '');
  if (!text) return undefined;
  let out = text;
  while (Buffer.byteLength(out, 'utf8') > 123) out = out.slice(0, -1);
  return out || undefined;
}

/** 挑战应答会话的保留时长（票据时间窗是 ±60s，5 分钟足够宽裕）。 */
const AUTH_CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** 未完成挑战的上限（防已认证设备刷帧把 Map 撑大）。 */
const AUTH_CHALLENGE_MAX = 256;

/**
 * ★ 把 ws 的 `event.data` 归一化成 Buffer（同步能转的转，转不了的返回 null）。
 *
 * 真机事故 2026-10-02（「刷新后又开始长时间重新连接中」的**直接根因**）：
 *   Node 内置 WebSocket（undici）的 `binaryType` 默认是 **'blob'** —— 中继一旦发
 *   二进制承载帧（载荷 ≥4096B 就切，见 frames.js 的 isBinEligible），event.data 就是 Blob。
 *   旧代码 `Buffer.from(event.data)` 对 Blob 立刻抛
 *   「The first argument must be of type string or an instance of Buffer, ArrayBuffer,
 *     or Array or an Array-like Object. Received an instance of Blob」，
 *   而 onmessage 的 catch 把**任何**解析异常都判成协议错误 → close(1002) + 重连。
 *   于是形成死循环：连上 → 中继发第一个大帧（session/list 451KB、mux opening snapshot…）
 *   → 立即断 → 1s 后重连 → 再断……界面永远停在「重新连接中」。
 *   **刷新治不了**：刷新只是把这个循环从头再跑一遍。
 *   审计铁证：`relay.protocol-error … Received an instance of Blob`（audit.jsonl）。
 *
 * 修法必须两层，缺一不可：
 *   ① 建连时显式 `binaryType='arraybuffer'`（支持的运行时直接绕开 Blob）；
 *   ② 解码口仍然兼容 Blob/ArrayBuffer/TypedArray —— 绝不依赖①生效
 *      （旧运行时 / 浏览器 / 未来实现），否则同一类崩溃换个运行时又回来。
 */
export function binaryToBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null; // Blob 等异步形态：调用方 await arrayBuffer()
}

/** 二进制/文本消息 → Buffer（含 Blob 异步路径）。仅用于确知非字符串的入参。 */
async function dataToBuffer(data) {
  const sync = binaryToBuffer(data);
  if (sync) return sync;
  if (typeof data?.arrayBuffer === 'function') return Buffer.from(await data.arrayBuffer());
  throw new TypeError(`unsupported ws message type: ${Object.prototype.toString.call(data)}`);
}

/** 审计用路径：只保留 pathname 形态（去 query/控制字符并截断）——审计文件会被面板完整展示。 */
function auditPathOf(raw) {
  const s = typeof raw === 'string' ? raw : '';
  const cut = s.split(/[?#]/, 1)[0];
  // eslint-disable-next-line no-control-regex
  return cut.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || '/';
}

export class RelayConnector {
  #deps;
  #ws = null;
  #state = 'standby';
  #retryAttempt = 0;
  #retryTimer = null;
  #retrySocket = null;
  #helloTimer = null;
  #disposed = false;
  #streams = new Map(); // streamId → { deviceId, method, path, headers, chunks: [], bytes, wsBridge? }
  #authChallenges = new Map(); // channel → challenge
  // ★ P0（2026-10-01）：framesDropped / dropsByReason 是新增的丢帧观测面。
  //   动因：客户端报「session assistant stream skipped revision N」时，连接器这一侧
  //   同样没有任何痕迹 —— send() 返回 false 无人看、#dropStream 只回了一个 http-error
  //   就结束。丢帧必须可数、可归因，否则「差一帧」永远只能靠猜。
  #metrics = {
    connects: 0, reconnects: 0, framesIn: 0, framesOut: 0, lastError: null, openedAt: 0,
    httpRequests: 0, wsBridges: 0, framesDropped: 0, dropsByReason: {}
  };
  #sealedCounters = new Map(); // deviceId → CounterState（thin client E2E，M2 协议面）
  #binNegotiated = false;      // 中继 hello-ack.caps 含 'bin' 后 true（二进制承载帧开关）
  #claimNegotiated = false;    // 中继 hello-ack.caps 含 'claim' 后 true（Pair-Proof 开关）

  constructor(deps) {
    // deps: { relayUrl, relayToken, connectorId, devices, tickets, pairing, policy, credential,
    //         keys, audit, logger, isKilled, onSendMetrics? }
    this.#deps = deps;
  }

  get state() {
    return this.#state;
  }

  get metrics() {
    return { ...this.#metrics, activeStreams: this.#streams.size, state: this.#state };
  }

  start() {
    if (this.#disposed) return;
    if (!this.#deps.relayUrl || this.#deps.isKilled?.()) {
      this.#state = this.#deps.isKilled?.() ? 'killed' : 'standby';
      return;
    }
    this.#connect();
  }

  dispose() {
    this.#disposed = true;
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#helloTimer);
    this.#retryTimer = null;
    this.#retrySocket = null;
    this.#closeSocket(1000, 'disposed');
    for (const stream of this.#streams.values()) {
      stream.abortController?.abort('relay disconnected');
      stream.wsBridge?.close();
    }
    this.#streams.clear();
    this.#state = 'standby';
  }

  /** 管理面用：撤销设备时把该设备的在线 WS/流全部踢掉。 */
  kickDevice(deviceId) {
    this.send({ kind: 'kick', deviceId });
    for (const [streamId, stream] of [...this.#streams]) {
      if (stream.deviceId === deviceId) {
        stream.wsBridge?.close();
        this.#streams.delete(streamId);
      }
    }
  }

  /** 记一次丢帧（P0）。落进 metrics，管理面板直接可见。 */
  #recordDrop(reason, detail) {
    this.#metrics.framesDropped += 1;
    this.#metrics.dropsByReason[reason] = (this.#metrics.dropsByReason[reason] ?? 0) + 1;
    this.#deps.logger?.warn?.(`[kite] 丢帧 reason=${reason}${detail ? ` ${JSON.stringify(detail)}` : ''}`);
    return false;
  }

  /** TransportAdapter.send（帧已过 encodeFrame/encodeBinFrame 由这里统一把关）。
   *  ★ 协商过 caps 'bin' 且帧适合二进制承载（大载荷）时走 ws 二进制消息，
   *    其余仍 JSON 文本 —— 对端不支持时自动全文本回退。 */
  send(frame) {
    if (!this.#ws || this.#ws.readyState !== 1) {
      // 以前这里是无条件的静默 `return false`，调用方普遍不检查 —— 帧就此消失。
      return this.#recordDrop('socket_not_open', { readyState: this.#ws?.readyState ?? null, kind: frame?.kind });
    }
    try {
      if (Number(this.#ws.bufferedAmount ?? 0) > MAX_SEND_BUFFER_BYTES) {
        return this.#recordDrop('socket_buffer_full', { bufferedAmount: this.#ws.bufferedAmount, kind: frame?.kind });
      }
      if (this.#binNegotiated && isBinEligible(frame)) {
        this.#ws.send(encodeBinFrame(frame), { binary: true });
      } else {
        this.#ws.send(encodeFrame(frame));
      }
      this.#metrics.framesOut += 1;
      return true;
    } catch (error) {
      return this.#recordDrop('send_failed', { kind: frame?.kind, message: String(error?.message ?? error).slice(0, 160) });
    }
  }

  #connect() {
    if (this.#disposed || this.#state === 'killed') return;
    if (this.#deps.isKilled?.()) {
      this.#state = 'killed';
      return;
    }
    this.#state = this.#retryAttempt === 0 ? 'connecting' : 'retrying';
    this.#retrySocket = null;
    const base = String(this.#deps.relayUrl).replace(/\/+$/, '');
    // connectorId 走查询参数（中继路由键；指纹是长期身份，密钥不变则不变）。
    let url = `${base}/connector?c=${encodeURIComponent(this.#deps.connectorId)}`;
    const protocols = ['ra.v1'];
    if (this.#deps.relayToken) {
      if (!SAFE_TOKEN.test(this.#deps.relayToken)) {
        this.#scheduleRetry(new Error('relay token contains characters unsupported by WebSocket subprotocol'));
        return;
      }
      protocols.push(`ra-bearer.${this.#deps.relayToken}`);
    }
    let ws;
    try {
      ws = new WebSocket(url, protocols);
    } catch (error) {
      this.#scheduleRetry(error);
      return;
    }
    this.#ws = ws;
    /**
     * ★ 显式声明二进制承载形态（真机事故 2026-10-02）。
     *   Node 内置 WebSocket（undici）默认 binaryType='blob'，中继发来的二进制承载帧
     *   会以 Blob 形态到达 —— 旧代码对它调 Buffer.from 立即抛错，被 onmessage 的
     *   catch 判成协议错误 → close(1002) → 重连 → 再遇大帧 → 再断，形成无限
     *   「重新连接中」。这里要求 arraybuffer，从源头拿到可同步解码的形态。
     *   注意：setter 在不支持的运行时可能抛错/忽略 —— 用 try 包住，真正的兜底是
     *   dataToBuffer() 的 Blob 分支（两层缺一不可，见其注释）。
     */
    try {
      ws.binaryType = 'arraybuffer';
    } catch {
      /* 极旧运行时无此属性：由 dataToBuffer 的 Blob 异步路径兜底 */
    }
    // 强制拆连接的兜底见 #closeSocket 的「已知边界」说明：undici 无 terminate()，
    // 且 AbortSignal 对已建立连接无效 —— 对端不回应时由中继侧 keepalive 回收。
    this.#metrics.connects += 1;
    if (this.#retryAttempt > 0) this.#metrics.reconnects += 1;
    ws.onopen = () => {
      // hello 在 open 后即发；relay 回 hello-ack 才算 established。
      // caps 'bin'：宣告支持二进制承载帧（大载荷免 b64+JSON 膨胀）。
      this.send({ kind: 'hello', proto: 1, caps: ['http', 'ws', 'pair', 'auth', 'bin'], nonce: randomUUID() });
       clearTimeout(this.#helloTimer);
       this.#helloTimer = setTimeout(() => {
         if (this.#ws !== ws || this.#state === 'open') return;
         this.#deps.logger?.warn?.('[kite] relay hello-ack timeout; retrying');
         this.#closeSocket(1012, 'hello timeout');
         this.#scheduleRetry(new Error('relay hello-ack timeout'), ws);
       }, HELLO_ACK_TIMEOUT_MS);
       this.#helloTimer.unref?.();
    };
    /**
     * ★ 入站解码必须**串行**（真机事故 2026-10-02）：
     *   Blob 兜底路径是异步的（await arrayBuffer()）。若直接 async onmessage，
     *   两次投递会并发交错 —— 先到的 Blob 后解出，帧顺序被打乱，中继侧的
     *   revision 连续性直接崩掉。用一条链把「投递顺序 = 解码顺序 = 派发顺序」钉死。
     *   arraybuffer 形态下全程同步，链上不留悬挂 promise，零额外延迟。
     */
    let rxChain = Promise.resolve();
    ws.onmessage = (event) => {
      // 旧 socket 的迟到消息不能污染新连接；入队前先挡一次。
      if (this.#ws !== ws) return;
      const data = event.data;
      rxChain = rxChain.then(async () => {
        // Blob.arrayBuffer() 有异步窗口，等待期间 socket 可能已被替换。
        if (this.#ws !== ws) return;
        this.#metrics.framesIn += 1;
        let frame;
        try {
          // ★ 二进制消息 = 二进制承载帧（'bin' 协商后中继才可能发）；文本 = JSON 帧。
          //   非字符串一律走 dataToBuffer：它同步处理 Buffer/ArrayBuffer/TypedArray，
          //   并异步兜底 Blob —— 绝不再出现「Blob 直接喂 Buffer.from 就炸」。
          frame = typeof data === 'string'
            ? decodeFrame(data)
            : decodeBinFrame(await dataToBuffer(data));
        } catch (error) {
          if (this.#ws !== ws) return;
          this.#deps.audit?.({ kind: 'relay.protocol-error', reason: error.message });
          this.#closeSocket(1002, 'protocol error');
          this.#scheduleRetry(error, ws);
          return;
        }
        if (this.#ws !== ws) return;
        this.#dispatch(frame);
      }).catch((error) => {
        // 链自身绝不中断：一次异常不能把后续所有入站帧静默吞掉。
        this.#deps.logger?.warn?.(`[kite] relay inbound handler failed: ${error?.message ?? error}`);
      });
    };
    ws.onclose = (event) => {
      /**
       * ★ 只有「当前这条 socket」的 close 才有权改状态（2026-10-02）。
       *   旧代码无条件 `this.#ws = null` —— 一条**已被替换**的旧 socket 迟到的 close
       *   会把刚建好的新连接引用抹掉：send() 从此恒返回 socket_not_open，
       *   面板上却显示着「已连接」，直到下一次重连才自愈。
       *   中继侧 `connectors.get(id)?.close(4000,'replaced')`（多实例抢座）正好制造
       *   这种「旧连接被踢、新连接刚装上」的交错窗口，实测该码出现 141 次。
       *   这里以身份比较为准：不是当前 socket 的 close 直接忽略，不碰任何状态。
       */
      if (this.#ws !== ws) return;
      const wasOpen = this.#state === 'open';
      this.#ws = null;
      if (this.#disposed || this.#state === 'killed') return;
      this.#metrics.lastError = `closed ${event.code} ${event.reason || ''}`.trim();
      for (const stream of this.#streams.values()) {
      stream.abortController?.abort('relay disconnected');
      stream.wsBridge?.close();
    }
      this.#streams.clear();
      if (wasOpen) this.#retryAttempt = 0;
      this.#scheduleRetry(new Error(`relay closed (${event.code})`), ws);
    };
    ws.onerror = () => {
      /* onclose 会跟着来；错误细节在中继侧 */
    };
  }

  #scheduleRetry(error, failedWs = null) {
    if (this.#disposed || this.#state === 'killed') return;
    if (failedWs && this.#retrySocket === failedWs) return;
    if (failedWs) this.#retrySocket = failedWs;
    this.#state = 'retrying';
    this.#metrics.lastError = error?.message ?? String(error);
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this.#retryAttempt) + Math.floor(Math.random() * 500);
    this.#retryAttempt += 1;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#connect();
    }, delay);
    this.#retryTimer.unref?.();
  }

  /**
   * 主动关闭当前 socket。
   *
   * ★ 真机事故 2026-10-02（第二个独立根因，与 Blob 那条叠加）：
   *   Node 内置 WebSocket（undici）**只接受 1000 与 3000–4999 作为 close code**；
   *   传 1002/1001/1011 会抛 `DOMException [InvalidAccessError]: invalid code`。
   *   而旧代码把 `ws.close(code, reason)` 整个包在 `try { … } catch { /* ignore *\/ }` 里 ——
   *   异常被静默吞掉，**一个字节都没发出去，socket 也没关**。后果：
   *     · 协议错误路径（close(1002)）根本关不掉连接 → 旧 socket 变僵尸；
   *     · 重试计时器照样排 → 新建一条 → 中继侧同 id 抢座 close(4000,'replaced')
   *       把**新**的那条踢掉 …… 实测线上 `code=4000` 累计 **141 次**、中继
   *       `connectors` 长期显示 **2**（幽灵条目永不复位），手机端则表现为
   *       「重新连接中」长跑不停。
   *     · kill switch 的「立即断开」同样落空。
   *
   *   修法：把调用方给的语义码映射成合法线上码（1002 → 4002，语义写进 reason），
   *   让 close 帧**真的发出去**；这条路径通了，中继就能立刻回收该连接器条目。
   *
   * ⚠ 已知边界（诚实记录，勿据此以为能「强拆」）：undici 的 WebSocket
   *   **没有 terminate()**，且一旦对端不回应 close 帧，它没有任何内置超时——
   *   实测 socket 会长期停在 readyState=2（CLOSING），AbortSignal 对**已建立**的
   *   连接也无效（只作用于握手阶段）。因此这里不做「伪强拆」；真正的兜底在中继侧：
   *   RELAY_CONNECTOR_PING_MS（默认 30s）ping 无 pong 即 terminate，由中继清理。
   *   旧代码的 `ws.terminate?.()` 在这条链上恒为 no-op —— 那才是「看起来有兜底、
   *   实际什么都没有」的第三层静默失效。
   */
  #closeSocket(code, reason) {
    const ws = this.#ws;
    if (!ws) return;
    /**
     * close code 合法性：1000 与 3000–4999 才被 undici 接受。
     * 其它（1001/1002/1003/1005/1006/1011/1012/1013/1015…）一律映射到 4xxx，
     * 否则 close() 抛错 → 连接永远不关（旧行为的真凶）。
     * 映射保持可辨识：RFC 控制码映射到 4000+低位，其它异常输入落到 4999。
     */
    const wireCode = toClientCloseCode(code);
    const wireReason = clientCloseReason(reason);
    try {
      ws.close(wireCode, wireReason);
    } catch (error) {
      // 映射后仍抛错（未来运行时收紧规则）必须留下痕迹 —— 绝不静默。
      this.#deps.logger?.warn?.(`[kite] relay close(${wireCode}) failed: ${error?.message ?? error}`);
    }
    // 非 undici 运行时（如 `ws` 包）有真 terminate，1s 后补一刀；undici 上这是 no-op，
    // 由中继侧 keepalive 兜底（见上方「已知边界」）。
    const force = setTimeout(() => {
      try { ws.terminate?.(); } catch { /* 已关 / undici 无此方法 */ }
    }, 1000);
    force.unref?.();
  }

  #dispatch(frame) {
    switch (frame.kind) {
      case 'hello-ack': {
        clearTimeout(this.#helloTimer);
        this.#helloTimer = null;
        this.#state = 'open';
        this.#retryAttempt = 0;
        this.#metrics.lastError = null; // 建立成功即清残留错误（面板不再显示历史抖动）
        this.#metrics.openedAt = Date.now();
        // ★ 中继也在 caps 里宣告 'bin' 才启用二进制承载 —— 任一侧不支持都全文本回退。
        this.#binNegotiated = Array.isArray(frame.caps) && frame.caps.includes('bin');
        // Pair-Proof: 'claim' 宣告中继支持 device-claim 帧验签（旧中继没有此帧，
        //   盲发会因 unknown-kind 被 1002 断连 —— 必须协商后发）。
        this.#claimNegotiated = Array.isArray(frame.caps) && frame.caps.includes('claim');
        this.publishDevices(); // ★ 上报已配对设备 → 中继据此路由普通 HTTP（含 PWA 页面）
        this.#deps.logger?.info?.(`[kite] relay established (proto=${frame.proto} bin=${this.#binNegotiated ? 'on' : 'off'} claim=${this.#claimNegotiated ? 'on' : 'off'})`);
        return;
      }
      case 'ping':
        this.send({ kind: 'pong' });
        return;
      case 'http-head': {
        this.#streams.set(frame.streamId, {
          deviceId: frame.deviceId,
          method: frame.method,
          path: frame.path,
          headers: frame.headers ?? {},
          chunks: [],
          bytes: 0,
          socket: this.#ws,
          abortController: new AbortController(),
          cookieOverride: frame.headers?.cookie
        });
        return;
      }
      case 'http-body': {
        const stream = this.#streams.get(frame.streamId);
        if (!stream) return;
        let chunk;
        try {
          chunk = b64d(frame.chunk, 'chunk');
        } catch {
          this.#dropStream(frame.streamId, 'bad chunk');
          return;
        }
        stream.bytes += chunk.length;
        if (stream.bytes > MAX_BODY_BYTES) {
          this.#dropStream(frame.streamId, 'body too large');
          return;
        }
        stream.chunks.push(chunk);
        if (frame.final) void this.#handleHttp(frame.streamId, stream);
        return;
      }
      case 'http-cancel': {
        const stream = this.#streams.get(frame.streamId);
        if (stream?.abortController) stream.abortController.abort(frame.reason ?? 'relay cancelled');
        if (stream?.channel) {
          this.#streams.delete(`ch:${stream.channel}`);
          this.#streams.delete(`pair:${stream.channel}`);
        }
        this.#streams.delete(frame.streamId);
        return;
      }
      case 'ws-open': {
        const deviceId = this.#resolveDevice(frame.deviceId, frame.headers?.cookie);
        if (!deviceId) {
          this.send({ kind: 'ws-close', deviceId: frame.deviceId, streamId: frame.streamId, code: 4401 });
          return;
        }
        // ★ P0-3：WS 不是后门 —— 与 HTTP 完全相同的门：kill switch 复检 + 规范化 + 策略判定。
        //   旧实现把 frame.path 直接交给 openLoopbackBridge，于是「HTTP 侧被拒的路径在 WS 侧照通」，
        //   且 `//127.0.0.1:9999/x` 可打任意回环端口（还带 dsh-auth 凭据）。
        if (this.#deps.isKilled?.()) {
          this.#deps.audit?.({ kind: 'ws.reject', deviceId, reason: 'kill-switch', path: auditPathOf(frame.path) });
          this.send({ kind: 'ws-close', deviceId, streamId: frame.streamId, code: 4403 });
          return;
        }
        const target = canonicalizeTarget(frame.path);
        if (!target) {
          this.#deps.audit?.({ kind: 'ws.reject', deviceId, reason: 'bad-path', path: auditPathOf(frame.path) });
          this.send({ kind: 'ws-close', deviceId, streamId: frame.streamId, code: 4400 });
          return;
        }
        const verdict = this.#deps.policy?.decide?.({ method: 'GET', path: target.key });
        if (verdict && verdict.action === 'deny') {
          this.#deps.audit?.({ kind: 'ws.reject', deviceId, reason: verdict.reason, path: target.pathname });
          this.send({ kind: 'ws-close', deviceId, streamId: frame.streamId, code: 4403 });
          return;
        }
        const bridge = openLoopbackBridge(this.#deps, {
          streamId: frame.streamId,
          pathname: target.pathname,
          search: target.search,
          deviceId,
          onReady: () => this.send({ kind: 'ws-accept', deviceId, streamId: frame.streamId }),
          onFrame: (msg) => {
            // ★ 下行绝不允许静默挖洞（2026-10-01）。
            //   send() 返回 false 就表示这一帧没送出去，而 DSH 客户端对会话流的校验是
            //   「首帧必须是 snapshot」「序列严格 +1」—— 丢一帧就整条历史加载失败，
            //   报出来的却是 gateway/internal 这种看不出所以然的错。
            //   旧代码把返回值丢在地上（`onFrame: (msg) => this.send({...})`），
            //   下行既没有重试也没有断流保护：一次瞬时失败 = 永久一个洞。
            //   这里改成显式断流，让客户端重连重取快照 —— 可恢复，且失败可归因。
            if (this.send({ kind: 'ws-data', deviceId, streamId: frame.streamId, fin: msg.fin, opcode: msg.opcode, data: msg.data })) return;
            this.#deps.logger?.warn?.(`[kite] 下行帧发送失败，主动断流让客户端重取快照 streamId=${frame.streamId}`);
            const live = this.#streams.get(frame.streamId);
            live?.wsBridge?.close();
            this.#streams.delete(frame.streamId);
            this.send({ kind: 'ws-close', deviceId, streamId: frame.streamId, code: 1011 });
          },
          onClose: (code) => this.send({ kind: 'ws-close', deviceId, streamId: frame.streamId, code })
        });
        this.#streams.set(frame.streamId, { deviceId, wsBridge: bridge });
        this.#metrics.wsBridges += 1;
        return;
      }
      case 'ws-data': {
        const stream = this.#streams.get(frame.streamId);
        if (!stream?.wsBridge) return;
        if (!stream.wsBridge.toLoopback({ fin: frame.fin ?? true, opcode: frame.opcode, data: frame.data })) {
          this.send({ kind: 'ws-close', deviceId: stream.deviceId, streamId: frame.streamId, code: 1011 });
        }
        return;
      }
      case 'ws-close': {
        const stream = this.#streams.get(frame.streamId);
        if (stream?.wsBridge) stream.wsBridge.close();
        this.#streams.delete(frame.streamId);
        return;
      }
      case 'pair-begin':
        void this.#handlePairBegin(frame);
        return;
      case 'pair-done':
        void this.#handlePairDone(frame);
        return;
      case 'auth-begin':
        this.#handleAuthBegin(frame);
        return;
      case 'auth-done':
        this.#handleAuthDone(frame);
        return;
      case 'sealed':
        this.#handleSealed(frame);
        return;
      default:
        // hello/kick/pong/其它：忽略（kick 由本侧发出）。
        return;
    }
  }

  #canSendStream(streamId, stream) {
    return Boolean(stream && !stream.abortController?.signal.aborted
      && this.#streams.get(streamId) === stream && this.#ws === stream.socket);
  }

  #dropStream(streamId, reason) {
    const stream = this.#streams.get(streamId);
    this.#streams.delete(streamId);
    // 主动丢流也要计数：它以前只回一个 http-error 就结束了，服务器侧看不到任何痕迹。
    this.#recordDrop('stream_dropped', { streamId, reason, path: stream?.path ?? null, bytes: stream?.bytes ?? null });
    this.send({ kind: 'http-error', deviceId: stream?.deviceId ?? 'unknown', streamId, code: 'proxy/aborted', message: reason });
  }

  /** 设备判定：relay 帧里的 deviceId 不可信，只认自己签的票据。返回真实 deviceId|null。 */
  #resolveDevice(claimedDeviceId, cookieHeader) {
    const token = deviceCookieFrom(cookieHeader);
    const deviceId = this.#deps.tickets.verify(token ?? '');
    if (!deviceId) return null;
    if (!this.#deps.devices.isActive(deviceId)) return null;
    void claimedDeviceId; // 不采信
    void this.#deps.devices.touch(deviceId);
    return deviceId;
  }

  async #handleHttp(streamId, stream) {
    // ★ P1-1：kill switch 逐请求复检。从「点了开关」到「WS 真的关掉」之间存在窗口
    //   （在途帧、重连竞态），复检是零成本兜底 —— 承诺「立即断开」就必须立即断开。
    if (this.#deps.isKilled?.()) {
      this.#streams.delete(streamId);
      this.send({
        kind: 'http-error',
        deviceId: stream?.deviceId ?? 'unknown',
        streamId,
        code: 'proxy/killed',
        status: 503,
        message: '远程访问已紧急停用（kill switch）'
      });
      return;
    }
    this.#metrics.httpRequests += 1;
    stream.handling = true;
    const body = stream.chunks.length === 1 ? stream.chunks[0] : Buffer.concat(stream.chunks);
    try {
      // 保留路径：PWA 配对页（无票据也可达；只接受配对令牌）。
      if (stream.path === '/kite/pair' || stream.path.startsWith('/kite/pair?') || stream.path.startsWith('/kite/pair/')
          || stream.path === '/kite/welcome' || stream.path.startsWith('/kite/welcome?')) {
        const res = await this.#deps.handlePairPage?.({ method: stream.method, path: stream.path, headers: stream.headers, body });
        if (res) {
          // ★ 配对成功立即上报设备表。真机事故 2026-10-02：这段补丁原先只加在
          //   `#handlePairDone`（**信令通道** `pair-done` 帧），但配对页走的是
          //   **HTTP 保留路径**（panel.js 里 `POST /kite/pair/complete`），两者是
          //   完全独立的入口 —— 结果补丁形同虚设：新配对设备的 deviceId 不在中继
          //   路由表里，而浏览器加载 assets 是**不带 c**的（相对路径 ./assets/…），
          //   只能靠 cookie 路由 → 全部 401 → 应用起不来 → 白屏 /「Failed to load
          //   plugins / HTML did not preload」。等连接器下次重连才自愈。
          //   这里按路径判定「本次是否完成了配对」，完成则立刻上报。
          const isPairComplete = stream.path.startsWith('/kite/pair/complete') && res.status === 200;
          if (isPairComplete) {
            // ★ Pair-Proof：把配对凭证原件交给中继验签 —— 归属从「声明」升格为
            //   「密码学事实」（phantom 无手机私钥，永远无法对自身 connectorId 产生
            //   合法 claim）。claim 失败不影响配对本身（中继侧兼容旧语义）。
            if (res.claim && this.#claimNegotiated) {
              if (!this.send({
                kind: 'device-claim',
                deviceId: res.claim.deviceId,
                pubKey: res.claim.pubKey,
                challenge: res.claim.challenge,
                sig: res.claim.sig,
                ts: res.claim.ts
              })) {
                this.#deps.logger?.warn?.('[kite] device-claim 发送失败（连接器未连接）—— 将随下次重连上报重试');
              }
            }
            this.publishDevices();
          }
          // ★ 必须 await：streams.delete 若在发送完成前执行，#awaitSendCapacity 的
          //   #canSendStream 守卫会立刻判定「流已取消」而提前中止（2026-10-03）。
          await this.#sendHttpResponse(stream.deviceId, streamId, res, stream);
          this.#streams.delete(streamId);
          return;
        }
      }
      const deviceId = this.#resolveDevice(stream.deviceId, stream.cookieOverride ?? stream.headers.cookie);
      const result = await forwardRequest(this.#deps, {
        deviceId: deviceId ?? stream.deviceId,
        method: stream.method,
        path: stream.path,
        headers: stream.headers,
        body,
        isDeviceValid: Boolean(deviceId),
        signal: stream.abortController?.signal
      });
      // ★ 同上：await 之后再删流。注意流式响应（result.stream）走 #sendHttpStream
      //   自己管理生命周期，这里仅在非流式时删。
      await this.#sendHttpResponse(stream.deviceId, streamId, result, stream);
      if (!result.stream) this.#streams.delete(streamId);
    } catch (error) {
      this.#streams.delete(streamId);
      if (stream.abortController?.signal.aborted || error?.name === 'AbortError') return;
      if (!this.#canSendStream(streamId, stream)) return;
      this.#deps.logger?.warn?.(`[kite] forward failed: ${error.message}`);
      // ★ 业务性错误用 4xx（配对令牌无效等），不得伪装成 502 网关故障 ——
      // Cloudflare 等前置代理会用自有 HTML 覆盖 502，导致前端 JSON 解析崩溃。
      this.send({
        kind: 'http-error',
        deviceId: stream.deviceId,
        streamId,
        code: 'proxy/forward-failed',
        status: 400,
        message: `转发失败：${error.message}`
      });
    }
  }

  /**
   * 响应回传。★ 顺带做 gzip：DSH 桌面壳的 runtime patch 会覆盖 webserver 的
   * compression 配置（每次启动自动重写、优先级最高），导致上游不发压缩头；
   * 而 57 个客户端模块包在公网隧道下是首要耗时来源（真机 2026-10-01）。
   * 此处 head/body 同时掌握，可安全地按压缩结果重写 content-encoding。
   */
  /**
   * ★ 流式响应：边收边发帧（SSE / chunked）。绝不缓冲 —— 缓冲会让长思考的
   * LLM 请求在客户端看来「零字节」，导致超时断开（HTTP 499，真机 2026-10-01）。
   */
  async #sendHttpStream(deviceId, streamId, res, stream) {
    this.send({ kind: 'http-res-head', deviceId, streamId, status: res.status, headers: res.headers ?? {} });
    const reader = res.stream.getReader();
    const signal = stream.abortController?.signal;
    let completed = false;
    try {
      for (;;) {
        if (signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) { completed = true; break; }
        if (!value || value.length === 0) continue;
        // 分片成 ≤MAX_CHUNK_BYTES 的帧
        for (let offset = 0; offset < value.length; offset += MAX_CHUNK_BYTES) {
          const chunk = value.subarray(offset, offset + MAX_CHUNK_BYTES);
          const last = offset + MAX_CHUNK_BYTES >= value.length;
          // ★ 同样的背压纪律（2026-10-03）：SSE 长流虽然单帧小，但高频 assistant 流
          //   在慢链路下同样会把 bufferedAmount 顶穿上限 —— 旧代码在这里静默 return，
          //   客户端看到的是「流戛然而止」。先等容量，失败则显式回报。
          if (!(await this.#awaitSendCapacity(streamId, stream))) return;
          if (!this.send({ kind: 'http-res-body', deviceId, streamId, chunk: b64e(chunk), final: false })) {
            this.#recordDrop('stream_body_send_failed', { streamId, offset });
            if (!signal?.aborted) {
              this.send({
                kind: 'http-error',
                deviceId,
                streamId,
                code: 'proxy/stream-truncated',
                status: 502,
                message: '流式响应发送中断（连接器发送缓冲无法排空）'
              });
            }
            this.#streams.delete(streamId);
            return;
          }
          if (!last) continue;
        }
      }
    } catch (error) {
      this.#deps.logger?.warn?.(`[kite] stream read failed: ${error.message}`);
      if (!signal?.aborted) this.send({ kind: 'http-error', deviceId, streamId, code: 'proxy/stream-failed', status: 502, message: '上游流读取失败' });
      this.#streams.delete(streamId);
      return;
    } finally {
      try { reader.releaseLock(); } catch { /* 已释放 */ }
    }
    if (completed) {
      this.send({ kind: 'http-res-body', deviceId, streamId, chunk: '', final: true });
      this.#streams.delete(streamId);
    } else if (signal?.aborted) {
      this.#streams.delete(streamId);
    }
  }

  /**
   * 响应回传（缓冲路径）。★ 自 2026-10-03 起本方法是 **async**：大响应必须
   * 逐帧等待发送缓冲排空（见 #awaitSendCapacity 的说明），否则 10MB 合并包会在
   * 同步循环里顶穿 8MB 发送上限并静默截断。
   *
   * 调用契约：两个调用点都在 #handleHttp 的 try/catch 内，因此**必须 await** ——
   * 既为了让流在发送期间保持存活（否则守卫误判「已取消」），也为了让发送期的
   * 异常落进同一个 catch，而不是变成游离的 unhandled rejection。
   */
  async #sendHttpResponse(deviceId, streamId, res, stream) {
    // 流式响应走专用路径（不缓冲）
    if (res.stream) {
      void this.#sendHttpStream(deviceId, streamId, res, stream);
      return;
    }
    let headers = res.headers ?? {};
    let body = res.body ?? Buffer.alloc(0);
    const ct = String(headers['content-type'] ?? '');
    // ★ 必须尊重客户端声明：未声明 gzip 时压缩会让它解不开（HTTP 语义要求）。
    // accept-encoding 来自中继转发的**原始客户端请求头**（车 stream.headers），
    // 不经代理白名单 —— 白名单只管「转发给 DSH 的头」，这里只管「客户端能否解压」。
    const acceptsGzip = /\bgzip\b/i.test(String(stream.headers?.['accept-encoding'] ?? ''));
    const compressible = acceptsGzip
      && body.length >= 1024
      && !headers['content-encoding']
      && /^(text\/|application\/(javascript|json|xml)|image\/svg)/i.test(ct)
      && !/text\/event-stream/i.test(ct);
    if (compressible) {
      try {
        const gz = gzipSync(body, { level: 6 });
        if (gz.length < body.length) {
          headers = { ...headers, 'content-encoding': 'gzip', 'content-length': String(gz.length), vary: 'Accept-Encoding' };
          body = gz;
        }
      } catch {
        /* 压缩失败则原样发送 */
      }
    }
    this.send({ kind: 'http-res-head', deviceId, streamId, status: res.status, headers });
    /**
     * ★★ P0（2026-10-03 真机事故，与中继侧 write()===false 是**同一类错的第二处**）：
     *   旧实现在**同步 for 循环**里一次性把整个 body 塞进 ws —— 对 10MB 的合并客户端
     *   模块包就是 40 帧 × 341KB = 13.3MB 连续入队。同步循环期间事件循环无法推进，
     *   `bufferedAmount` 只增不减，必然越过 MAX_SEND_BUFFER_BYTES(8MB) →
     *   send() 返回 false → `return` **静默中断**：已发出约 5.8MB，剩下的 42% 永不发送，
     *   而且**连一个 http-error 都没回**。中继那边看到的就是「响应不完整」。
     *
     *   修法两层，缺一不可：
     *   ① 等待排空再继续（drain 语义）：让事件循环有机会把缓冲写进链路；
     *   ② 真排不空（对端死亡）时**显式回错误帧**，绝不静默 return。
     */
    for (let offset = 0; offset < body.length || offset === 0; offset += MAX_CHUNK_BYTES) {
      const chunk = body.subarray(offset, offset + MAX_CHUNK_BYTES);
      const final = offset + MAX_CHUNK_BYTES >= body.length;
      // ① 先等缓冲回落（含首次进入）：避免同步循环把 bufferedAmount 顶穿上限。
      if (!(await this.#awaitSendCapacity(streamId, stream))) return;
      if (!this.send({ kind: 'http-res-body', deviceId, streamId, chunk: b64e(chunk), final })) {
        // ② 已经到了该发却仍然发不出去 —— 必须显式告知，不能静默截断。
        this.#deps.logger?.warn?.(`[kite] http-res-body 发送失败（缓冲区满/连接关闭），显式回报错误 streamId=${streamId}`);
        this.#recordDrop('response_body_send_failed', { streamId, offset, total: body.length });
        this.send({
          kind: 'http-error',
          deviceId,
          streamId,
          code: 'proxy/response-truncated',
          status: 502,
          message: '响应体发送中断（连接器发送缓冲无法排空）'
        });
        return;
      }
      if (final) break;
    }
  }

  /**
   * 等待 ws 发送缓冲回落到安全水位（背压的 drain 语义）。
   *
   * 为什么不能只靠 send() 的失败检查：同步循环里 bufferedAmount 单调上升，
   * 等失败才反应已经晚了（数据早丢）。这里在**每帧之前**让出事件循环，
   * 使 undici 有机会把缓冲写进内核 —— 这是「10MB 响应不截断」的关键。
   *
   * @returns true = 可以继续发送；false = 流已被取消/连接已换，应中止且不再回报。
   */
  async #awaitSendCapacity(streamId, stream) {
    const LOW_WATERMARK = MAX_SEND_BUFFER_BYTES / 2;
    // 最多等 30 秒（对端彻底不消费的场景），超时即放弃并回报错误 —— 有界，不挂死。
    const deadline = Date.now() + 30_000;
    while (Number(this.#ws?.bufferedAmount ?? 0) > LOW_WATERMARK) {
      if (!this.#canSendStream(streamId, stream)) return false;
      if (Date.now() > deadline) {
        this.#recordDrop('send_capacity_timeout', {
          streamId,
          bufferedAmount: Number(this.#ws?.bufferedAmount ?? 0),
          limit: MAX_SEND_BUFFER_BYTES
        });
        return true; // 让调用方走 send() 失败的显式错误分支
      }
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
    return this.#canSendStream(streamId, stream);
  }

  // ---- 配对（thin client 帧流；PWA 页面共用 pairing service）----

  async #handlePairBegin(frame) {
    try {
      const { challenge, code } = await this.#deps.pairing.submit({
        token: frame.pairToken,
        pubKey: frame.pubKey,
        name: frame.name,
        channel: frame.channel
      });
      this.send({ kind: 'pair-challenge', channel: frame.channel, challenge, code });
    } catch (error) {
      this.send({ kind: 'pair-result', channel: frame.channel, ok: false, error: error.message });
    }
  }

  async #handlePairDone(frame) {
    try {
      const result = await this.#deps.pairing.complete({ challenge: frame.challenge, sig: frame.sig, ts: frame.ts });
      this.send({
        kind: 'pair-result',
        channel: frame.channel,
        ok: true,
        deviceId: result.deviceId,
        code: result.code,
        setCookie: result.setCookie
      });
      // ★ 配对成功立即上报设备表：新设备（配对页每次生成新公钥 → 新 deviceId）在
      //   下次重连前必然不在中继路由表里，welcome 之后的 / 只能靠中继兜底抽奖路由
      //   （真机事故 2026-10-01：多连接器时被投进错误/僵尸连接器，手机卡死在
      //   「配对完成，正在进入 DSH…」）。
      //   Pair-Proof：信令通道的配对同样发 device-claim（与 HTTP 路径一致）。
      if (result.claim && this.#claimNegotiated) {
        this.send({
          kind: 'device-claim',
          deviceId: result.claim.deviceId,
          pubKey: result.claim.pubKey,
          challenge: result.claim.challenge,
          sig: result.claim.sig,
          ts: result.claim.ts
        });
      }
      this.publishDevices();
    } catch (error) {
      this.send({ kind: 'pair-result', channel: frame.channel, ok: false, error: error.message });
    }
  }

  #handleAuthBegin(frame) {
    const deviceId = this.#deps.devices.isActive(frame.deviceId) ? frame.deviceId : null;
    if (!deviceId) {
      this.send({ kind: 'auth-result', channel: frame.channel, ok: false, error: 'unknown device' });
      return;
    }
    // ★ P2：被弃条目（auth-begin 后未完成）此前只增不减 —— 已认证设备可以无限刷。
    //   过期清扫 + 容量上限（超限时丢最旧的一条），完成后仍即时删除（见 #handleAuthDone）。
    this.#sweepAuthChallenges();
    const challenge = newChallenge();
    this.#authChallenges.set(`auth:${frame.channel}`, { challenge, deviceId, at: Date.now() });
    this.send({ kind: 'auth-challenge', channel: frame.channel, challenge });
  }

  /** 清扫过期/超量的未完成挑战（容量语义：超限丢最旧）。 */
  #sweepAuthChallenges() {
    const now = Date.now();
    for (const [key, entry] of this.#authChallenges) {
      if (now - (entry.at ?? 0) > AUTH_CHALLENGE_TTL_MS) this.#authChallenges.delete(key);
    }
    while (this.#authChallenges.size >= AUTH_CHALLENGE_MAX) {
      const oldest = this.#authChallenges.keys().next();
      if (oldest.done) break;
      this.#authChallenges.delete(oldest.value);
    }
  }

  #handleAuthDone(frame) {
    const pending = this.#authChallenges.get(`auth:${frame.channel}`);
    this.#authChallenges.delete(`auth:${frame.channel}`);
    if (!pending) {
      this.send({ kind: 'auth-result', channel: frame.channel, ok: false, error: 'no challenge' });
      return;
    }
    const device = this.#deps.devices.get(pending.deviceId);
    if (!device) {
      this.send({ kind: 'auth-result', channel: frame.channel, ok: false, error: 'device revoked' });
      return;
    }
    const verdict = this.#deps.tickets.verifyChallenge(b64d(device.pubKey, 'pubKey'), pending.deviceId, pending.challenge, frame.sig, frame.ts);
    if (!verdict.ok) {
      this.#deps.audit?.({ kind: 'auth.reject', deviceId: pending.deviceId, reason: verdict.reason });
      this.send({ kind: 'auth-result', channel: frame.channel, ok: false, error: verdict.reason });
      return;
    }
    const ticket = this.#deps.tickets.issue(pending.deviceId);
    this.send({ kind: 'auth-result', channel: frame.channel, ok: true, ticket, setCookie: deviceCookieValue(ticket) });
  }

  // ---- sealed 模式（thin client E2E，M2 协议面；密钥协商帧另行携带）----

  #handleSealed(_frame) {
    // v0.1：密钥协商（X25519 hello 交换）尚未在 carrier 上启用；thin client 未交付前
    // 该分支显式拒绝并审计，绝不静默丢弃。
    this.#deps.audit?.({ kind: 'relay.sealed-unavailable', reason: 'e2e negotiation not enabled in v0.1' });
  }

  /**
   * 上报已配对设备给中继（路由表）。配对成功/撤销/重连后都应调用 ——
   * 没有它，只带 ra-device cookie 的普通 HTTP 请求无法被中继路由。
   */
  publishDevices() {
    if (!this.#ws || this.#ws.readyState !== 1) return false;
    try {
      const list = this.#deps.devices?.list?.() ?? [];
      const deviceIds = list.map((d) => d.deviceId).filter(Boolean);
      // ★ Pair-Proof 自愈：重连后重放已持久化的配对凭证 —— 中继侧 owners 表
      //   无论因重启/换机/清盘丢失多少，都能从设备表原件恢复（签名可反复验证）。
      //   只在协商过 'claim' 的中继上重放；避免旧中继收到未知帧断连。
      if (this.#claimNegotiated) {
        for (const d of list) {
          if (d.claim?.sig && d.deviceId) {
            this.send({
              kind: 'device-claim',
              deviceId: d.claim.deviceId ?? d.deviceId,
              pubKey: d.claim.pubKey,
              challenge: d.claim.challenge,
              sig: d.claim.sig,
              ts: d.claim.ts
            });
          }
        }
      }
      return this.send({ kind: 'devices', deviceIds });
    } catch (error) {
      this.#deps.logger?.warn?.(`[kite] publish devices failed: ${error.message}`);
      return false;
    }
  }

  /** 管理面状态。 */
  status() {
    return {
      state: this.#state,
      relayUrl: this.#deps.relayUrl || null,
      connectorId: this.#deps.connectorId,
      metrics: this.metrics
    };
  }
}

/**
 * ★ 中继接入预检探针（配置化面板 §5.5 坑 1：绝不能复用连接器自己的 connectorId）。
 *
 * 中继收到同 id 连接会执行 `connectors.get(id)?.close(4000, 'replaced')`，
 * 直接把线上那条踢掉 —— 所以这里强制用 `probe-<随机>` 临时 id。
 *
 * 两段式分类（给用户可读的失败原因）：
 *   ① GET {https 派生}/healthz —— 区分 dns / tls / timeout / server（连接被拒=服务没起）；
 *   ② WSS 握手到 /connector 等 hello-ack —— healthz 已通而握手失败 = 令牌被拒（auth）。
 * 返回 { ok:true, code:'ok', latencyMs } 或 { ok:false, code, reason }，
 * code ∈ format|dns|tls|timeout|server|auth（对齐交互稿 §3.6-B）。
 */
export function probeRelay({ relayUrl, relayToken, timeoutMs = 10_000 } = {}) {
  const url = String(relayUrl ?? '').trim();
  // wss:// 一律放行；ws:// 仅限回环（本机联调），远程明文入口永不接受（§5.5 坑 2）。
  const LOOPBACK_WS = /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;
  if (!/^wss:\/\//i.test(url) && !LOOPBACK_WS.test(url)) {
    return Promise.resolve({ ok: false, code: 'format', reason: '只允许 wss:// 地址（本机联调可用 ws://127.0.0.1:端口）' });
  }
  const healthBase = url.replace(/^ws/i, 'http').replace(/\/+$/, '');
  const classifyNetworkError = (error) => {
    const m = String(error?.cause?.message ?? error?.message ?? error);
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return { ok: false, code: 'dns', reason: `域名解析失败：${m.slice(0, 140)}` };
    if (/CERT|SSL|TLS|self-signed/i.test(m)) return { ok: false, code: 'tls', reason: `TLS/证书异常：${m.slice(0, 140)}` };
    if (/ECONNREFUSED/i.test(m)) return { ok: false, code: 'server', reason: '连接被立即拒绝 —— 中继服务大概率没在运行（systemctl status ra-relay）' };
    if (error?.name === 'TimeoutError' || /TIMEOUT|abort/i.test(m)) return { ok: false, code: 'timeout', reason: '中继健康检查超时 —— 服务未运行或云防火墙未放行端口（丢包表现为持续超时）' };
    return { ok: false, code: 'server', reason: `健康检查失败：${m.slice(0, 140)}` };
  };
  return fetch(`${healthBase}/healthz`, { signal: AbortSignal.timeout(Math.min(timeoutMs, 10_000)), redirect: 'manual' })
    .then((health) => new Promise((resolve) => {
      // healthz 通了（或返回任意 HTTP 状态）→ 进入 WSS 握手验证令牌。
      void health;
      const startedAt = Date.now();
      const id = `probe-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const full = `${url.replace(/\/+$/, '')}/connector?c=${encodeURIComponent(id)}`;
      const protocols = ['ra.v1'];
      if (relayToken) {
        if (SAFE_TOKEN.test(relayToken)) protocols.push(`ra-bearer.${relayToken}`);
        else { resolve({ ok: false, code: 'format', reason: '令牌含不支持的字符；请使用 RFC token 字符，避免令牌进入 URL' }); return; }
      }
      let ws;
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws?.close(); } catch { /* ignore */ }
        resolve(result);
      };
      const timer = setTimeout(() => done({ ok: false, code: 'timeout', reason: '握手无响应（10s 内未收到 hello-ack）' }), Math.max(2_000, Math.min(timeoutMs, 10_000)));
      try {
        ws = new WebSocket(full, protocols);
      } catch (error) {
        done({ ok: false, code: 'format', reason: `WebSocket 建立失败：${String(error?.message ?? error).slice(0, 140)}` });
        return;
      }
      // 与主连接同一纪律：显式要求 arraybuffer，避免二进制帧以 Blob 形态到达。
      try {
        ws.binaryType = 'arraybuffer';
      } catch {
        /* 极旧运行时：由 dataToBuffer 的 Blob 异步路径兜底 */
      }
      ws.onmessage = (event) => {
        const data = event.data;
        // 预检握手只收 hello-ack（JSON 文本帧），但按协议宽容解析二进制。
        // ★ 不能用「同步 try/catch 包住 await」的写法：必须先把 promise 接住再判错，
        //   否则 Blob 路径的 rejection 会逃逸成 unhandledRejection（探针反而假通过）。
        void (async () => {
          let frame;
          try {
            frame = typeof data === 'string'
              ? decodeFrame(data)
              : decodeBinFrame(await dataToBuffer(data));
          } catch {
            done({ ok: false, code: 'server', reason: '中继返回了无法解析的帧（部署的可能不是本中继）' });
            return;
          }
          if (frame.kind === 'hello-ack') done({ ok: true, code: 'ok', latencyMs: Date.now() - startedAt, proto: frame.proto });
          else done({ ok: false, code: 'server', reason: `中继握手返回了非预期帧（${frame.kind}）` });
        })();
      };
      ws.onclose = () => done({ ok: false, code: 'auth', reason: '中继拒绝了令牌（healthz 可达但 /connector 握手被 401）—— 核对 relayToken 与中继 RELAY_TOKENS 是否一致' });
      ws.onerror = () => { /* onclose 跟随；分类交给 onclose */ };
    }))
    .catch((error) => classifyNetworkError(error));
}

function frameTs(frame) {
  return typeof frame.ts === 'number' ? frame.ts : Date.now();
}

function deviceCookieValue(ticket) {
  // relay-client 只发值；完整 Set-Cookie 属性由 pairing.deviceCookie 生成（PWA 页路径）。
  return ticket;
}

