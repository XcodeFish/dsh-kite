/**
 * 中继安全加固回归（2026-10-02 审查）。
 *
 * 覆盖审查里中继侧的五个「外部可观测」判据（真子进程 + 真 socket，不碰内部结构）：
 *   ① fail-closed：无 RELAY_TOKENS 且未显式 ALLOW_OPEN=1 → 非 0 退出 + 可读指引
 *   ② 显式开放模式（ALLOW_OPEN=1）仍能启动，且启动日志带刺眼警告
 *   ③ 日志脱敏：请求日志只落 pathname，查询串里的一次性配对令牌绝不进日志
 *   ④ 真限流：手机 HTTP 宽桶 429（带 retry-after）、配对端点与 /connector 升级走严格桶、
 *      桶之间互不串扰、按 XFF（而非共享的回环 IP）分桶、/healthz 豁免
 *   ⑤ kick 归属校验：非归属连接器的 kick 不生效（有日志），归属连接器照常踢
 *   ⑥ /metrics 收敛：无令牌/错令牌 404，令牌（查询串或 Bearer 头）才返回指标
 *
 * 不依赖 `ws` 客户端包 —— 用 Node 全局 WebSocket + 裸 net.Socket。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELAY_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'relay', 'server.mjs');
const TOKEN = 'ra-hardening-token-0123456789abcdef';
/** 绝不应当出现在日志里的「一次性配对令牌」。 */
const SECRET = 'super-secret-pair-token-do-not-log';
const OPEN = 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 原始子进程包装：累积 stdout/stderr，并给出「退出码」Promise。 */
function spawnRaw(env) {
  const child = spawn(process.execPath, [RELAY_SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  const exit = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exit, out: () => stdout, err: () => stderr, log: () => stdout + stderr };
}

/** 起一个正常（有令牌）中继，返回 { child, port, ...累积输出 }；超时即杀子进程。 */
function startRelay(extraEnv = {}, { tokens = TOKEN } = {}) {
  const env = { ...process.env, PORT: '0', ...extraEnv };
  if (tokens === null) delete env.RELAY_TOKENS;
  else env.RELAY_TOKENS = tokens;
  const run = spawnRaw(env);
  return new Promise((resolve, reject) => {
    // 超时必须杀掉子进程：孤儿 relay 会钉住本测试进程的 stdio 管道，让 runner 永不退出。
    const timer = setTimeout(() => {
      run.child.kill('SIGKILL');
      reject(new Error(`relay start timeout; log=${run.log().slice(-500)}`));
    }, 8000);
    run.child.stdout.on('data', () => {
      const match = /listening on [^ ]+:(\d+)/.exec(run.out());
      if (match) {
        clearTimeout(timer);
        resolve({ ...run, port: Number(match[1]) });
      }
    });
    run.child.on('exit', (code) => reject(new Error(`relay exited early: ${code}; log=${run.log().slice(-500)}`)));
  });
}

/** 极简 HTTP 客户端（要能自定义 XFF，且只关心状态码/头/体）。 */
function httpGet(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', (error) => reject(error));
    req.end();
  });
}

/** 裸 socket 发一次 WS 升级请求，只读响应头（用来观测 101 / 401 / 429）。 */
function rawUpgrade(port, requestPath, protocols = []) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        `GET ${requestPath} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        (protocols.length ? `Sec-WebSocket-Protocol: ${protocols.join(', ')}\r\n` : '') +
        '\r\n');
    });
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('upgrade timeout')); }, 5000);
    let buf = '';
    const ondata = (d) => {
      buf += d.toString('latin1');
      const match = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (!match) return;
      clearTimeout(timer);
      sock.removeListener('data', ondata);
      const headers = {};
      for (const line of buf.split('\r\n').slice(1)) {
        const at = line.indexOf(':');
        if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
      }
      resolve({ status: Number(match[1]), headers, sock, raw: buf });
    };
    sock.on('data', ondata);
    sock.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

/** 连接器：完成 hello-ack 握手；onFrame 可挂额外处理（如回 http-head）。 */
function connectConnector(port, id, onFrame) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/connector?c=${id}`, ['ra.v1', `ra-bearer.${TOKEN}`]);
    const timer = setTimeout(() => reject(new Error('connector handshake timeout')), 5000);
    let settled = false;
    ws.onopen = () => {
      ws.send(JSON.stringify({ kind: 'hello', proto: 1, caps: ['http', 'ws', 'pair', 'auth'] }));
    };
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data));
      if (!settled && frame.kind === 'hello-ack') {
        settled = true;
        clearTimeout(timer);
        resolve(ws);
      }
      onFrame?.(frame, ws);
    };
    ws.onerror = () => {
      if (settled) return;
      clearTimeout(timer);
      reject(new Error('connector ws error'));
    };
  });
}

