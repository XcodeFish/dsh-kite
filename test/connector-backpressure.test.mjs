/**
 * 回归测试（连接器侧）：大响应在「中继/链路读取变慢」时**不得静默截断**。
 *
 * 与 test/relay-backpressure.test.mjs 是**同一类错的第二处**（2026-10-03 真机事故）：
 *   - 中继侧：把 `res.write() === false`（正常背压）当致命错误 → res.destroy()，掐断响应。
 *   - 连接器侧：在**同步 for 循环**里一次性把整个 body 塞进 ws。对 9.98MB 的合并客户端
 *     模块包就是 40 帧 × 341KB ≈ 13.3MB 连续入队，同步循环期间事件循环无法推进，
 *     bufferedAmount 只增不减，必然越过 MAX_SEND_BUFFER_BYTES(8MB) → send() 返回 false
 *     → `return` 静默中断：实测旧码只发出 **32/40 帧**，剩 20% 永不发送，
 *     而且**一个 http-error 都没有**。中继侧看到的就是「响应不完整」。
 *
 * 本测试用真 RelayConnector + 真 HTTP 上游 + 一个「读得很慢」的假中继，复现该形态：
 *   旧码：bodyFrames < 总帧数，且 errorFrames 为空（静默截断 —— 正是要禁止的行为）
 *   新码：bodyFrames === 总帧数（完整送达），或至少 errorFrames 非空（显式回报）
 *
 * 为什么必须这么测：本地回环全速排空时两条路径都不会触发，旧测试因此全绿 ——
 * 这正是该 bug 能漏到线上的原因。这里刻意让假中继暂停读取来制造缓冲积压。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import wsPkg from '../relay/node_modules/ws/index.js';
import { RelayConnector } from '../transport/relay-client.js';

const { WebSocketServer } = wsPkg;
const TOKEN = 'ra-test-token-0123456789abcdef';
/**
 * ★ 尺寸必须取**生产实测的那个值**（10461917 B = 9.98MB 合并客户端模块包）。
 *   这个数不是随便挑的 —— 实测标定：
 *     8.0MB：旧码仍能侥幸发完（32 帧 × 341KB = 10.9MB 入队，但内核在同步循环里
 *            排空了足够多）→ 测试假绿；
 *     9.98MB：旧码稳定截断在 32/40 帧 → 测试真红。
 *   回归测试的尺寸若小于真机值，就会退化成「永远绿的摆设」。
 */
const SIZE = Number(process.env.BP_TEST_SIZE || 10461917);
const CHUNK = 256 * 1024;
const TOTAL_FRAMES = Math.ceil(SIZE / CHUNK);

function startUpstream() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/javascript', 'content-length': String(SIZE) });
    res.end(Buffer.alloc(SIZE, 0x2f));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

/** 假中继：握手后要一个资源，并在一段时间内**暂停读取**，把连接器发送缓冲顶起来。 */
function startSlowRelay() {
  const wss = new WebSocketServer({ port: 0 });
  const state = { bodyFrames: 0, errorFrames: [], head: null, paused: false };
  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => {
      let frame;
      try {
        frame = JSON.parse(isBinary ? data.toString('utf8').split('\u0000')[0] : data.toString('utf8'));
      } catch {
        return;
      }
      if (frame.kind === 'hello') {
        ws.send(JSON.stringify({ kind: 'hello-ack', proto: 1, caps: ['http', 'ws', 'pair', 'auth', 'bin'] }));
        setTimeout(() => {
          ws.send(JSON.stringify({
            kind: 'http-head', deviceId: 'pair', streamId: 's1', method: 'GET',
            path: '/plugins/??big/client.js', headers: { cookie: '', 'content-type': '', 'accept-encoding': 'identity' }
          }));
          // http-head 只登记流；http-body(final) 才真正触发转发（协议两段式）。
          ws.send(JSON.stringify({ kind: 'http-body', deviceId: 'pair', streamId: 's1', chunk: '', final: true }));
        }, 60);
        return;
      }
      if (frame.kind === 'http-res-head') {
        state.head = { status: frame.status, contentLength: frame.headers?.['content-length'] };
        return;
      }
      if (frame.kind === 'http-res-body') {
        state.bodyFrames += 1;
        // 第 3 帧后暂停读取 3 秒 —— 制造连接器侧发送缓冲积压（真机公网链路的形态）。
        if (state.bodyFrames === 3 && !state.paused) {
          state.paused = true;
          try { ws._socket.pause(); } catch { /* 某些实现拿不到底层 socket */ }
          setTimeout(() => { try { ws._socket.resume(); } catch { /* ignore */ } }, 3000);
        }
        return;
      }
      if (frame.kind === 'http-error') state.errorFrames.push(frame.code ?? 'unknown');
    });
  });
  return new Promise((resolve) => wss.on('listening', () => resolve({ wss, port: wss.address().port, state })));
}

