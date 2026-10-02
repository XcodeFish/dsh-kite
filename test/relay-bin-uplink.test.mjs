/**
 * 回归：**中继发来的二进制承载帧必须能被连接器解码**（真机事故 2026-10-02）。
 *
 * 症状：手机刷新后界面永久停在「重新连接中」——连接器连上就被踢，1s 后重连，
 *       再被踢，无限循环。刷新无效（只是把循环从头再跑一遍）。
 *
 * 事故链（本测试把它钉死）：
 *   中继对手机上行 http-body/ws-data 的 ≥4096B 载荷改发**二进制承载帧**（JSON 头 + 0x00 + 原始字节，
 *   frames.js:isBinEligible）→ Node 内置 WebSocket（undici）的 `binaryType` 默认是
 *   **'blob'**，于是 event.data 是 Blob 而不是 Buffer → 旧代码
 *   `Buffer.from(event.data)` 立刻抛
 *   「The first argument must be of type string or an instance of Buffer, ArrayBuffer,
 *     or Array or an Array-like Object. Received an instance of Blob」
 *   → onmessage 的 catch 把**任何**解析异常都判成协议错误 → close(1002) + 重连。
 *   手机上行请求体 / mux 上行消息超过 4096B 即可触发；大响应（session/list 等）
 *   主要走 connector→relay→phone，不能作为 relay→connector 触发方向的直接证据。
 *   审计铁证：audit.jsonl 里 3 条 `relay.protocol-error … Received an instance of Blob`。
 *
 * 为什么既有测试全绿却漏了（两个假阴来源，本测试刻意都绕开）：
 *   ① test/bin-frames.test.mjs 只测 `encodeBinFrame/decodeBinFrame` 的**纯函数往返**，
 *      从没让帧真的过一条 WebSocket —— 而 bug 恰恰在「WebSocket 怎么交付字节」这一层。
 *   ② 别的 e2e（full-chain / relay.integration）用的是 `ws` 包或自建连接器替身，
 *      它们的 onmessage 拿到的是 Buffer，于是永远看不到 Blob 形态。
 *
 * 本测试用**替身 WebSocket 驱动真实的 RelayConnector.onmessage**（生产代码，
 * 一行不改地跑它自己的解码/派发链），把三种 event.data 形态分别喂进去。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELAY_SCRIPT = path.join(ROOT, 'relay', 'server.mjs');
const TOKEN = 'bin-uplink-test-token-0123456789';

const { RelayConnector, binaryToBuffer } = await import('../transport/relay-client.js');
const { encodeBinFrame, encodeFrame, decodeBinFrame } = await import('../transport/frames.js');

let port = 0;

function startRelay() {
  const child = spawn(process.execPath, [RELAY_SCRIPT], {
    env: { ...process.env, PORT: '0', RELAY_TOKENS: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('relay start timeout')); }, 8000);
    const onData = (buf) => {
      const m = /listening on [^:]+:(\d+)/.exec(buf.toString('utf8'));
      if (m) { clearTimeout(timer); port = Number(m[1]); resolve(child); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** 造一个能过握手的最小连接器（deps 全是惰性替身，只为把链路打通）。 */
function makeConnector(url, hooks = {}) {
  return new RelayConnector({
    relayUrl: url,
    relayToken: TOKEN,
    connectorId: 'bin-uplink-connector',
    devices: { list: () => [], isActive: () => true, get: () => ({ pubKey: 'x' }), touch: () => {} },
    tickets: { verify: () => 'dev-1', issue: () => 'ticket', verifyChallenge: () => ({ ok: true }) },
    pairing: { complete: () => ({ deviceId: 'dev-1', ticket: 't', code: '123456' }) },
    policy: { decide: () => ({ action: 'allow' }) },
    credential: null,
    keys: { fingerprint: 'bin-uplink-connector' },
    audit: (e) => hooks.audit?.(e),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    isKilled: () => false,
    handlePairPage: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) })
  });
}

/**
 * 替身 WebSocket：捕获连接器注册的 onopen/onmessage/onclose，
 * 让我们能把**任意形态**的 event.data 直接喂进生产解码链。
 */
