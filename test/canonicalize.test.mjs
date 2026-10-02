/**
 * P0 回归护栏（安全加固方案 §10）：按**不变式**写，不按字符串枚举。
 *
 * 为什么原有 146 项没抓到：断言全部使用规范写法（只测 `/kite/api/status`、只测
 * `http://evil/x`），「同一语义的另一种写法」这一维度完全缺失 —— 而全部 Critical
 * 绕过都发生在两种写法之间。
 *
 * 本文件锁四件事：
 *   ① 判定收到的 path === 实际发出的 pathname+search（同源不变式，逐字节）
 *   ② 恶意写法矩阵端到端 400/deny；良性写法矩阵零回归
 *   ③ WS 走同一道门（ws-open 带恶意路径 → ws-close 4400/4403，且不触达宿主）
 *   ④ 管理面来源隔离（经代理到达 = 403）+ kill switch 逐请求复检
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalizeTarget, createPolicy, safeProxyPath } from '../policy/methods.js';
import { forwardRequest, rebuildRequestHeaders, VIA_HEADER } from '../proxy/reverse-proxy.js';
import { createAdminHandler, KillSwitch } from '../admin/panel.js';
import { loadConnectorKeys } from '../identity/keys.js';
import { encodeClientFrame, ServerFrameParser, OP_CLOSE } from '../proxy/ws-codec.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELAY_SCRIPT = path.join(ROOT, 'relay', 'server.mjs');
const RELAY_TOKEN = 'canonicalize-test-token-0123456789';

/** 策略：上传/终端/市场全部默认拒绝（生产默认值）。 */
function policy(overrides = {}) {
  return createPolicy({
    remoteAgentPreset: 'default',
    allowedAgentPresets: ['default'],
    allowTerminal: false,
    allowUpload: false,
    ...overrides
  });
}

/** 恶意写法矩阵：同一语义的「另一种写法」+ authority 切换 + 编码变体。 */
const HOSTILE = [
  ['点段折叠 → 管理面', '/./kite/api/status', 'GET'],
  ['点段折叠（斜杠变体）', '/x/../kite/api/status', 'GET'],
  ['百分号编码点段', '/%2e/kite/api/status', 'GET'],
  ['双编码点段', '/%252e/kite/api/status', 'GET'],
  ['点段折叠 → 管理面（配对页）', '/a/../kite/pair?token=x', 'GET'],
  ['authority 切换', '//evil.example/x', 'GET'],
  ['authority 切换（三斜杠）', '///evil.example/x', 'GET'],
  ['authority 切换（编码斜杠）', '/%2f%2fevil.example/x', 'GET'],
  ['authority 切换（反斜杠）', '/\\evil.example/x', 'GET'],
  ['absolute-form', 'http://evil.example/x', 'GET'],
  ['编码斜杠', '/kite%2Fapi%2Fstatus', 'GET'],
  ['上传策略绕过', '/y/../api/session/uploadFileBinary', 'POST'],
  ['HMR 拒绝绕过', '/z/../plugins/events', 'GET'],
  ['市场拒绝绕过', '/q/../api/community-market/list', 'GET'],
  ['终端写绕过', '/api/terminal/list/../write', 'GET'],
  ['会话预设锁定绕过', '/x/../api/session/create', 'POST'],
  ['控制字符', '/kite/api/status\u0000', 'GET'],
  ['空格', '/kite /api/status', 'GET'],
  ['超长', `/${'a'.repeat(9000)}`, 'GET'],
  ['空目标', '', 'GET']
];

/** 良性矩阵：真机首屏真实用到的写法（`??` 合并模块、query 里的 %2E/%2F、长路径）。
 *  注意 `/kite` 本身**不在此列** —— 它是保留前缀，策略层必须 deny（见恶意矩阵）。 */
const BENIGN = [
  '/',
  '/api/remote.mux',
  '/api/terminal/follow',
  '/terminal/follow',
  '/api/session/list',
  '/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=abc',
  '/plugins/??a/client.js,b/client.js&rev=x',
  '/plugins/@deepseek-ai/dsh-client-modules/client.js',
  '/api/attachment?id=%2E%2F%2Fetc',
  '/api/attachment?p=%2Ftmp%2Fa.png',
  '/assets/index-abc123.js?v=1',
  '/a%20b/c',
  '/%E4%B8%AD%E6%96%87',
  `/plugins/??${Array.from({ length: 200 }, (_, i) => `@scope/pkg-long-name-${i}/client.js`).join(',')}&rev=x`
];