/** 手机侧 PWA WS 桥。 */
function connectPhone(port, requestPath) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${requestPath}`);
    const timer = setTimeout(() => reject(new Error('phone ws timeout')), 5000);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('phone ws error')); };
  });
}

async function waitUntil(pred, ms = 3000, step = 25) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(step);
  }
  return pred();
}

test('加固①：无 RELAY_TOKENS 且未设 ALLOW_OPEN → 非 0 退出，stderr 给出可读指引', async () => {
  const env = { ...process.env, PORT: '0' };
  delete env.RELAY_TOKENS;
  delete env.ALLOW_OPEN;
  const run = spawnRaw(env);
  const code = await Promise.race([
    run.exit,
    sleep(6000).then(() => { run.child.kill('SIGKILL'); return 'timeout'; })
  ]);
  assert.notEqual(code, 0, 'fail-closed：无令牌必须拒绝启动');
  assert.match(run.err(), /RELAY_TOKENS 为空/, 'stderr 必须说明拒绝启动的原因');
  assert.match(run.err(), /ALLOW_OPEN=1/, 'stderr 必须给出本机联调的显式开关');
  assert.match(run.err(), /生产/, 'stderr 必须说明生产部署该配什么');
});

test('加固②：ALLOW_OPEN=1 显式开放模式可以启动，且启动日志带刺眼警告', async (t) => {
  const relay = await startRelay({ ALLOW_OPEN: '1' }, { tokens: '' });
  t.after(() => relay.child.kill('SIGKILL'));
  const health = await httpGet(relay.port, '/healthz');
  assert.equal(health.status, 200, '开放模式必须能正常服务（本机联调用）');
  assert.match(relay.out(), /OPEN — 仅限本地开发（ALLOW_OPEN=1）/, '启动日志必须显式标注开放模式');
  assert.match(relay.log(), /警告：开放模式/, '开放模式必须有一条刺眼的警告日志');
});

test('加固③：请求日志只落 pathname —— 查询串里的一次性配对令牌绝不进日志', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.child.kill('SIGKILL'));

  // 无连接器：走「未路由」分支（含 req / routed 两条 dbg 日志）。
  const unrouted = await httpGet(relay.port, `/kite/pair?token=${SECRET}&c=nobody`);
  assert.equal(unrouted.status, 503);

  // 有连接器：走「head sent」dbg 日志（第三处曾打印整条 req.url 的位置）。
  const connector = await connectConnector(relay.port, 'h-echo', (frame, ws) => {
    if (frame.kind !== 'http-head') return;
    ws.send(JSON.stringify({
      kind: 'http-res-head', streamId: frame.streamId, status: 200, headers: { 'content-type': 'text/plain' }
    }));
    ws.send(JSON.stringify({
      kind: 'http-res-body', streamId: frame.streamId, chunk: Buffer.from('ok').toString('base64url'), final: true
    }));
  });
  t.after(() => connector.close());
  const routed = await httpGet(relay.port, `/kite/pair?token=${SECRET}&c=h-echo`);
  assert.equal(routed.status, 200, '可控连接器应答后请求应正常返回');

  const log = relay.log();
  assert.ok(log.includes('/kite/pair'), 'pathname 必须保留（否则失去路由诊断能力）');
  assert.ok(!log.includes(SECRET), `日志不得出现查询串里的令牌：${SECRET}`);
  assert.ok(!log.includes(`?token=${SECRET}`), '日志不得出现完整请求目标');
  assert.ok(!/\[dbg\][^\n]*\?token=/.test(log), '任何 [dbg] 行都不得带查询串');
});

test('加固④：真限流 —— 宽桶 429（手机 HTTP）、严格桶（配对端点 / /connector 升级）且互不串桶', async (t) => {
  const relay = await startRelay({
    RELAY_RATE_PHONE_PER_MIN: '5',
    RELAY_RATE_PAIR_PER_MIN: '3',
    RELAY_RATE_CONNECTOR_PER_MIN: '2'
  });
  t.after(() => relay.child.kill('SIGKILL'));
  const port = relay.port;

  // (a) 配对端点：严格桶，第 4 次超限。
  for (let i = 1; i <= 3; i += 1) {
    const res = await httpGet(port, '/kite/pair?c=nobody');
    assert.notEqual(res.status, 429, `配对端点第 ${i} 次（阈值内）不应被限流`);
  }
  const pairLimited = await httpGet(port, '/kite/pair?c=nobody');
  assert.equal(pairLimited.status, 429, '配对端点必须走严格桶');
  assert.ok(Number(pairLimited.headers['retry-after']) >= 1, '429 必须带 retry-after');

  // (b) 手机宽桶独立于配对桶：配对桶已打满，普通路径仍放行 5 次。
  for (let i = 1; i <= 5; i += 1) {
    const res = await httpGet(port, '/some-asset.js');
    assert.notEqual(res.status, 429, `手机宽桶第 ${i} 次（阈值内）不应被限流`);
  }
  const phoneLimited = await httpGet(port, '/some-asset.js');
  assert.equal(phoneLimited.status, 429, '手机 HTTP 超阈值必须 429');
  assert.ok(Number(phoneLimited.headers['retry-after']) >= 1);

  // (c) /healthz 豁免：攻击期间它必须仍是可信的判活探针。
  assert.equal((await httpGet(port, '/healthz')).status, 200, '/healthz 必须豁免限流');

  // (d) 桶 key 走 XFF（Caddy 回环反代下所有手机共享 127.0.0.1）：换一个 XFF 即换一个桶。
  const otherIp = await httpGet(port, '/some-asset.js', { 'x-forwarded-for': '203.0.113.7' });
  assert.notEqual(otherIp.status, 429, '不同 XFF 必须分属不同桶，否则经 Caddy 的手机全部共用一个桶');
  const otherIpAgain = await httpGet(port, '/some-asset.js', { 'x-forwarded-for': '203.0.113.7' });
  assert.notEqual(otherIpAgain.status, 429, '同一 XFF 的第二次请求仍在阈值内');

  // (e) /connector 升级：严格桶，第 3 次超限（前两次 101）。
  const upgrades = [];
  t.after(() => { for (const s of upgrades) s.destroy(); });
  for (let i = 1; i <= 2; i += 1) {
    const res = await rawUpgrade(port, `/connector?c=rate-${i}`, ['ra.v1', `ra-bearer.${TOKEN}`]);
    upgrades.push(res.sock);
    assert.equal(res.status, 101, `第 ${i} 次连接器升级应在阈值内成功`);
  }
  const upgradeLimited = await rawUpgrade(port, '/connector?c=rate-3', ['ra.v1', `ra-bearer.${TOKEN}`]);
  assert.equal(upgradeLimited.status, 429, '/connector 升级必须走严格桶');
  assert.match(upgradeLimited.raw, /429 Too Many Requests/);

  // (f) 限流要可观测。
  const health = JSON.parse((await httpGet(port, '/healthz')).body);
  assert.ok(health.rateLimitedByBucket.pair >= 1, '配对桶的限流次数必须进 /healthz');
  assert.ok(health.rateLimitedByBucket.phone >= 1, 'phone 桶的限流次数必须进 /healthz');
  assert.ok(health.rateLimitedByBucket.connector >= 1, 'connector 桶的限流次数必须进 /healthz');
});

test('加固⑤：kick 归属校验 —— 非归属连接器踢不动（有日志），归属连接器照常踢', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.child.kill('SIGKILL'));
  const port = relay.port;
  const deviceId = 'dev-hardening-' + crypto.randomBytes(4).toString('hex');

  const owner = await connectConnector(port, 'owner-a');
  const rogue = await connectConnector(port, 'rogue-b');
  t.after(() => { owner.close(); rogue.close(); });

  owner.send(JSON.stringify({ kind: 'devices', deviceIds: [deviceId] }));
  assert.ok(await waitUntil(() => /设备路由表更新/.test(relay.log())), '连接器上报设备必须落日志');
  assert.equal(JSON.parse((await httpGet(port, '/healthz')).body).devices, 1);

  const phone = await connectPhone(port, `/api/remote.mux?d=${deviceId}&c=owner-a`);
  t.after(() => phone.close());
  assert.equal(phone.readyState, OPEN, '手机侧桥必须建立成功（归属连接器自己的设备）');

  // 非归属方 kick：必须不生效。
  const closedByRogue = new Promise((resolve) => { phone.onclose = (e) => resolve(e.code); });
  rogue.send(JSON.stringify({ kind: 'kick', deviceId }));
  const rogueResult = await Promise.race([closedByRogue, sleep(400).then(() => 'still-open')]);
  assert.equal(rogueResult, 'still-open', '非归属连接器不得踢掉别人的设备');
  assert.equal(phone.readyState, OPEN, '手机 socket 必须仍然打开');
  assert.match(relay.log(), /kick_owner_mismatch/, '拒绝必须记日志（不静默）');
  assert.equal(JSON.parse((await httpGet(port, '/healthz')).body).devices, 1, '设备条目不得被非归属方删除');

  // 归属方 kick：照常生效（4403 device revoked）。
  const closedByOwner = new Promise((resolve) => { phone.onclose = (e) => resolve(e.code); });
  owner.send(JSON.stringify({ kind: 'kick', deviceId }));
  const code = await Promise.race([closedByOwner, sleep(3000).then(() => 'timeout')]);
  assert.equal(code, 4403, '归属连接器的 kick 必须关闭手机 socket（4403）');

  // 已撤销设备的重复 kick：幂等无害（归属记录已清，走「无归属」分支）。
  owner.send(JSON.stringify({ kind: 'kick', deviceId }));
  await sleep(200);
  const health = JSON.parse((await httpGet(port, '/healthz')).body);
  assert.equal(health.devices, 0, '重复 kick 不得复活/保留设备条目');
});

test('加固⑥：/metrics 需要有效令牌（无令牌/错令牌 404），/healthz 保持公开且无敏感值', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.child.kill('SIGKILL'));
  const port = relay.port;

  // ★ 不能靠「回环」判据：Caddy 反代下公网请求的对端也是 127.0.0.1。
  const anon = await httpGet(port, '/metrics');
  assert.equal(anon.status, 404, '无令牌不得返回 Prometheus 指标');
  assert.ok(!anon.body.includes('ra_relay_connectors'), '未授权响应不得包含任何指标内容');

  const wrong = await httpGet(port, '/metrics?token=wrong-token');
  assert.equal(wrong.status, 404, '错误令牌同样 404');

  const viaQuery = await httpGet(port, `/metrics?token=${TOKEN}`);
  assert.equal(viaQuery.status, 404, 'query token 不应放行，避免令牌进入访问日志');

  const viaHeader = await httpGet(port, '/metrics', { authorization: `Bearer ${TOKEN}` });
  assert.equal(viaHeader.status, 200, 'Authorization: Bearer <有效令牌> 应放行');
  assert.match(viaHeader.body, /^ra_relay_connectors /m, '放行时必须返回完整 Prometheus 文本');

  const health = await httpGet(port, '/healthz');
  assert.equal(health.status, 200, '/healthz 必须保持公开（判活探针）');
  assert.ok(!health.body.includes(TOKEN), '/healthz 不得回显任何令牌');
  assert.ok(JSON.parse(health.body).metricsDenied >= 2, '未授权访问必须被计数（可观测）');
});
