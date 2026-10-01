import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAdminHandler, KillSwitch } from '../admin/panel.js';
import { loadConnectorKeys } from '../identity/keys.js';
import { menuEntryRows } from '../admin/menu-entry.js';

async function fixture(overrides = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kite-admin-'));
  const keys = await loadConnectorKeys(dir);
  const deps = {
    adapter: {
      requestRejection: () => 401, // 宿主轨：默认无会话
      launchToken: () => 'launch-token-abc',
      webServerPort: () => 1234
    },
    keys,
    killSwitch: new KillSwitch(dir),
    devices: { list: () => [] },
    pairing: { list: () => [], begin: () => ({ token: 't', expiresAt: Date.now() + 1000 }) },
    audit: { tail: () => [], append: () => {}, recent: async () => [] },
    fingerprint: 'fp',
    relayStatus: () => ({ state: 'open', relayUrl: 'wss://x', metrics: {} }),
    kickDevice: () => {},
    relayPublicUrl: () => 'https://t.example',
    relayOwned: true,
    probe: async () => ({ overall: 'ok', checks: [] }),
    ...overrides
  };
  return { deps, handler: createAdminHandler(deps) };
}

function mockRes() {
  return {
    status: 0, headers: null, body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {}; },
    end(body) { this.body = body?.toString() ?? ''; }
  };
}

test('管理面认证：无凭据 → 401（宿主轨失败）', async () => {
  const { handler } = await fixture();
  const res = mockRes();
  await handler({ method: 'GET', url: '/kite', headers: {} }, res);
  assert.equal(res.status, 401);
  assert.match(res.body, /认证失败/, '失败原因必须可读');
  assert.match(res.body, /宿主轨 rejection=401/, '带三轨诊断细节');
});

test('管理面认证：bootstrap 令牌兑换 → 303 到干净 URL + kite-admin cookie', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kite-admin-tok-'));
  const keys = await loadConnectorKeys(dir);
  const { handler } = await fixture({ keys });
  const now = Date.now();
  const token = keys.signPayload({ kind: 'kite-bootstrap', iat: now, exp: now + 600_000 });
  const res = mockRes();
  await handler({ method: 'GET', url: `/kite?kite_token=${encodeURIComponent(token)}`, headers: {} }, res);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/kite');
  assert.match(res.headers['set-cookie'], /^kite-admin=v1\./);
  assert.match(res.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
});

test('管理面认证：过期 bootstrap 令牌 → 403', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kite-admin-exp-'));
  const keys = await loadConnectorKeys(dir);
  const { handler } = await fixture({ keys });
  const now = Date.now();
  const token = keys.signPayload({ kind: 'kite-bootstrap', iat: now - 700_000, exp: now - 1000 });
  const res = mockRes();
  await handler({ method: 'GET', url: `/kite?kite_token=${encodeURIComponent(token)}`, headers: {} }, res);
  // 过期令牌不短路：继续走宿主轨，最终回宿主轨的状态码（fixture 为 401）。
  assert.equal(res.status, 401, '令牌过期且宿主轨不可用 → 呈宿主轨判定');
  assert.match(res.body, /引导令牌无效\/过期/);
});

test('管理面认证：★令牌过期但宿主轨可用 → 回落 200（不得成为单点故障）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kite-admin-fall-'));
  const keys = await loadConnectorKeys(dir);
  const { handler } = await fixture({
    keys,
    adapter: {
      requestRejection: (req) => (req.headers.cookie?.includes('dsh-auth-x') ? undefined : 401),
      launchToken: () => undefined
    }
  });
  const now = Date.now();
  const stale = keys.signPayload({ kind: 'kite-bootstrap', iat: now - 700_000, exp: now - 1000 });
  const res = mockRes();
  await handler({ method: 'GET', url: `/kite?kite_token=${encodeURIComponent(stale)}`, headers: { cookie: 'dsh-auth-x=1' } }, res);
  assert.equal(res.status, 200, '过期令牌不得阻断面板');
  assert.ok(res.body.includes('DSH Kite'));
  assert.match(res.headers['set-cookie'] || '', /kite-admin=v1\./, '宿主轨也下发长效 cookie');
});