test('① 恶意写法矩阵：端到端必须 400 或 deny（不得只看字符串）', () => {
  const p = policy();
  const createBody = Buffer.from(JSON.stringify({ agentPreset: 'yolo-full-access' }));
  const escaped = [];
  for (const [label, raw, method] of HOSTILE) {
    const target = canonicalizeTarget(raw);
    if (!target) continue; // 400：在解析阶段就拒了
    const verdict = p.decide({ method, path: target.key, body: createBody });
    if (verdict.action === 'allow') escaped.push(`${label}（${raw}）→ 放行到 ${target.key}`);
  }
  assert.deepEqual(escaped, [], `以下恶意写法逃过了策略/规范化：\n${escaped.join('\n')}`);
});

test('①b 恶意写法矩阵：规范化结果不得再含点段/编码点段/authority', () => {
  for (const [label, raw] of HOSTILE) {
    const target = canonicalizeTarget(raw);
    if (!target) continue;
    assert.ok(!target.key.startsWith('//'), `${label}: key 不得是 protocol-relative`);
    assert.doesNotMatch(target.key.split('?')[0], /\/\.\.?(\/|$)/, `${label}: key 不得残留点段`);
    assert.doesNotMatch(target.key.split('?')[0], /%(2e|2f|5c|25)/i, `${label}: key 不得残留结构编码`);
    assert.ok(safeProxyPath(raw), `${label}: 能规范化即应可代理（safeProxyPath 语义不变）`);
  }
});

test('② 良性写法矩阵：零回归（全部可规范化且策略放行）', () => {
  const p = policy();
  for (const raw of BENIGN) {
    const target = canonicalizeTarget(raw);
    assert.ok(target, `良性写法被误杀：${raw}`);
    const verdict = p.decide({ method: 'GET', path: target.key });
    assert.equal(verdict.action, 'allow', `良性写法被策略拒绝：${raw} → ${JSON.stringify(verdict)}`);
  }
});

// ---- 出站一致性：判定收到什么，线路上就必须是什么 ----

