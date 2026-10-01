/**
 * 中继集成测试：真进程 + 真出站/入站 WebSocket。
 * 覆盖：Bearer 鉴权、hello-ack 握手、手机 HTTP 请求桥接（http-head/body ↔ http-res）、
 * 多连接器路由（c 参数精确匹配）、僵尸连接器剔除（keepalive）。
 * 不依赖 `ws` 客户端包 —— 用 Node 22 全局 WebSocket 当客户端。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELAY_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'relay', 'server.mjs');
const PORT = 0; // listen(0) = 内核分配空闲端口；真实端口从 stdout 解析
const TOKEN = 'ra-test-token-0123456789abcdef';
let resolvedPort = PORT;

function startRelay(extraEnv = {}) {
  const child = spawn(process.execPath, [RELAY_SCRIPT], {
    env: { ...process.env, PORT: String(PORT), RELAY_TOKENS: TOKEN, ...extraEnv },
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

function connectConnector(id = 'test-connector') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${resolvedPort}/connector?c=${id}`, ['ra.v1', `ra-bearer.${TOKEN}`]);
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

/** 连接器帧收集器：http-head 等待 + 断言辅助（多连接器测试各挂一个）。 */
function collectFrames(ws) {
  const frames = [];
  ws.onmessage = (event) => frames.push(JSON.parse(event.data));
  const waitFor = (pred, label, ms = 5000) => new Promise((resolve, reject) => {
    // ★ 命中/超时都必须立刻停掉轮询：否则上一个 waitFor 的「僵尸轮询」会把它
    //   已 settle 的谓词继续拿来匹配新帧 —— 新到的 http-head 被抢先 splice 走，
    //   下一个 waitFor 永远等不到（本测试首跑即栽在这里，表现为 5s 假超时）。
    const timer = setTimeout(() => { clearInterval(poll); reject(new Error(`${label} timeout`)); }, ms);
    const check = () => {
      const at = frames.findIndex(pred);
      if (at >= 0) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(frames.splice(at, 1)[0]);
      }
      return at >= 0;
    };
    const poll = setInterval(check, 10);
    check();
  });
  return { frames, waitFor };
}

/** 构造一个「解析成功但设备表里不存在」的 ra-device cookie（模拟刚配对的全新设备）。 */
function unknownDeviceCookie() {
  const payload = Buffer.from(JSON.stringify({ deviceId: 'dev-unknown' })).toString('base64url');
  return `ra-device=v1.${payload}.x`;
}

/**
 * 手写 WS 握手的「尸体」连接器：升级成功后对 ping 永不应答（模拟 TCP 半开 ——
 * 真实世界里休眠/断网的桌面端就是这个样子；协议栈会自动回 pong，所以必须裸 socket）。
 */