test('管理面认证：/api/entry 实时签发新鲜令牌', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kite-admin-entry-'));
  const keys = await loadConnectorKeys(dir);
  const { handler } = await fixture({
    keys,
    adapter: { requestRejection: () => undefined, launchToken: () => undefined }
  });
  const res = mockRes();
  // ★ 免认证：entry 是获取令牌的端点，要求认证会死锁
  await handler({ method: 'GET', url: '/kite/api/entry', headers: {} }, res);
  assert.equal(res.status, 200, 'entry 必须免认证（否则令牌获取死锁）');
  const { url } = JSON.parse(res.body);
  const token = decodeURIComponent(new URL(`http://x${url}`).searchParams.get('kite_token'));
  const payload = keys.verifyPayload(token);
  assert.equal(payload.kind, 'kite-bootstrap');
  assert.ok(payload.exp > Date.now() + 8 * 60 * 1000, '新签发令牌至少还有 8 分钟');
});

test('管理面认证：kite-admin cookie 直达面板 200', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kite-admin-cook-'));
  const keys = await loadConnectorKeys(dir);
  const { handler } = await fixture({ keys });
  const now = Date.now();
  const cookie = `kite-admin=${keys.signPayload({ kind: 'kite-admin', iat: now, exp: now + 3600_000 })}`;
  const res = mockRes();
  await handler({ method: 'GET', url: '/kite', headers: { cookie } }, res);
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('DSH Kite'));
});

test('管理面认证：伪造/无效 kite_token → 403', async () => {
  const { handler } = await fixture();
  const res = mockRes();
  await handler({ method: 'GET', url: '/kite?kite_token=wrong', headers: {} }, res);
  assert.equal(res.status, 401);
  assert.match(res.body, /认证失败|引导令牌无效/);
});

test('管理面认证：兑换后的 cookie 可用于 API（免 token）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kite-admin-api-'));
  const keys = await loadConnectorKeys(dir);
  const { handler } = await fixture({ keys });
  const now = Date.now();
  const token = keys.signPayload({ kind: 'kite-bootstrap', iat: now, exp: now + 600_000 });
  const mint = mockRes();
  await handler({ method: 'GET', url: `/kite?kite_token=${encodeURIComponent(token)}`, headers: {} }, mint);
  const cookie = mint.headers['set-cookie'].split(';')[0];
  const res = mockRes();
  await handler({ method: 'GET', url: '/kite/api/status', headers: { cookie } }, res);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).relay.state, 'open');
});

test('管理面认证：伪造 kite-admin cookie → 401', async () => {
  const { handler } = await fixture();
  const res = mockRes();
  await handler({ method: 'GET', url: '/kite/api/status', headers: { cookie: 'kite-admin=v1.aaa.bbb' } }, res);
  assert.equal(res.status, 401);
});

test('管理面认证：宿主轨（dsh-auth 会话）仍可用', async () => {
  const { handler } = await fixture({
    adapter: {
      requestRejection: (req) => (req.headers.cookie?.includes('dsh-auth-x') ? undefined : 401),
      launchToken: () => 'launch-token-abc'
    }
  });
  const res = mockRes();
  await handler({ method: 'GET', url: '/kite', headers: { cookie: 'dsh-auth-x=1' } }, res);
  assert.equal(res.status, 200, '宿主轨不跳转，直接渲染');
  assert.ok(res.body.includes('DSH Kite'));
});

test('入口注入：global 行内嵌带 kite_token 的入口 URL', async () => {
  const rows = menuEntryRows({ authedUrl: '/kite?kite_token=abc' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'global');
  assert.equal(rows[0].name, '__DSH_KITE_AUTH__');
  assert.equal(rows[0].value.url, '/kite?kite_token=abc');
  assert.equal(rows[1].kind, 'script');
});
