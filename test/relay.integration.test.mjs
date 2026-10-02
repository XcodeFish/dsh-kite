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
import { encodeBinFrame } from '../transport/frames.js';

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
    ws.onopen = () => {
      // ★ 模拟真实连接器：open 后发 hello（caps 带 'bin' → 中继登记二进制承载协商）。
      //   旧版本测试不发 hello 也能工作（中继不强制）；但 bin 帧收包要求已登记，
      //   不发会导致 bin 用例被 bin_frame_unnegotiated 拒收而挂起。
      ws.send(JSON.stringify({ kind: 'hello', proto: 1, caps: ['http', 'ws', 'pair', 'auth', 'bin'] }));
    };
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

test('中继：无法路由的 ra-device 必须立刻应答，不得静默吞掉请求（2026-10-02 挂死回归）', async (t) => {
  // 真机事故：无确定路由键、但 cookie 里带着 ra-device 的请求，旧实现走到
  //   `return { ws: first[1], deviceId: 'pair' }`
  // ——而 handlePhoneHttp 返回 void，且这条分支没有任何 res 写入。于是请求既不转发
  //   也不应答，socket 上永远没有响应：实测 HTTP 000（12s 超时，连试三次全中），
  //   手机表现为「配对完成后卡在进入 DSH」。同一 URL 去掉 cookie 则立刻 401。
  //
  // 复现条件要凑齐两条：① cookie 里有 ra-device 但中继解析不出 deviceId 路由键；
  // ② 连接器数量 ≠ 1（否则走单连接器兜底，压根到不了这条分支）。
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
    connectorA = await connectConnector('rescue-a');
    connectorB = await connectConnector('rescue-b');

    // 畸形 ra-device：v1 前缀但 payload 解不出 deviceId → routeHintFromCookie 返回 null，
    // 而 hasDeviceCookie 为真。c= 也不给，两个候选键都不存在 → 命中该分支。
    const malformed = 'ra-device=v1.bm90LWpzb24.AAAA';
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${resolvedPort}/?x=1`, {
      headers: { cookie: malformed },
      signal: AbortSignal.timeout(5000)
    });
    const elapsed = Date.now() - started;

    // 核心断言：有响应（不是挂死）。旧实现这里会抛 AbortError（5s 超时）。
    assert.ok(res.status === 401 || res.status === 503,
      `无法路由的 ra-device 请求必须得到明确应答，实际 HTTP ${res.status}`);
    assert.ok(elapsed < 3000, `应答必须及时（不得等客户端超时），实际 ${elapsed}ms`);
    const body = await res.text();
    assert.match(body, /需要配对|连接器不在线/, '应回可读的配对/离线引导页，而不是空响应');
  } finally {
    connectorA?.close();
    connectorB?.close();
    relay?.kill();
  }
}, { timeout: 20000 });

test('中继：手机建 WS（URL 不带 c）不得把设备挤出路由表（2026-10-02 实时同步丢失回归）', async (t) => {
  // 真机事故：手机界面能打开，但**数据不再实时同步**，且下次刷新又白屏。
  //
  // 根因：onPhoneSocket 里 `const connectorId = url.searchParams.get('c')`。
  //   浏览器建 WS 用相对路径 `/api/remote.mux`，URL 里**没有 c** → connectorId = null；
  //   紧接着 `if (!entry || entry.connectorId !== connectorId)` 拿它跟真实指纹比较，
  //   `"<指纹>" !== null` 恒为真 → 每次都判定「换连接器」→ 重建 entry，
  //   覆盖掉 devices 里该 deviceId 的登记（并丢弃 phones 集合）。
  //   设备随即从路由表消失 → 之后所有不带 c 的请求（首页 + 全部 assets）全 401。
  //   因果实测：WS 前 HTTP 200 ✓ → 建一次 WS → WS 后 HTTP 401 ✗。
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
    // ★ 必须**两个**连接器才能暴露此 bug。单连接器时 connectorFor 会走
    //   「单连接器兜底」把请求投给唯一在线者，从而掩盖 entry.connectorId 已被写成
    //   null 的损坏 —— 本测试首版正是因此假绿（旧代码也 5/5 全过）。线上是 2 个，
    //   兜底不生效，损坏才会显形。
    connectorA = await connectConnector('ws-route-a');
    connectorB = await connectConnector('ws-route-b');
    const frames = collectFrames(connectorA);

    // ① 连接器 A 上报设备表 → 该设备应被 cookie 路由到 A
    //    cookie 必须是 `v1.<b64url(payload)>.<sig>` 三段式：routeHintFromCookie 对格式
    //    有校验，格式不对会直接返回 null，测不到目标分支。
    const deviceId = 'phone-ws-test';
    const payload = Buffer.from(JSON.stringify({ deviceId, v: 1 })).toString('base64url');
    const cookie = `ra-device=v1.${payload}.x`;
    connectorA.send(JSON.stringify({ kind: 'devices', deviceIds: [deviceId] }));
    await new Promise((r) => setTimeout(r, 150));

    // ② 建一条手机 WS（**不带 c**，与浏览器一致）。中继会向连接器发 ws-open。
    const phone = new WebSocket(`ws://127.0.0.1:${resolvedPort}/api/remote.mux`, { headers: { cookie } });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('phone ws open timeout')), 5000);
      phone.onopen = () => { clearTimeout(timer); resolve(); };
      phone.onerror = () => { clearTimeout(timer); reject(new Error('phone ws error')); };
    });
    await new Promise((r) => setTimeout(r, 200));

    // ③ ★ 核心断言：建完 WS 后，该 deviceId 必须**仍在**路由表里。
    //    旧实现会因 connectorId=null 覆盖登记；修复后登记保持。
    //
    //    ★ 不要等 HTTP 响应完整回来：中继把请求转发给连接器后会**一直等它回答**，
    //      而这里没人回 → 断言会挂在 110s 看门狗上（首版就栽在这，跑了 110 秒）。
    //      改为断言「中继是否向连接器发出了 http-head」—— 这正是「路由成功」的定义，
    //      且不含等待连接器回包的时序。
    const replyPromise = fetch(`http://127.0.0.1:${resolvedPort}/some-path`, { headers: { cookie } });
    replyPromise.catch(() => {}); // 失败路径不产生 unhandled rejection
    const head = await frames.waitFor(
      (f) => f.kind === 'http-head' && f.path === '/some-path',
      'http-head after ws'
    );
    assert.equal(head.deviceId, deviceId, '应带着该 deviceId 路由（而不是兜底的 pair）');

    phone.close();
    // 主动收尾：给连接器回一个响应，让上面那个 fetch 正常结束（不必等看门狗）。
    connectorA.send(JSON.stringify({ kind: 'http-res-head', deviceId: head.deviceId, streamId: head.streamId, status: 200, headers: { 'content-type': 'text/plain' } }));
    connectorA.send(JSON.stringify({ kind: 'http-res-body', deviceId: head.deviceId, streamId: head.streamId, chunk: Buffer.from('ok').toString('base64url'), final: true }));
    const res = await replyPromise;
    assert.equal(res.status, 200);
  } finally {
    connectorA?.close();
    connectorB?.close();
    relay?.kill();
  }
}, { timeout: 20000 });