function makeConnector(relayPort, upstreamPort) {
  return new RelayConnector({
    relayUrl: `ws://127.0.0.1:${relayPort}`,
    relayToken: TOKEN,
    connectorId: 'bp-regression',
    devices: { isActive: () => true, touch: () => {}, snapshot: () => [], list: () => [], revoke: () => {} },
    tickets: { verify: () => 'probe-device' },
    pairing: {
      submit: async () => ({ challenge: 'c', code: '000000' }),
      complete: async () => ({ deviceId: 'd', code: '000000', setCookie: 'ra-device=x' })
    },
    policy: { decide: () => ({ action: 'allow' }) },
    credential: {
      acquire: async () => ({ base: `http://127.0.0.1:${upstreamPort}`, cookie: 'dsh-auth-x=1' }),
      invalidate: () => {}
    },
    keys: {},
    audit: () => {},
    logger: { warn: () => {}, info: () => {} },
    isKilled: () => false
  });
}

test('连接器：大响应在中继读得慢时必须完整送达，不得静默截断', async (t) => {
  const { server: upstream, port: upstreamPort } = await startUpstream();
  const { wss, port: relayPort, state } = await startSlowRelay();
  const connector = makeConnector(relayPort, upstreamPort);
  t.after(() => {
    try { connector.dispose?.(); } catch { /* ignore */ }
    wss.close();
    upstream.close();
  });

  connector.start?.();
  /**
   * 轮询到「发完」或「出现显式错误」为止，最长 25 秒。
   * 不用固定 sleep：那会让这个测试无条件占用 20 秒（首版实测 20.0s），
   * 而正常路径下它几百毫秒就能完成。
   */
  const deadline = Date.now() + 25_000;
  let lastFrames = -1;
  let lastChangeAt = Date.now();
  while (Date.now() < deadline) {
    if (state.bodyFrames >= TOTAL_FRAMES || state.errorFrames.length > 0) break;
    if (state.bodyFrames !== lastFrames) { lastFrames = state.bodyFrames; lastChangeAt = Date.now(); }
    // 停滞检测：连接器侧 4 秒没有任何新帧，且尚未发完 —— 旧码的静默截断就是这个形态
    // （帧数卡住不动、也没有任何错误帧）。提前判定，不必干等满 25 秒。
    if (Date.now() - lastChangeAt > 4000 && lastFrames >= 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // 上游确实被转发到了一个 10MB 级响应（证明测的是大响应路径，而不是走了错误分支）。
  assert.equal(state.head?.status, 200, `响应头异常：${JSON.stringify(state.head)}`);
  assert.equal(Number(state.head?.contentLength), SIZE, `content-length 不符：${state.head?.contentLength}`);

  /**
   * 核心判据（两种可接受结果，二者必居其一）：
   *   ① 完整送达所有分片；或
   *   ② 未能完整送达时**必须**有显式 http-error 帧。
   * 唯一禁止的是「既没发完、又没有任何错误信号」——那正是旧码的静默截断。
   */
  const complete = state.bodyFrames >= TOTAL_FRAMES;
  const reported = state.errorFrames.length > 0;
  assert.ok(
    complete || reported,
    `静默截断：仅发出 ${state.bodyFrames}/${TOTAL_FRAMES} 帧（约 ${((state.bodyFrames * CHUNK) / 1048576).toFixed(1)}MB / ${(SIZE / 1048576).toFixed(1)}MB），且没有任何 http-error 帧`
  );
  // 更进一步：本场景（暂停 3 秒后恢复）应当能靠等待排空而完整送达。
  assert.ok(
    complete,
    `预期能靠等待排空完整送达，实际只发出 ${state.bodyFrames}/${TOTAL_FRAMES} 帧`
  );
});
