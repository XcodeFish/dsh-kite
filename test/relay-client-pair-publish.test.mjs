/**
 * 回归：**配对完成后连接器必须上报设备表**（真机事故 2026-10-02）。
 *
 * 事故链：手机配对 → 拿到 ra-device cookie → 浏览器取 `./assets/*.js`（相对路径
 * **不带 c**，只能靠 cookie 路由）→ 该 deviceId 不在中继路由表 → 全部 401 →
 * 应用起不来 → 白屏 /「Failed to load plugins / HTML did not preload」。
 *
 * 为什么会漏：补丁原先只加在 `#handlePairDone`（**信令通道** `pair-done` 帧），
 * 而配对页走的是 **HTTP 保留路径**（panel.js：`POST /kite/pair/complete`）——
 * 两条完全独立的入口，补丁形同虚设。等连接器下次重连才自愈。
 *
 * 为什么既有 e2e 没抓到：test/full-chain.e2e.mjs 自己写了
 * `setTimeout(publishDevices, 50)` 替身，手工补上了生产代码该做的事（集成测试假阴）。
 *
 * 本测试用**真实中继进程**（与 relay.integration.test.mjs 同一手法，不依赖 ws 包），
 * 驱动真实的 RelayConnector 走真实的 HTTP 配对保留路径，断言它**自发**发出 devices 帧。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELAY_SCRIPT = path.join(ROOT, 'relay', 'server.mjs');
const TOKEN = 'pair-publish-test-token-0123456789';

const { RelayConnector } = await import('../transport/relay-client.js');

/** 起一个真实中继进程（listen(0) → 内核分配端口，从 stdout 解析）。 */
function startRelay() {
  const child = spawn(process.execPath, [RELAY_SCRIPT], {
    env: { ...process.env, PORT: '0', RELAY_TOKENS: TOKEN },
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

test('连接器：走 HTTP 配对路径完成配对后，必须自发上报设备表', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.child.kill('SIGKILL'));

  const state = { devicesPublished: 0, frames: [] };
  const deviceList = [{ deviceId: 'dev-after-pair' }];

  const connector = new RelayConnector({
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    relayToken: TOKEN,
    connectorId: 'test-connector',
    devices: {
      list: () => deviceList, isActive: () => true, get: () => ({ pubKey: 'x' }),
      touch: () => {}, revoke: async () => true
    },
    tickets: { verify: () => 'dev-after-pair', issue: () => 'ticket', verifyChallenge: () => ({ ok: true }) },
    pairing: {
      complete: () => ({ deviceId: 'dev-after-pair', ticket: 't', code: '123456', setCookie: 'ra-device=t' })
    },
    policy: { decide: () => ({ allow: true, action: 'allow' }) },
    credential: null,
    keys: { fingerprint: 'test-connector' },
    audit: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    isKilled: () => false,
    handlePairPage: async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}') })
  });

  // 挂钩 send()：统计 devices 帧（不依赖中继内部状态，直接看连接器**发出**什么）
  const origSend = connector.send.bind(connector);
  connector.send = (frame) => {
    if (frame?.kind === 'devices') state.devicesPublished += 1;
    state.frames.push(frame?.kind);
    return origSend(frame);
  };

  t.after(() => { try { connector.dispose(); } catch { /* 已释放 */ } });

  connector.start();

  // 等首次上报（连接建立时会 publishDevices，这是既有行为）
  const deadline = Date.now() + 6000;
  while (state.devicesPublished === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(state.devicesPublished >= 1, '连接建立后应至少上报一次设备表');

  const before = state.devicesPublished;

  // ★ 驱动**真实的 HTTP 配对保留路径**（等价于 panel.js 的 POST /kite/pair/complete）。
  //   刻意不走 pair-done 信令帧 —— 那正是原补丁打错的地方。
  const res = await fetch(`http://127.0.0.1:${relay.port}/kite/pair/complete?c=test-connector`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: 'c', sig: 's', ts: Date.now() })
  });
  assert.equal(res.status, 200, '配对保留路径应回 200');

  // 断言：配对完成后连接器**自发**又上报了一次
  const wait2 = Date.now() + 3000;
  while (state.devicesPublished <= before && Date.now() < wait2) {
    await new Promise((r) => setTimeout(r, 25));
  }

  assert.ok(state.devicesPublished > before,
    '配对完成后连接器必须自发上报设备表（否则新设备不在中继路由表，'
    + '浏览器取 assets 全 401 → 白屏 / Failed to load plugins）。'
    + `实测 devices 帧数：配对前 ${before} → 配对后 ${state.devicesPublished}`);
}, { timeout: 30000 });