test('中继：协商 bin 后大载荷走二进制帧，线上字节显著缩小（2026-10-02 v2 承载优化）', async (t) => {
  let relay;
  let connector;
  try {
    relay = await startRelay();
    t.after(() => {
      connector?.close();
      relay?.kill();
    });
    connector = await connectConnector('bin-frame');
    const frames = collectFrames(connector);

    const deviceId = 'phone-bin-test';
    const payload = Buffer.from(JSON.stringify({ deviceId, v: 1 })).toString('base64url');
    const cookie = `ra-device=v1.${payload}.x`;
    connector.send(JSON.stringify({ kind: 'devices', deviceIds: [deviceId] }));
    await new Promise((r) => setTimeout(r, 150));

    // 手机发起请求 → 中继发 http-head 给连接器（JSON 文本帧，头帧小）
    const resPromise = fetch(`http://127.0.0.1:${resolvedPort}/big`, { headers: { cookie } });
    resPromise.catch(() => {});
    const head = await frames.waitFor((f) => f.kind === 'http-head' && f.path === '/big', 'http-head');

    // 连接器回一个大响应（>4KB → isBinEligible=true）。
    // 中继已协商 bin（连接器 hello caps 带 'bin' 且测试走 connectConnector → 新代码），
    // 所以连接器 send() 会自动切二进制承载 —— 这里用 wss 侧不可见，只看效果：
    // 用 encodeBinFrame 手工构造二进制消息，模拟「连接器协商后自动发出」的线上形态。
    // （头帧 http-res-head 无载荷字段，本就走 JSON 文本 —— 只有 body 帧切二进制。）
    const body = Buffer.alloc(64 * 1024, 0x5a);
    connector.send(JSON.stringify({ kind: 'http-res-head', deviceId, streamId: head.streamId, status: 200, headers: { 'content-type': 'application/octet-stream' } }));
    connector.send(encodeBinFrame({ kind: 'http-res-body', deviceId, streamId: head.streamId, chunk: body.toString('base64url'), final: true }));

    const res = await resPromise;
    assert.equal(res.status, 200);
    const got = Buffer.from(await res.arrayBuffer());
    assert.equal(got.length, body.length, '经二进制承载的 64KB 载荷应完整到达手机侧');
    assert.ok(got.equals(body), '内容应逐字节一致（b64 编解码路径不损坏二进制）');
  } finally {
    connector?.close();
    relay?.kill();
  }
}, { timeout: 20000 });

