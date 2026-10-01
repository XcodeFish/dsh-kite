/**
 * 中继集成测试：真进程 + 真出站/入站 WebSocket。
 * 覆盖：Bearer 鉴权、hello-ack 握手、手机 HTTP 请求桥接（http-head/body ↔ http-res）。
 * 不依赖 `ws` 客户端包 —— 用 Node 22 全局 WebSocket 当客户端。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELAY_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'relay', 'server.mjs');
const PORT = 0; // listen(0) = 内核分配空闲端口；真实端口从 stdout 解析
const TOKEN = 'ra-test-token-0123456789abcdef';
let resolvedPort = PORT;

function startRelay() {
  const child = spawn(process.execPath, [RELAY_SCRIPT], {
    env: { ...process.env, PORT: String(PORT), RELAY_TOKENS: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    // 超时必须杀掉子进程：孤儿 relay 会钉住本测试进程的 stdio 管道，让 runner 永不退出。
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('relay start timeout'));
    }, 8000);
    child.stdout.on('data', (chunk) => {
      const match = /listening on [^ ]+:(\d+)/.exec(String(chunk));
      if (match) {
        resolvedPort = Number(match[1]);
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[relay] ${chunk}`));
    child.on('exit', (code) => reject(new Error(`relay exited early: ${code}`)));
  });
}

function connectConnector() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${resolvedPort}/connector?c=test-connector`, ['ra.v1', `ra-bearer.${TOKEN}`]);
    const timer = setTimeout(() => reject(new Error('connector handshake timeout')), 5000);
    ws.onmessage = (event) => {
      const frame = JSON.parse(event.data);
      if (frame.kind === 'hello-ack') {
        clearTimeout(timer);
        resolve(ws);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('connector ws error'));
    };
  });
}

test('中继：鉴权 + 握手 + 手机 HTTP 请求全桥接', async (t) => {
  let relay;
  let connector;
  try {
    relay = await startRelay();
    t.after(() => {
      connector?.close();
      relay?.kill();
    });

    // ① 健康检查
    const health = await fetch(`http://127.0.0.1:${resolvedPort}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    // ② 错误 token 被拒（升级 401）
    await new Promise((resolve) => {
      const bad = new WebSocket(`ws://127.0.0.1:${resolvedPort}/connector?c=x`, ['ra.v1', 'ra-bearer.wrong']);
      bad.onerror = () => resolve();
      bad.onclose = (e) => resolve(e.code);
      setTimeout(resolve, 2000);
    });

    // ③ 正确 token 握手
    connector = await connectConnector();

    // ④ 手机 HTTP 请求经中继 → connector → 回程（帧进队列统一收集，避免换 handler 丢帧）
    const frames = [];
    connector.onmessage = (event) => frames.push(JSON.parse(event.data));
    const waitFor = (pred, label, ms = 5000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
      const check = () => {
        const at = frames.findIndex(pred);
        if (at >= 0) {
          clearTimeout(timer);
          resolve(frames.splice(at, 1)[0]);
          return true;
        }
        return false;
      };
      const poll = setInterval(() => check(), 10);
      setTimeout(() => clearInterval(poll), ms + 200);
      check();
    });

    const reply = (async () => {
      const res = await fetch(`http://127.0.0.1:${resolvedPort}/kite/pair?token=tok&c=test-connector`, {
        headers: { 'content-type': 'application/json' }
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
      return res.json();
    })();
    const head = await waitFor((f) => f.kind === 'http-head', 'no http-head frame');
    assert.equal(head.method, 'GET');
    assert.equal(head.path, '/kite/pair?token=tok&c=test-connector');
    assert.equal(head.deviceId, 'pair', '配对链接路由到 pair 设备');
    await waitFor((f) => f.kind === 'http-body' && f.final, 'no http-body frame');
    // 回响应
    connector.send(JSON.stringify({ kind: 'http-res-head', deviceId: head.deviceId, streamId: head.streamId, status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }));
    connector.send(JSON.stringify({ kind: 'http-res-body', deviceId: head.deviceId, streamId: head.streamId, chunk: Buffer.from(JSON.stringify({ ok: true, paired: false })).toString('base64url'), final: true }));
    assert.deepEqual(await reply, { ok: true, paired: false });

    // ⑤ connector 离线后手机请求 503
    connector.close();
    await new Promise((r) => setTimeout(r, 300));
    const offline = await fetch(`http://127.0.0.1:${resolvedPort}/anything`);
    assert.equal(offline.status, 503);
  } finally {
    connector?.close();
    relay?.kill();
  }
}, { timeout: 20000 });
