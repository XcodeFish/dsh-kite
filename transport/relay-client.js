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
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;
/** 单请求体聚合上限（PWA 模式；上传被策略层默认拒绝，此上限只防滥用）。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** 子协议 token 允许的字符（RFC7230 token 子集）；不满足则退化为 URL 查询参数。 */
const SAFE_TOKEN = /^[A-Za-z0-9._~-]+$/;

export class RelayConnector {
  #deps;
  #ws = null;
  #state = 'standby';
  #retryAttempt = 0;
  #retryTimer = null;
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
    this.#retryTimer = null;
    this.#closeSocket(1000, 'disposed');
    for (const stream of this.#streams.values()) stream.wsBridge?.close();
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
    const base = String(this.#deps.relayUrl).replace(/\/+$/, '');
    // connectorId 走查询参数（中继路由键；指纹是长期身份，密钥不变则不变）。
    let url = `${base}/connector?c=${encodeURIComponent(this.#deps.connectorId)}`;
    const protocols = ['ra.v1'];
    if (this.#deps.relayToken) {
      if (SAFE_TOKEN.test(this.#deps.relayToken)) protocols.push(`ra-bearer.${this.#deps.relayToken}`);
      else url += `&token=${encodeURIComponent(this.#deps.relayToken)}`;
    }
    let ws;
    try {
      ws = new WebSocket(url, protocols);
    } catch (error) {
      this.#scheduleRetry(error);
      return;
    }
    this.#ws = ws;
    this.#metrics.connects += 1;
    if (this.#retryAttempt > 0) this.#metrics.reconnects += 1;
    ws.onopen = () => {
      // hello 在 open 后即发；relay 回 hello-ack 才算 established。
      // caps 'bin'：宣告支持二进制承载帧（大载荷免 b64+JSON 膨胀）。
      this.send({ kind: 'hello', proto: 1, caps: ['http', 'ws', 'pair', 'auth', 'bin'], nonce: randomUUID() });
    };
    ws.onmessage = (event) => {
      this.#metrics.framesIn += 1;
      let frame;
      try {
        // ★ 二进制消息 = 二进制承载帧（'bin' 协商后中继才可能发）；文本 = JSON 帧。
        frame = typeof event.data === 'string'
          ? decodeFrame(event.data)
          : decodeBinFrame(Buffer.isBuffer(event.data) ? event.data : Buffer.from(event.data));
      } catch (error) {
        this.#deps.audit?.({ kind: 'relay.protocol-error', reason: error.message });
        this.#closeSocket(1002, 'protocol error');
        this.#scheduleRetry(error);
        return;
      }
      this.#dispatch(frame);
    };
    ws.onclose = (event) => {
      const wasOpen = this.#state === 'open';
      this.#ws = null;
      if (this.#disposed || this.#state === 'killed') return;
      this.#metrics.lastError = `closed ${event.code} ${event.reason || ''}`.trim();
      for (const stream of this.#streams.values()) stream.wsBridge?.close();
      this.#streams.clear();
      if (wasOpen) this.#retryAttempt = 0;
      this.#scheduleRetry(new Error(`relay closed (${event.code})`));
    };
    ws.onerror = () => {
      /* onclose 会跟着来；错误细节在中继侧 */
    };
  }

  #scheduleRetry(error) {
    if (this.#disposed || this.#state === 'killed') return;
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

  #closeSocket(code, reason) {
    try {
      this.#ws?.close(code, reason);
    } catch {
      /* ignore */
    }
  }

  #dispatch(frame) {
    switch (frame.kind) {
      case 'hello-ack': {
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
      case 'ws-open': {
        const deviceId = this.#resolveDevice(frame.deviceId, frame.headers?.cookie);
        if (!deviceId) {
          this.send({ kind: 'ws-close', deviceId: frame.deviceId, streamId: frame.streamId, code: 4401 });
          return;
        }
        const bridge = openLoopbackBridge(this.#deps, {
          streamId: frame.streamId,
          path: frame.path,
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
        this.#handlePairDone(frame);
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
    this.#streams.delete(streamId);
    this.#metrics.httpRequests += 1;
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
          this.#sendHttpResponse(stream.deviceId, streamId, res, stream);
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
        isDeviceValid: Boolean(deviceId)
      });
      this.#sendHttpResponse(stream.deviceId, streamId, result, stream);
    } catch (error) {
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
    const signal = stream.streamAbort?.signal;
    try {
      for (;;) {
        if (signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        // 分片成 ≤MAX_CHUNK_BYTES 的帧
        for (let offset = 0; offset < value.length; offset += MAX_CHUNK_BYTES) {
          const chunk = value.subarray(offset, offset + MAX_CHUNK_BYTES);
          const last = offset + MAX_CHUNK_BYTES >= value.length;
          if (!this.send({ kind: 'http-res-body', deviceId, streamId, chunk: b64e(chunk), final: false })) return;
          if (!last) continue;
        }
      }
    } catch (error) {
      this.#deps.logger?.warn?.(`[kite] stream read failed: ${error.message}`);
    } finally {
      try { reader.releaseLock(); } catch { /* 已释放 */ }
    }
    // 终止帧（final: true + 空 chunk）
    this.send({ kind: 'http-res-body', deviceId, streamId, chunk: '', final: true });
  }

  #sendHttpResponse(deviceId, streamId, res, stream) {
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
    for (let offset = 0; offset < body.length || offset === 0; offset += MAX_CHUNK_BYTES) {
      const chunk = body.subarray(offset, offset + MAX_CHUNK_BYTES);
      const final = offset + MAX_CHUNK_BYTES >= body.length;
      if (!this.send({ kind: 'http-res-body', deviceId, streamId, chunk: b64e(chunk), final })) return;
      if (final) break;
    }
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

  #handlePairDone(frame) {
    try {
      const result = this.#deps.pairing.complete({ challenge: frame.challenge, sig: frame.sig, ts: frame.ts });
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
    const challenge = newChallenge();
    this.#authChallenges.set(`auth:${frame.channel}`, { challenge, deviceId });
    this.send({ kind: 'auth-challenge', channel: frame.channel, challenge });
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
      const deviceIds = (this.#deps.devices?.list?.() ?? []).map((d) => d.deviceId).filter(Boolean);
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
        else full += `&token=${encodeURIComponent(relayToken)}`;
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
      ws.onmessage = (event) => {
        let frame;
        try {
          // 预检握手只收 hello-ack（JSON 文本帧），但按协议宽容解析二进制
          frame = typeof event.data === 'string'
            ? decodeFrame(event.data)
            : decodeBinFrame(Buffer.isBuffer(event.data) ? event.data : Buffer.from(event.data));
        } catch {
          done({ ok: false, code: 'server', reason: '中继返回了无法解析的帧（部署的可能不是本中继）' });
          return;
        }
        if (frame.kind === 'hello-ack') done({ ok: true, code: 'ok', latencyMs: Date.now() - startedAt, proto: frame.proto });
        else done({ ok: false, code: 'server', reason: `中继握手返回了非预期帧（${frame.kind}）` });
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