function startLoopback(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function withProxyHarness(hostHandler) {
  const seen = [];
  const host = await startLoopback((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    hostHandler?.(req, res);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const deps = {
    policy: policy(),
    credential: { acquire: async () => ({ base: `http://127.0.0.1:${host.port}`, cookie: 'dsh-auth-loop=v1' }), invalidate() {} },
    audit: () => {},
    logger: { warn: () => {} },
    viaValue: 'via-value-test'
  };
  return {
    deps,
    seen,
    // ★ closeAllConnections：fetch 的 keep-alive 连接不会因 close() 自动断开，
    //   残留 socket 会让测试进程永不退出（表现为 npm test 挂起）。
    close: () => {
      try { host.server.closeAllConnections?.(); } catch { /* 老版本无此 API */ }
      return host.server.close();
    }
  };
}

test('③ 同源不变式：判定收到的 path === 实际发出的 pathname+search', async () => {
  const harness = await withProxyHarness();
  try {
    for (const raw of BENIGN) {
      const target = canonicalizeTarget(raw);
      // 判定收到的就是 target.key；把同一个 key 交给转发，线路上必须逐字节一致。
      harness.deps.policy.decide({ method: 'GET', path: target.key });
      const before = harness.seen.length;
      const res = await forwardRequest(harness.deps, {
        deviceId: 'dev-1', method: 'GET', path: raw, headers: {}, body: undefined, isDeviceValid: true
      });
      assert.equal(res.status, 200, `转发应成功：${raw}`);
      assert.equal(harness.seen.length, before + 1, `宿主应收到一次请求：${raw}`);
      assert.equal(harness.seen.at(-1).url, target.key, `线路上必须与判定同源：${raw}`);
    }
  } finally {
    harness.close();
  }
});

test('④ authority 切换：`//host` 系写法一律 400，且不产生任何出站请求', async () => {
  const harness = await withProxyHarness();
  try {
    for (const raw of ['//evil.example/x', '///evil.example/x', '/%2f%2fevil.example/x', 'http://evil.example/x']) {
      const res = await forwardRequest(harness.deps, {
        deviceId: 'dev-1', method: 'GET', path: raw, headers: {}, body: undefined, isDeviceValid: true
      });
      assert.equal(res.status, 400, `${raw} 必须 400`);
    }
    assert.equal(harness.seen.length, 0, '被拒的请求不得触达任何服务（含本机其它端口）');
  } finally {
    harness.close();
  }
});

test('⑤ 来源标记头：连接器无条件写入，手机伪造被丢弃', async () => {
  const harness = await withProxyHarness();
  try {
    await forwardRequest(harness.deps, {
      deviceId: 'dev-1',
      method: 'GET',
      path: '/api/session/list',
      // 手机带来的同名头：必须被白名单丢弃，且被连接器自己的值覆盖
      headers: { [VIA_HEADER]: 'forged-by-phone', cookie: 'ra-device=attacker' },
      body: undefined,
      isDeviceValid: true
    });
    const got = harness.seen.at(-1);
    assert.equal(got.headers[VIA_HEADER], 'via-value-test', '标记头必须是连接器写入的值');
    assert.equal(got.headers.cookie, 'dsh-auth-loop=v1', 'cookie 必须是回环凭据（手机 cookie 不转发）');
  } finally {
    harness.close();
  }
  // 契约层面再锁一次：白名单入口不接受手机同名头
  const headers = rebuildRequestHeaders({ [VIA_HEADER]: 'x', cookie: 'y' }, 'dsh-auth-real=1', 'via-real');
  assert.equal(headers[VIA_HEADER], 'via-real');
});

test('⑥ 管理面来源隔离：带标记头的请求 403（即便宿主会话轨可用）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kite-canon-admin-'));
  const keys = await loadConnectorKeys(dir);
  const audits = [];
  const deps = {
    // 宿主轨：带 dsh-auth-ok cookie 才视为有会话（这样才能验证「错误标记值不构成来源隔离命中」）
    adapter: {
      requestRejection: (req) => (String(req.headers?.cookie ?? '').includes('dsh-auth-ok') ? undefined : 401),
      launchToken: () => 'launch',
      webServerPort: () => 1234
    },
    keys,
    killSwitch: new KillSwitch(dir),
    devices: { list: () => [] },
    pairing: { list: () => [], begin: () => ({ token: 't', expiresAt: 0 }) },
    audit: { tail: () => [], append: (e) => audits.push(e), recent: async () => [] },
    fingerprint: 'fp',
    relayStatus: () => ({ state: 'open', relayUrl: 'wss://x', metrics: {} }),
    kickDevice: () => {},
    relayPublicUrl: () => 'https://t.example',
    probe: async () => ({ overall: 'ok', checks: [] }),
    viaValue: 'via-secret-value'
  };
  const handler = createAdminHandler(deps);
  const call = async (headers) => {
    const res = { status: 0, headers: null, body: '', writeHead(s, h) { this.status = s; this.headers = h ?? {}; }, end(b) { this.body = b?.toString() ?? ''; } };
    await handler({ method: 'GET', url: '/kite/api/status', headers }, res);
    return res;
  };

  const via = await call({ [VIA_HEADER]: 'via-secret-value' });
  assert.equal(via.status, 403, '经代理到达的管理面请求必须 403');
  assert.ok(audits.some((e) => e.kind === 'admin.proxy-denied'), '必须留审计（这是攻击面信号，不是普通 401）');

  // 反例 1：不带标记头 + 宿主轨可用 → 正常放行（本机浏览器入口不受影响）
  const local = await call({ cookie: 'dsh-auth-ok=1' });
  assert.equal(local.status, 200, '本机入口不得被误伤');

  // 反例 2：伪造**错值**的标记头 → 不走来源隔离轨；无宿主会话 → 401（不是 403/200）
  const forged = await call({ [VIA_HEADER]: 'wrong-value' });
  assert.equal(forged.status, 401, '错误标记值不得被当作来源隔离命中');

  // ★ 免认证端点也必须被来源隔离覆盖：/kite/api/entry 是整条管理面上唯一免认证的
  //   入口（避免「要令牌才能拿令牌」死锁），曾经绕过 ⓪ 轨 —— 一旦代理侧策略被绕过，
  //   攻击者可白拿 10 分钟引导令牌。这里锁死它。
  const entryVia = { status: 0, headers: null, body: '', writeHead(s, h) { this.status = s; this.headers = h ?? {}; }, end(b) { this.body = b?.toString() ?? ''; } };
  await handler({ method: 'GET', url: '/kite/api/entry', headers: { [VIA_HEADER]: 'via-secret-value' } }, entryVia);
  assert.equal(entryVia.status, 403, '免认证的 /kite/api/entry 也必须拒绝经代理到达的请求');
  assert.doesNotMatch(entryVia.body, /kite_token/, '被拒时绝不能泄漏引导令牌');

  // 反例：本机（无标记头）访问 /kite/api/entry 仍应正常签发（死锁修复不能回退）
  const entryLocal = { status: 0, headers: null, body: '', writeHead(s, h) { this.status = s; this.headers = h ?? {}; }, end(b) { this.body = b?.toString() ?? ''; } };
  await handler({ method: 'GET', url: '/kite/api/entry', headers: {} }, entryLocal);
  assert.equal(entryLocal.status, 200, '本机取入口令牌必须仍然可用');
  assert.match(entryLocal.body, /kite_token=/, '本机应拿到引导令牌');
});

