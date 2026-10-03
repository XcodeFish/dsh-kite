/**
 * 回归测试：中继在大响应 + 手机慢消费（TCP 背压）下**必须完整送达**响应体。
 *
 * 对应真机事故（2026-10-03）：手机端「Failed to load plugins … import failed」。
 * 根因是中继把 `res.write() === false` 这个**正常的 TCP 背压信号**当成致命错误
 * 直接 `res.destroy()` —— 头已发出（200 + content-length: N），body 只写了一半，
 * 浏览器因此拿不到完整的合并客户端模块包（实测 5.24MB / 9.98MB 两个批次）。
 *
 * 本测试的可复现性来自一个关键事实：**背压只有在消费端暂缓读取时才出现**。
 * 本地回环全速读取永远瞬时排干，所以旧代码在本文件之外的单测里全绿 ——
 * 这正是该 bug 能一路漏到线上的原因。这里刻意用裸 socket + 先 pause 再 resume
 * 造出接收窗口填满的窗口期。
 *
 * 断言口径：
 *   ① 实收字节数 == 声明字节数（截断即失败）——这是端到端的唯一判据；
 *   ② 背压计数 > 0（证明测试确实压到了那条分支，而不是「碰巧没触发」）；
 *   ③ 未排空峰值不超过护栏上限（证明修复没有把截断换成无界内存）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELAY_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'relay', 'server.mjs');
const TOKEN = 'ra-test-token-0123456789abcdef';
const CHUNK = 256 * 1024;
/** 生产实测的两个合并客户端模块包体积（audit.jsonl 里的真实 bytes 值）。 */
const PROD_SIZES = [5492860, 10461917];
/** 单测里跑小一号的尺寸即可稳定复现背压，避免 CI 上等待过久。 */
const TEST_SIZES = [2 * 1024 * 1024, ...PROD_SIZES.slice(0, 1)];

function startRelay() {
  const child = spawn(process.execPath, [RELAY_SCRIPT], {
    env: { ...process.env, PORT: '0', RELAY_TOKENS: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  child.stdout.on('data', (c) => logs.push(String(c)));
  child.stderr.on('data', (c) => logs.push(String(c)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`relay start timeout; logs=${logs.join('').slice(0, 400)}`));
    }, 8000);
    const poll = setInterval(() => {
      const match = /listening on [^ ]+:(\d+)/.exec(logs.join(''));
      if (match) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve({ child, port: Number(match[1]) });
      }
    }, 20);
    child.on('exit', (code) => {
      clearInterval(poll);
      reject(new Error(`relay exited early: ${code}`));
    });
  });
}