function openCorpseConnector(port) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        `GET /connector?c=corpse HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `Sec-WebSocket-Protocol: ra.v1, ra-bearer.${TOKEN}\r\n\r\n`);
    });
    let buf = '';
    const ondata = (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        sock.removeListener('data', ondata); // 此后故意不读不回 —— ping 无人应答
        if (/^HTTP\/1\.1 101/.test(buf)) resolve(sock);
        else { sock.destroy(); reject(new Error(`corpse handshake rejected: ${buf.split('\r\n')[0]}`)); }
      }
    };
    sock.on('data', ondata);
    sock.on('error', () => { /* 被服务端 terminate 时走这里，静默 */ });
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

test('中继：多连接器时 c 参数精确路由，不抽奖（2026-10-01 配对卡死回归）', async (t) => {
  let relay;
  let connectorA;
  let connectorB;
  try {
    relay = await startRelay();
    t.after(() => {
      connectorA?.close();
      connectorB?.close();
      relay?.kill();
    });

    // A 先连（成为 Map 里「第一个连接器」—— 旧实现把无确定键的请求全投给它），B 后连。
    connectorA = await connectConnector('test-a');
    connectorB = await connectConnector('test-b');
    const a = collectFrames(connectorA);
    const b = collectFrames(connectorB);
    // 刚配对的手机：cookie 里是全新 deviceId（设备表必然查不到），URL 带 c=test-b。
    const cookie = unknownDeviceCookie();

    // ① /kite/welcome?c=test-b：cookie 提示未命中 → 必须靠 c 参数精确命中 B。
    //    redirect:'manual'：若 follow，undici 会立刻跟进 302 发起 /?c=test-b，
    //    而本测试尚未应答它 → 自锁到 110s 看门狗（首跑踩过的坑）。
    const welcomeResPromise = fetch(`http://127.0.0.1:${resolvedPort}/kite/welcome?c=test-b`, { headers: { cookie }, redirect: 'manual' });
    welcomeResPromise.catch(() => {}); // 失败路径不产生 unhandled rejection
    const head = await b.waitFor((f) => f.kind === 'http-head', 'welcome http-head @B');
    assert.equal(head.path, '/kite/welcome?c=test-b');
    assert.equal(head.deviceId, 'pair');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(a.frames.filter((f) => f.kind === 'http-head' && f.streamId === head.streamId).length, 0,
      'welcome 请求不得投给连接器 A（旧实现会投给「第一个连接器」）');

    connectorB.send(JSON.stringify({ kind: 'http-res-head', deviceId: head.deviceId, streamId: head.streamId, status: 302, headers: { location: '/?c=test-b', 'cache-control': 'no-store' } }));
    connectorB.send(JSON.stringify({ kind: 'http-res-body', deviceId: head.deviceId, streamId: head.streamId, chunk: '', final: true }));
    const welcomeRes = await welcomeResPromise;
    assert.equal(welcomeRes.status, 302);
    assert.equal(welcomeRes.headers.get('location'), '/?c=test-b');

    // ② /?c=test-b（welcome 的下一跳）：多连接器下 '/' 不在兜底白名单，
    //    旧实现要么 503、要么经「cookie 救援」投给第一个连接器 A。
    const homeResPromise = fetch(`http://127.0.0.1:${resolvedPort}/?c=test-b`, { headers: { cookie } });
    homeResPromise.catch(() => {});
    const homeHead = await b.waitFor((f) => f.kind === 'http-head' && typeof f.path === 'string' && f.path.startsWith('/?'), 'home http-head @B');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(a.frames.filter((f) => f.kind === 'http-head' && f.streamId === homeHead.streamId).length, 0,
      '首页请求不得投给连接器 A');

    connectorB.send(JSON.stringify({ kind: 'http-res-head', deviceId: homeHead.deviceId, streamId: homeHead.streamId, status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    connectorB.send(JSON.stringify({ kind: 'http-res-body', deviceId: homeHead.deviceId, streamId: homeHead.streamId, chunk: Buffer.from('<html></html>').toString('base64url'), final: true }));
    const homeRes = await homeResPromise;
    assert.equal(homeRes.status, 200);
  } finally {
    connectorA?.close();
    connectorB?.close();
    relay?.kill();
  }
}, { timeout: 20000 });

test('中继：不回 pong 的僵尸连接器被 keepalive 剔除，健康连接器不受影响', async (t) => {
  let relay;
  let alive;
  let corpse;
  try {
    relay = await startRelay({ RELAY_CONNECTOR_PING_MS: '1000' });
    t.after(() => {
      try { corpse?.destroy(); } catch { /* 已断 */ }
      alive?.close();
      relay?.kill();
    });

    corpse = await openCorpseConnector(resolvedPort); // 先连（占住「第一个」位置）
    alive = await connectConnector('test-alive');     // 协议栈自动回 pong 的健康连接器

    const initial = await (await fetch(`http://127.0.0.1:${resolvedPort}/healthz`)).json();
    assert.equal(initial.connectors, 2);

    // 尸体在 ~2 个探测周期内被剔除；健康连接器保留。
    const deadline = Date.now() + 8000;
    let health = initial;
    while (Date.now() < deadline) {
      health = await (await fetch(`http://127.0.0.1:${resolvedPort}/healthz`)).json();
      if (health.connectors === 1) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(health.connectors, 1, '僵尸连接器应被 keepalive 剔除');
    assert.equal(alive.readyState, 1, '健康连接器必须仍然在线');

    // 剔除后剩余连接器仍可正常路由。
    const frames = [];
    alive.onmessage = (event) => frames.push(JSON.parse(event.data));
    const replyPromise = fetch(`http://127.0.0.1:${resolvedPort}/kite/pair?token=tok&c=test-alive`);
    replyPromise.catch(() => {});
    const head = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('post-prune http-head timeout')), 5000);
      const check = () => {
        const at = frames.findIndex((f) => f.kind === 'http-head');
        if (at >= 0) { clearTimeout(timer); resolve(frames.splice(at, 1)[0]); return true; }
        return false;
      };
      const poll = setInterval(() => check(), 10);
      setTimeout(() => clearInterval(poll), 5200);
      check();
    });
    alive.send(JSON.stringify({ kind: 'http-res-head', deviceId: head.deviceId, streamId: head.streamId, status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }));
    alive.send(JSON.stringify({ kind: 'http-res-body', deviceId: head.deviceId, streamId: head.streamId, chunk: Buffer.from('{"ok":true}').toString('base64url'), final: true }));
    const reply = await replyPromise;
    assert.equal(reply.status, 200);
  } finally {
    try { corpse?.destroy(); } catch { /* 已断 */ }
    alive?.close();
    relay?.kill();
  }
}, { timeout: 20000 });