// ---- WS 同一道门（真实中继 + 真实连接器 + 原始 upgrade 握手）----

function startRelayProcess() {
  const child = spawn(process.execPath, [RELAY_SCRIPT], {
    env: {
      ...process.env,
      PORT: '0',
      RELAY_TOKENS: RELAY_TOKEN,
      // ★ 本文件要连建多条 WS 桥/连接器握手；把桶放宽，避免「测试自己把自己限流」的假阴性。
      //   限流本身的行为由 test/relay-hardening.test.mjs 专门覆盖（那里的阈值是默认值）。
      RELAY_RATE_CONNECTOR_PER_MIN: '600',
      RELAY_RATE_PHONE_PER_MIN: '3000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('relay start timeout')); }, 8000);
    const onData = (buf) => {
      const m = /listening on [^:]+:(\d+)/.exec(buf.toString('utf8'));
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** 手机侧原始 WS 握手（要带 cookie，Node 全局 WebSocket 不支持自定义头）。 */
function phoneUpgrade(port, targetPath, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: targetPath,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
        ...(cookie ? { cookie } : {})
      }
    });
    req.on('upgrade', (res, socket, head) => resolve({ res, socket, head }));
    req.on('response', (res) => { res.resume(); resolve({ res, socket: null, head: null }); });
    req.on('error', reject);
    req.end();
  });
}

/** 等一个 WS close 帧（或超时）。返回 close code（拿不到回 null）。
 *  ★ head 必须一起喂进解析器：中继往往把 101 与 close 帧写在同一个 TCP 段里，
 *    丢掉 head 会得到「什么都没收到」的假象（实测踩过）。 */
function waitCloseCode(socket, head, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const parser = new ServerFrameParser();
    const finish = (code) => { clearTimeout(timer); resolve(code); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const feed = (chunk) => {
      for (const frame of parser.push(chunk)) {
        if (frame.opcode === OP_CLOSE) return finish(frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005);
      }
      return undefined;
    };
    if (head?.length) feed(head);
    socket.on('data', feed);
    socket.on('close', () => finish(null));
    socket.on('error', () => finish(null));
  });
}

/** 彻底清理：关 server（含 keep-alive/升级连接）+ 杀中继子进程。
 *  ★ 必须显式做这两件事：Node 的 server.close() 不会断开已建立的连接，
 *    残留 socket/子进程会让 `npm test`（不带 --test-force-exit）永久挂起。 */
function hardCleanup(t, { relay, host, sockets } = {}) {
  t.after(() => {
    for (const s of sockets ?? []) { try { s.destroy(); } catch { /* 已关 */ } }
    if (host) {
      try { host.closeAllConnections?.(); } catch { /* 老版本 */ }
      try { host.close(); } catch { /* 已关 */ }
    }
    if (relay?.child && relay.child.exitCode === null) { try { relay.child.kill('SIGKILL'); } catch { /* 已退 */ } }
  });
}

async function startConnector({ relayPort, credentialBase, killed = () => false, policyImpl }) {
  const { RelayConnector } = await import('../transport/relay-client.js');
  const connector = new RelayConnector({
    relayUrl: `ws://127.0.0.1:${relayPort}`,
    relayToken: RELAY_TOKEN,
    connectorId: 'canon-connector',
    devices: {
      list: () => [{ deviceId: 'dev-1' }],
      isActive: () => true,
      get: () => ({ pubKey: 'x', name: 'test' }),
      touch: () => {},
      revoke: async () => true
    },
    tickets: { verify: () => 'dev-1', issue: () => 'ticket', verifyChallenge: () => ({ ok: true }) },
    pairing: { complete: () => ({ deviceId: 'dev-1', ticket: 't', code: '123456' }) },
    policy: policyImpl ?? policy(),
    credential: { acquire: async () => ({ base: credentialBase, cookie: 'dsh-auth-loop=v1' }), invalidate() {} },
    keys: { fingerprint: 'canon-connector' },
    audit: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    viaValue: 'via-value-test',
    isKilled: killed,
    handlePairPage: async () => null
  });
  connector.start();
  // 等连接建立（connect 成功后 publishDevices 会发出 devices 帧；简单轮询状态）
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const st = connector.status?.();
    if (st?.state === 'open') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return connector;
}