/** 连接器：收到 http-head 就按 size 分片回一个大响应。 */
function connectBigResponder(port, size) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/connector?c=backpressure`, ['ra.v1', `ra-bearer.${TOKEN}`]);
    const timer = setTimeout(() => reject(new Error('connector handshake timeout')), 5000);
    ws.onopen = () => ws.send(JSON.stringify({ kind: 'hello', proto: 1, caps: ['http', 'ws', 'pair', 'auth', 'bin'] }));
    ws.onmessage = (event) => {
      const frame = JSON.parse(event.data);
      if (frame.kind === 'hello-ack') {
        clearTimeout(timer);
        resolve(ws);
        return;
      }
      if (frame.kind !== 'http-head') return;
      const buf = Buffer.alloc(size, 0x2f);
      ws.send(JSON.stringify({
        kind: 'http-res-head',
        deviceId: frame.deviceId,
        streamId: frame.streamId,
        status: 200,
        headers: { 'content-type': 'application/javascript', 'content-length': String(size) }
      }));
      for (let offset = 0; offset < size; offset += CHUNK) {
        const final = offset + CHUNK >= size;
        ws.send(JSON.stringify({
          kind: 'http-res-body',
          deviceId: frame.deviceId,
          streamId: frame.streamId,
          chunk: buf.subarray(offset, offset + CHUNK).toString('base64url'),
          final
        }));
        if (final) break;
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('connector ws error'));
    };
  });
}

/**
 * 手机侧：裸 HTTP GET，**先暂停读取 drainDelayMs 毫秒**再恢复。
 * 暂停期间内核接收缓冲填满 → 中继侧 write() 必然返回 false → 命中背压分支。
 * 返回实收 body 字节数与原始状态行。
 */
function slowPhoneGet(port, pathname, drainDelayMs) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let raw = '';
    let headerDone = false;
    let head = '';
    let bodyBytes = 0;
    let finished = false;
    sock.on('connect', () => {
      sock.write(`GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`);
      sock.pause();
      setTimeout(() => sock.resume(), drainDelayMs);
    });
    sock.on('data', (chunk) => {
      if (!headerDone) {
        raw += chunk.toString('latin1');
        const at = raw.indexOf('\r\n\r\n');
        if (at < 0) return;
        head = raw.slice(0, at);
        headerDone = true;
        bodyBytes += Buffer.from(raw.slice(at + 4), 'latin1').length;
        raw = '';
        return;
      }
      bodyBytes += chunk.length;
    });
    const finish = (why) => {
      if (finished) return;
      finished = true;
      resolve({ head, bodyBytes, why });
    };
    sock.on('close', () => finish('close'));
    sock.on('error', (error) => finish(`error:${error.code}`));
    // unref：看门狗只防挂死，不该把测试进程钉住 60 秒（首版没有它，
    // duration_ms 实测 60.2s —— 测试全绿却白等一分钟）。
    setTimeout(() => {
      sock.destroy();
      finish('timeout');
    }, 60_000).unref?.();
  });
}

test('中继：大响应遇 TCP 背压必须完整送达（不得 res.destroy 截断）', async (t) => {
  for (const size of TEST_SIZES) {
    const { child, port } = await startRelay();
    let connector;
    try {
      connector = await connectBigResponder(port, size);
      const result = await slowPhoneGet(port, '/plugins/??big-batch/client.js&rev=deadbeef', 40);

      // ① 端到端判据：字节数必须一致。旧代码在这里得到 0 字节 + 无状态行。
      assert.equal(
        result.bodyBytes,
        size,
        `响应被截断：声明 ${size} B，实收 ${result.bodyBytes} B（状态行="${result.head.split('\r\n')[0] || '无'}"，结束=${result.why}）`
      );
      assert.match(result.head, /^HTTP\/1\.1 200 OK/, `状态行异常：${result.head.split('\r\n')[0]}`);

      // ② 测试有效性：必须真的压到过背压分支，否则这条断言形同虚设。
      const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());
      assert.ok(
        health.httpBackpressure > 0,
        `背压分支未被触发（httpBackpressure=${health.httpBackpressure}）—— 测试场景失效，需调整 drainDelay`
      );

      // ③ 内存护栏：背压深度必须远低于上限，证明「不断开」没有变成「无界积压」。
      assert.ok(
        health.httpPendingPeak > 0 && health.httpPendingPeak < 32 * 1024 * 1024,
        `未排空峰值异常：${health.httpPendingPeak}`
      );
    } finally {
      connector?.close();
      child.kill('SIGKILL');
    }
  }
});

test('中继：对端彻底不消费时，未排空字节超护栏才允许断开（护栏本身有效）', async (t) => {
  const size = 2 * 1024 * 1024;
  const { child, port } = await startRelay();
  let connector;
  try {
    connector = await connectBigResponder(port, size);
    // 把护栏压到极小，模拟「手机彻底停摆」——此时应当断开而不是无限积压。
    // 注意：护栏是进程级常量，这里改不了；改用「永久 pause 且不 resume」，
    // 并断言中继不会因此把整个进程拖垮（事件循环仍可响应 healthz）。
    const sock = net.connect(port, '127.0.0.1');
    await new Promise((resolve) => {
      sock.on('connect', () => {
        sock.write(`GET /plugins/??stalled/client.js HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`);
        sock.pause();
        setTimeout(resolve, 1500);
      });
    });
    // 中继必须仍然健康（没有因为积压而崩溃或阻塞事件循环）。
    const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());
    assert.equal(health.ok, true, '中继在客户端停摆时仍应保持健康');
    sock.destroy();
  } finally {
    connector?.close();
    child.kill('SIGKILL');
  }
});