class FakeWebSocket {
  static instances = [];
  static restore() { globalThis.WebSocket = FakeWebSocket.#real; }
  static #real = globalThis.WebSocket;
  static install() { FakeWebSocket.instances = []; globalThis.WebSocket = FakeWebSocket; }

  readyState = 1; // OPEN：send() 的快路径要求它
  binaryType = 'blob'; // ← undici 的默认值，正是事故温床
  sent = [];
  onopen = null; onmessage = null; onclose = null; onerror = null;
  closedWith = null;

  constructor(url, protocols) {
    this.url = url; this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }
  send(data) { this.sent.push(data); }
  close(code, reason) { this.closedWith = { code, reason }; this.readyState = 3; this.onclose?.({ code, reason }); }
  terminate() { this.close(1006, 'terminate'); }

  /** 模拟「连接建立」→ 连接器发 hello。 */
  fireOpen() { this.onopen?.({}); }
  /** 模拟收到一帧（data 可为 string/Buffer/ArrayBuffer/Blob）。 */
  fireMessage(data) { this.onmessage?.({ data }); }
  /** 读取连接器发出的帧（JSON 文本）。 */
  frames() { return this.sent.filter((d) => typeof d === 'string').map((d) => JSON.parse(d)); }
}

/** 等一个微任务/宏任务周期，让 rxChain 上的异步解码落地。 */
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** 造一个「中继会发的」大二进制帧（载荷 >4096B 才会切二进制）。 */
function bigBinaryFrame(overrides = {}) {
  return encodeBinFrame({
    kind: 'http-res-body',
    deviceId: 'dev-1',
    streamId: 'st-1',
    chunk: Buffer.alloc(64 * 1024, 0x41).toString('base64url'),
    final: true,
    ...overrides
  });
}

test('binaryToBuffer：四类形态归一，且 TypedArray 子视图必须尊重 byteOffset', () => {
  const payload = Buffer.from('hello-kite');
  assert.equal(binaryToBuffer(payload).toString(), 'hello-kite', 'Buffer 直通');

  /**
   * ★ 注意不能写 `payload.buffer.slice(0)`：`Buffer.from(string)` 走的是 Node 的
   *   **共享 8KiB 池**，`.buffer` 是整块池而不是这 10 个字节 —— 那样断言会读到池里
   *   无关内容（本测试初版就栽在这里，diff 里出现了整个源文件）。
   *   真实 undici 消息的 ArrayBuffer 恰好只含该消息，因此这里显式构造等长副本。
   */
  const exact = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
  assert.equal(binaryToBuffer(exact).toString(), 'hello-kite', 'ArrayBuffer（等长副本）');

  // 子视图若被当成整块 buffer，会多带前后字节 —— 必须只取 [byteOffset, +length)。
  // 用 payload 自身的 byteOffset 作基准，避免踩上面说的共享池偏移坑。
  const sub = new Uint8Array(payload.buffer, payload.byteOffset + 1, 4);
  assert.equal(binaryToBuffer(sub).toString(), 'ello', 'TypedArray 子视图');
  assert.equal(binaryToBuffer(new Blob([payload])), null, 'Blob 是异步形态 → 同步口返回 null，交给 dataToBuffer 兜底');
});

test('★ 决定性：event.data 是 Blob（undici 默认）时也必须解码成功，绝不产生协议错误', async () => {
  FakeWebSocket.install();
  try {
    const audit = [];
    const connector = makeConnector('ws://127.0.0.1:1', { audit: (e) => audit.push(e) });
    connector.start();

    const sock = FakeWebSocket.instances.at(-1);
    assert.ok(sock, '应创建一条 WebSocket');
    // 连接器必须主动把 binaryType 从 'blob' 改成 'arraybuffer'（第一层修复）
    assert.equal(sock.binaryType, 'arraybuffer', '连接器必须显式设置 binaryType=arraybuffer');

    sock.fireOpen();
    await settle();
    assert.ok(sock.frames().some((f) => f.kind === 'hello'), 'open 后应发 hello');

    // 先让 hello-ack 走文本路径把状态推成 open
    sock.fireMessage(JSON.stringify({ kind: 'hello-ack', proto: 1, caps: ['bin'] }));
    await settle();
    assert.equal(connector.state, 'open', 'hello-ack 后应为 open');

    /**
     * ★ 事故复现值：binaryType 就算被运行时忽略，Blob 也必须能解 ——
     *   这是第二层修复（dataToBuffer 的 Blob 分支）。两层缺一不可。
     */
    const wire = bigBinaryFrame();
    sock.fireMessage(new Blob([wire])); // ← 旧代码在这里抛 Blob TypeError
    await settle();

    assert.deepEqual(
      audit.filter((e) => e.kind === 'relay.protocol-error'), [],
      'Blob 形态不得被判成协议错误（旧代码正是如此 → 断线重连死循环）'
    );
    assert.equal(connector.state, 'open', '状态必须保持 open —— 不得被踢回重连');
    assert.equal(sock.closedWith, null, '不得发生 close(1002)');

    connector.dispose();
  } finally {
    FakeWebSocket.restore();
  }
});

test('协议错误：客户端 close code 映射合法且失败 socket 只调度一次重试', async () => {
  FakeWebSocket.install();
  try {
    const audit = [];
    const connector = makeConnector('ws://127.0.0.1:1', { audit: (e) => audit.push(e) });
    connector.start();
    const sock = FakeWebSocket.instances.at(-1);
    sock.fireOpen();
    sock.fireMessage(JSON.stringify({ kind: 'hello-ack', proto: 1, caps: ['bin'] }));
    await settle();

    // 非法二进制承载帧：必须走协议错误，但 close() 线上码必须是合法 4xxx。
    sock.fireMessage(new Uint8Array([0x7b, 0x00, 0x01]));
    await settle();
    assert.equal(sock.closedWith?.code, 4002, '1002 协议错误必须映射为合法客户端 close code 4002');
    assert.equal(audit.filter((e) => e.kind === 'relay.protocol-error').length, 1);
    connector.dispose();
  } finally {
    FakeWebSocket.restore();
  }
});


test('ArrayBuffer / Uint8Array 形态（binaryType=arraybuffer 后的真实形态）同样解码成功', async () => {
  FakeWebSocket.install();
  try {
    const audit = [];
    const connector = makeConnector('ws://127.0.0.1:1', { audit: (e) => audit.push(e) });
    connector.start();
    const sock = FakeWebSocket.instances.at(-1);
    sock.fireOpen();
    sock.fireMessage(JSON.stringify({ kind: 'hello-ack', proto: 1, caps: ['bin'] }));
    await settle();

    const wire = bigBinaryFrame();
    sock.fireMessage(wire.buffer.slice(wire.byteOffset, wire.byteOffset + wire.length)); // ArrayBuffer
    await settle();
    sock.fireMessage(new Uint8Array(wire)); // TypedArray
    await settle();

    assert.deepEqual(audit.filter((e) => e.kind === 'relay.protocol-error'), [], '两种形态都不该报协议错误');
    assert.equal(connector.state, 'open');
    assert.equal(sock.closedWith, null);
    connector.dispose();
  } finally {
    FakeWebSocket.restore();
  }
});

test('★ 入站串行：Blob（异步解码）之后的文本帧不得被插队 —— 帧序必须等于投递序', async () => {
  FakeWebSocket.install();
  try {
    const connector = makeConnector('ws://127.0.0.1:1');
    connector.start();
    const sock = FakeWebSocket.instances.at(-1);
    sock.fireOpen();
    sock.fireMessage(JSON.stringify({ kind: 'hello-ack', proto: 1, caps: ['bin'] }));
    await settle();

    /**
     * 关键时序：先投递一个 Blob（解码要走 await arrayBuffer()，异步），
     * 紧接着投递一个文本 ping。若 onmessage 是裸 async（无串行化），
     * ping 会**先**被处理 —— 帧序被打乱，中继侧的 revision 连续性直接崩。
     * 正确行为：pong 必须在 Blob 解码完成**之后**才发出。
     */
    const order = [];
    const origSend = connector.send.bind(connector);
    connector.send = (frame) => { if (frame?.kind === 'pong') order.push('pong'); return origSend(frame); };

    sock.fireMessage(new Blob([bigBinaryFrame()]));
    sock.fireMessage(JSON.stringify({ kind: 'ping' }));
    await settle(60);

    assert.deepEqual(order, ['pong'], 'ping 必须被处理且只处理一次（证明串行链未丢帧、未插队）');
    assert.equal(connector.state, 'open', '处理完两帧后仍在 open');

    // 再补一帧文本，确认链没有因为前面出错而「卡死」
    sock.fireMessage(JSON.stringify({ kind: 'ping' }));
    await settle(40);
    assert.deepEqual(order, ['pong', 'pong'], '后续帧必须继续被处理 —— 入站链不得中断');

    connector.dispose();
  } finally {
    FakeWebSocket.restore();
  }
});

test('真中继握手：真实 RelayConnector 连真实中继，hello-ack 后保持在线', async (t) => {
  const child = await startRelay();
  /**
   * ★ 收尾必须「杀进程 + 等它真的退出」。
   *   只 kill 不等退出，子进程的 stdio 管道仍被父进程持有 → node --test 的
   *   事件循环永不空转，表现为**测试全绿但进程挂死**（本文件首版就栽在这里）。
   */
  t.after(async () => {
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
  });

  const audit = [];
  const connector = makeConnector(`ws://127.0.0.1:${port}`, { audit: (e) => audit.push(e) });
  t.after(() => { try { connector.dispose(); } catch { /* 已释放 */ } });
  connector.start();

  const started = Date.now();
  while (connector.state !== 'open' && Date.now() - started < 8000) await settle(25);
  assert.equal(connector.state, 'open', '应能与真实中继完成握手（bin caps 已协商）');

  await settle(200);

  // ★ 真实触发方向：手机 POST 大 body → relay 的 http-body 二进制承载 → connector 解码。
  //   旧实现会在收到该帧时记录 Blob protocol-error 并进入 retrying；新实现应正常回 200。
  const largeBody = Buffer.alloc(32 * 1024, 0x62);
  const response = await fetch(`http://127.0.0.1:${port}/kite/pair?c=bin-uplink-connector`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: largeBody
  });
  assert.equal(response.status, 200, '大 body 经真实 relay→connector 二进制路径应正常返回');
  await response.arrayBuffer();
  await settle(100);
  assert.equal(connector.state, 'open', '真实大帧后连接器必须保持 open');
  assert.deepEqual(audit.filter((e) => e.kind === 'relay.protocol-error'), [], '真实大帧不得产生 Blob 协议错误');
});