test('⑦ WS 同门：恶意路径 → ws-close 4400/4403，且不触达宿主', async (t) => {
  const relay = await startRelayProcess();
  const host = await startLoopback((req, res) => { res.writeHead(200); res.end('host'); });
  const sockets = new Set();
  hardCleanup(t, { relay, host: host.server, sockets });
  let hostUpgrades = 0;
  host.server.on('upgrade', (req, socket) => { hostUpgrades += 1; socket.destroy(); });

  const connector = await startConnector({ relayPort: relay.port, credentialBase: `http://127.0.0.1:${host.port}` });
  t.after(() => { try { connector.dispose(); } catch { /* 已释放 */ } });

  const cases = [
    ['//127.0.0.1:9999/api/remote.mux', 4400],
    ['/./kite/api/status', 4403],
    ['/x/../plugins/events', 4403],
    ['/kite/api/status', 4403]
  ];
  for (const [rawPath, expected] of cases) {
    const { res, socket, head } = await phoneUpgrade(relay.port, `${rawPath}?c=canon-connector`, 'ra-device=test-ticket');
    sockets.add(socket);
    assert.equal(res.statusCode, 101, `升级应被中继接受（由连接器裁决）：${rawPath}`);
    const code = await waitCloseCode(socket, head);
    assert.equal(code, expected, `${rawPath} 应被 ws-close ${expected}（实测 ${code}）`);
  }
  assert.equal(hostUpgrades, 0, '被拒的 WS 不得打开任何到宿主的隧道（SSRF 面）');
}, { timeout: 30000 });

test('⑧ WS 同门：良性路径仍能建桥（零回归）', async (t) => {
  const relay = await startRelayProcess();
  let hostUpgrades = 0;
  const host = await startLoopback(() => {});
  const sockets = new Set();
  hardCleanup(t, { relay, host: host.server, sockets });
  host.server.on('upgrade', (req, socket) => {
    hostUpgrades += 1;
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });

  const connector = await startConnector({ relayPort: relay.port, credentialBase: `http://127.0.0.1:${host.port}` });
  t.after(() => { try { connector.dispose(); } catch { /* 已释放 */ } });

  const { res, socket } = await phoneUpgrade(relay.port, '/api/remote.mux?c=canon-connector', 'ra-device=test-ticket');
  sockets.add(socket);
  assert.equal(res.statusCode, 101);
  const deadline = Date.now() + 3000;
  while (hostUpgrades === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert.equal(hostUpgrades, 1, 'PWA 主通道 /api/remote.mux 必须照常建桥');
}, { timeout: 30000 });

test('⑨ kill switch：逐请求复检（HTTP 503 / WS 4403），且不触达宿主', async (t) => {
  const relay = await startRelayProcess();
  let hostHits = 0;
  const host = await startLoopback((req, res) => { hostHits += 1; res.writeHead(200); res.end('host'); });
  const sockets = new Set();
  hardCleanup(t, { relay, host: host.server, sockets });
  host.server.on('upgrade', (req, socket) => { hostHits += 1; socket.destroy(); });

  let killed = false;
  const connector = await startConnector({
    relayPort: relay.port,
    credentialBase: `http://127.0.0.1:${host.port}`,
    killed: () => killed
  });
  t.after(() => { try { connector.dispose(); } catch { /* 已释放 */ } });

  // 先确认未停用时通的
  const warm = await fetch(`http://127.0.0.1:${relay.port}/api/session/list?c=canon-connector`, { headers: { cookie: 'ra-device=test-ticket' } });
  assert.equal(warm.status, 200, '停用前应正常转发');
  assert.equal(hostHits, 1);

  killed = true;
  const blocked = await fetch(`http://127.0.0.1:${relay.port}/api/session/list?c=canon-connector`, { headers: { cookie: 'ra-device=test-ticket' } });
  assert.ok(blocked.status >= 400, `停用后必须立刻拒绝（实测 ${blocked.status}）`);
  assert.equal(hostHits, 1, '停用后不得再触达宿主');

  const { res, socket, head } = await phoneUpgrade(relay.port, '/api/remote.mux?c=canon-connector', 'ra-device=test-ticket');
  sockets.add(socket);
  assert.equal(res.statusCode, 101);
  const code = await waitCloseCode(socket, head);
  assert.equal(code, 4403, '停用后 WS 必须被拒');
  assert.equal(hostHits, 1, '停用后不得打开 WS 隧道');
}, { timeout: 30000 });
