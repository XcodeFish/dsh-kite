/**
 * 中继配置面路由测试（HANDOVER §5.9）：
 *   - 新路由全部在 adminAuth 之后（未认证 401）；
 *   - killed 状态 → 409；
 *   - 结果状态码映射（ok→200 / validate→400 / killed→409）；
 *   - 配置状态响应**不含令牌本体**（只有 relayTokenSet + relayTokenFp）；
 *   - 审计 relay.reconfigure 不含令牌本体。
 * 探针/写盘/重建的全链路行为在 relay-config.e2e.test.mjs（真中继）覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createAdminHandler, KillSwitch, RelayOverrideStore } from '../admin/panel.js';
import { loadConnectorKeys } from '../identity/keys.js';

async function fixture(overrides = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kite-relaycfg-'));
  const keys = await loadConnectorKeys(dir);
  const auditEntries = [];
  const deps = {
    adapter: { requestRejection: () => 401, launchToken: () => 'launch-token-abc', webServerPort: () => 1234 },
    keys,
    killSwitch: new KillSwitch(dir),
    devices: { list: () => [] },
    pairing: { list: () => [], begin: () => ({ token: 't', expiresAt: Date.now() + 1000 }) },
    audit: {
      tail: () => [],
      recent: async () => [],
      append: (entry) => auditEntries.push(entry)
    },
    fingerprint: 'fp',
    relayStatus: () => ({ state: 'standby', relayUrl: null, metrics: {} }),
    kickDevice: () => {},
    relayPublicUrl: () => null,
    relayOwned: true,
    probe: async () => ({ overall: 'ok', checks: [] }),
    relayConfigStatus: () => ({
      effective: { relayUrl: 'wss://current.example', relayPublicUrl: 'https://current.example', relayTokenSet: true, relayTokenFp: 'abcd1234' },
      sources: { relayUrl: 'override', relayToken: 'override', relayPublicUrl: 'override' },
      override: { exists: true, changedAt: 1 },
      killswitch: { enabled: false },
      relayOwned: true,
      relay: { state: 'open', lastError: null }
    }),
    probeRelayConfig: async () => ({ ok: true, code: 'ok', latencyMs: 12 }),
    applyRelayOverride: async () => ({ ok: true, effective: { relayUrl: 'wss://next.example' } }),
    ...overrides
  };
  return { dir, auditEntries, deps, handler: createAdminHandler(deps) };
}

function mockRes() {
  return {
    status: 0, headers: null, body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {}; },
    end(body) { this.body = body?.toString() ?? ''; }
  };
}

function mockReq(method, url, bodyObj) {
  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = { 'content-type': 'application/json' };
  if (bodyObj !== undefined) req.end(JSON.stringify(bodyObj));
  else req.end();
  return req;
}

/** 用插件自签引导令牌走三轨认证的轨 1（对任意路径生效）。 */
async function authedToken(deps) {
  const now = Date.now();
  return deps.keys.signPayload({ kind: 'kite-bootstrap', iat: now, exp: now + 600_000 });
}

test('中继配置路由：未认证一律 401（adminAuth 门后）', async () => {
  const { handler } = await fixture();
  for (const [method, url, body] of [
    ['GET', '/kite/api/relay', undefined],
    ['POST', '/kite/api/relay', { relayUrl: 'wss://x.example', relayToken: 't' }],
    ['POST', '/kite/api/relay/probe', { relayUrl: 'wss://x.example' }]
  ]) {
    const res = mockRes();
    await handler(mockReq(method, url, body), res);
    assert.equal(res.status, 401, `${method} ${url} 必须被认证门拦下`);
  }
});

test('中继配置路由：认证后 GET 直通 relayConfigStatus，且不含令牌本体', async () => {
  const { deps, handler } = await fixture();
  const token = await authedToken(deps);
  const res = mockRes();
  await handler(mockReq('GET', `/kite/api/relay?kite_token=${encodeURIComponent(token)}`), res);
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.effective.relayTokenSet, true);
  assert.equal(data.effective.relayTokenFp, 'abcd1234');
  assert.equal(JSON.stringify(data).includes('current-token'), false, '响应不得包含令牌本体');
  assert.ok(!('relayToken' in data.effective), 'effective 里根本没有 relayToken 字段');
});