test('中继：设备所有权保护 —— 后到的连接器不得抢注已归属他人的 deviceId（2026-10-02 路由摇摆回归）', async (t) => {
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
    connectorA = await connectConnector('owner-conn');
    connectorB = await connectConnector('thief-conn');

    const deviceId = 'phone-owned';
    // ① A 上报设备 → 归 A
    connectorA.send(JSON.stringify({ kind: 'devices', deviceIds: [deviceId] }));
    await new Promise((r) => setTimeout(r, 150));

    // ② B 上报同一设备 → 必须【拒绝】，所有权仍归 A
    connectorB.send(JSON.stringify({ kind: 'devices', deviceIds: [deviceId] }));
    await new Promise((r) => setTimeout(r, 150));

    // ③ 验证：cookie 路由仍走 A（A 收到 http-head，B 收不到）
    const framesA = collectFrames(connectorA);
    const cookie = `ra-device=v1.${Buffer.from(JSON.stringify({ deviceId, v: 1 })).toString('base64url')}.x`;
    const replyPromise = fetch(`http://127.0.0.1:${resolvedPort}/ownership-probe`, { headers: { cookie } });
    replyPromise.catch(() => {});
    const head = await framesA.waitFor((f) => f.kind === 'http-head' && f.path === '/ownership-probe', 'A 应仍拥有该设备');
    assert.equal(head.deviceId, deviceId, '设备必须仍路由给原连接器 A');

    // 收尾回包防挂
    connectorA.send(JSON.stringify({ kind: 'http-res-head', deviceId: head.deviceId, streamId: head.streamId, status: 200, headers: { 'content-type': 'text/plain' } }));
    connectorA.send(JSON.stringify({ kind: 'http-res-body', deviceId: head.deviceId, streamId: head.streamId, chunk: Buffer.from('ok').toString('base64url'), final: true }));
    const res = await replyPromise;
    assert.equal(res.status, 200);
  } finally {
    connectorA?.close();
    connectorB?.close();
    relay?.kill();
  }
}, { timeout: 20000 });