test('中继配置路由：POST 成功 → 200 + ok；killed → 409；validate 失败 → 400', async () => {
  const { deps, handler } = await fixture();
  const url = `/kite/api/relay?kite_token=${encodeURIComponent(await authedToken(deps))}`;

  const okRes = mockRes();
  await handler(mockReq('POST', url, { relayUrl: 'wss://next.example', relayToken: '' }), okRes);
  assert.equal(okRes.status, 200);
  assert.equal(JSON.parse(okRes.body).ok, true);

  const killed = await fixture({
    killSwitch: { enabled: true },
    applyRelayOverride: async () => ({ ok: false, stage: 'killed', reason: 'kill switch 生效中' })
  });
  const killedRes = mockRes();
  await killed.handler(mockReq('POST', `/kite/api/relay?kite_token=${encodeURIComponent(await authedToken(killed.deps))}`, { relayUrl: 'wss://next.example', relayToken: 't' }), killedRes);
  assert.equal(killedRes.status, 409);

  const failing = await fixture({ applyRelayOverride: async () => ({ ok: false, stage: 'validate', reason: '令牌必填' }) });
  const badRes = mockRes();
  await failing.handler(mockReq('POST', `/kite/api/relay?kite_token=${encodeURIComponent(await authedToken(failing.deps))}`, { relayUrl: 'wss://bad.example' }), badRes);
  assert.equal(badRes.status, 400);
  assert.equal(JSON.parse(badRes.body).stage, 'validate');
});

test('中继配置路由：探针路由直通 probeRelayConfig（错误也 200 + ok:false，由 UI 分诊）', async () => {
  const failing = await fixture({ probeRelayConfig: async () => ({ ok: false, code: 'auth', reason: '令牌被拒' }) });
  const token = await authedToken(failing.deps);
  const res = mockRes();
  await failing.handler(mockReq('POST', `/kite/api/relay/probe?kite_token=${encodeURIComponent(token)}`, { relayUrl: 'wss://x.example' }), res);
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, false);
  assert.equal(data.code, 'auth');
});

test('中继配置路由：审计 relay.reconfigure 只含指纹前缀，不含令牌本体', async () => {
  const SECRET = 'super-secret-token-value';
  const { deps, auditEntries, handler } = await fixture({
    applyRelayOverride: async () => {
      // 模拟 index.js 真实实现的审计行为（指纹前缀，无本体）
      deps.audit.append({ kind: 'relay.reconfigure', source: 'panel', relayUrl: 'wss://next.example', tokenFingerprint: 'abcd1234' });
      return { ok: true, effective: {} };
    }
  });
  const token = await authedToken(deps);
  const res = mockRes();
  await handler(mockReq('POST', `/kite/api/relay?kite_token=${encodeURIComponent(token)}`, { relayUrl: 'wss://next.example', relayToken: SECRET }), res);
  assert.equal(res.status, 200);
  const entry = auditEntries.find((e) => e.kind === 'relay.reconfigure');
  assert.ok(entry, '审计必须记录 relay.reconfigure');
  assert.equal(entry.tokenFingerprint, 'abcd1234');
  assert.equal(JSON.stringify(auditEntries).includes(SECRET), false, '审计里不得出现令牌本体');
});

test('中继配置路由：killswitch 开关 / relay-override 旧路由不受影响', async () => {
  const { dir, deps, handler } = await fixture();
  const token = await authedToken(deps);
  const url = (p) => `/kite${p}?kite_token=${encodeURIComponent(token)}`;
  const killRes = mockRes();
  await handler(mockReq('POST', url('/api/killswitch'), { enabled: true }), killRes);
  assert.equal(killRes.status, 200);
  assert.equal(JSON.parse(killRes.body).enabled, true);
  const store = new RelayOverrideStore(dir);
  assert.equal(await store.load(), null, 'killswitch 操作不碰 override 文件');
});
