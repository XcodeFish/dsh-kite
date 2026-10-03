import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { forwardRequest, rebuildRequestHeaders, filterResponseHeaders, pairRequiredPage } from '../proxy/reverse-proxy.js';
import { createPolicy } from '../policy/methods.js';
import { AuditLog } from '../policy/audit.js';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

function fakeCredential(base, cookie = 'dsh-auth-test=v1.a.b', hooks = {}) {
  return {
    acquire: async () => {
      hooks.acquires = (hooks.acquires ?? 0) + 1;
      return { base, cookie };
    },
    invalidate: () => {
      hooks.invalidations = (hooks.invalidations ?? 0) + 1;
    }
  };
}

function startLoopback(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function tmpAudit() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ra-proxy-'));
  return new AuditLog(dir, console);
}

test('请求重建：白名单头 + Host 重写（防 header 泄漏回归的核心断言）', async () => {
  const headers = rebuildRequestHeaders(
    {
      cookie: 'ra-device=attacker',
      origin: 'https://relay.example.com',
      'sec-fetch-site': 'cross-site',
      'x-dsh-desktop-renderer': 'forged',
      'content-type': 'application/json',
      'x-forwarded-for': '1.2.3.4',
      'accept-encoding': 'gzip'
    },
    'dsh-auth-real=v1.x.y'
  );
  // 头集合必须是白名单子集：cookie + content-type，其它一律不出现。
  assert.deepEqual(Object.keys(headers).sort(), ['content-type', 'cookie']);
  assert.equal(headers.cookie, 'dsh-auth-real=v1.x.y', 'loopback cookie 注入');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers.origin, undefined);
  assert.equal(headers['x-dsh-desktop-renderer'], undefined);
  assert.equal(headers['sec-fetch-site'], undefined);
});

test('响应头过滤：★设备 cookie 放行，宿主 cookie 剥离', () => {
  const filtered = filterResponseHeaders({
    'content-type': 'text/html',
    'content-length': '12',
    'set-cookie': 'ra-device=v1.abc.sig; Path=/; HttpOnly',
    'x-powered-by': 'node',
    connection: 'keep-alive',
    'content-encoding': 'br',
    etag: 'W/"abc"'
  });
  assert.deepEqual(Object.keys(filtered).sort(), ['content-length', 'content-type', 'etag', 'set-cookie']);
  assert.match(filtered['set-cookie'], /^ra-device=/);
});

test('响应头过滤：宿主 dsh-auth cookie 绝不外泄', () => {
  const filtered = filterResponseHeaders({
    'content-type': 'text/html',
    'set-cookie': ['dsh-auth-abc=v1.secret.sig; Path=/', 'session=leak; Path=/']
  });
  assert.equal(filtered['set-cookie'], undefined, '宿主/无关 cookie 一律剥离');
});

test('响应头过滤：混合多值时只留 ra-device', () => {
  const filtered = filterResponseHeaders({
    'content-type': 'text/html',
    'set-cookie': ['dsh-auth-x=leak; Path=/', 'ra-device=v1.a.b; Path=/', 'other=y']
  });
  assert.equal(filtered['set-cookie'], 'ra-device=v1.a.b; Path=/');
});

test('转发集成：真实 loopback——方法/路径/体可达，响应返回，头不泄漏宿主 cookie', async () => {
  const { server, port } = await startLoopback((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'dsh-auth-should-not-leak=x; Path=/',
        'x-internal': 'yes'
      });
      res.end(JSON.stringify({ seenPath: req.url, seenCookie: req.headers.cookie, seenType: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }));
    });
  });
  try {
    const audit = await tmpAudit();
    const base = `http://127.0.0.1:${port}`;
    const result = await forwardRequest(
      { credential: fakeCredential(base), policy: createPolicy({ remoteAgentPreset: 'default', allowedAgentPresets: ['default'] }), audit: (e) => audit.append(e), logger: console },
      {
        deviceId: 'd1',
        method: 'POST',
        path: '/api/session/list',
        headers: { cookie: 'ra-device=forged', 'content-type': 'application/json', origin: 'https://relay.example.com' },
        body: Buffer.from('{"type":"client-request"}'),
        isDeviceValid: true
      }
    );
    assert.equal(result.status, 200);
    const parsed = JSON.parse(result.body.toString('utf8'));
    assert.equal(parsed.seenPath, '/api/session/list');
    assert.equal(parsed.seenCookie, 'dsh-auth-test=v1.a.b', '只带 Connector 的 cookie');
    assert.equal(parsed.seenType, 'application/json');
    assert.equal(parsed.body, '{"type":"client-request"}');
    assert.equal(result.headers['set-cookie'], undefined, '宿主 dsh-auth cookie 不回给远端');
    assert.equal(result.headers['x-internal'], undefined);
  } finally {
    server.close();
  }
});

test('转发集成：策略拒绝不触达 loopback', async () => {
  const audit = await tmpAudit();
  let touched = false;
  const { server } = await startLoopback(() => {
    touched = true;
  });
  try {
    const hooks = {};
    const result = await forwardRequest(
      { credential: fakeCredential('http://127.0.0.1:1', 'dsh-auth-x=1', hooks), policy: createPolicy({ remoteAgentPreset: 'default', allowedAgentPresets: ['default'], allowUpload: false }), audit: (e) => audit.append(e), logger: console },
      { deviceId: 'd1', method: 'POST', path: '/api/session/uploadFileBinary', headers: {}, body: Buffer.from('x'), isDeviceValid: true }
    );
    assert.equal(result.status, 403);
    assert.equal(touched, false, '被拒请求绝不转发');
    assert.equal(hooks.acquires, undefined, '被拒请求不消耗凭据');
    const denied = audit.tail(5).find((e) => e.kind === 'policy.denied');
    assert.ok(denied, '拒绝必须留审计');
    assert.match(denied.reason, /上传/);
  } finally {
    server.close();
  }
});

test('转发集成：未配对设备 401 配对引导页（authn 先于 authz）', async () => {
  const audit = await tmpAudit();
  const hooks = {};
  const result = await forwardRequest(
    { credential: fakeCredential('http://127.0.0.1:1', 'dsh-auth-x=1', hooks), policy: createPolicy({ remoteAgentPreset: 'default', allowedAgentPresets: ['default'] }), audit: (e) => audit.append(e), logger: console },
    { deviceId: 'unknown', method: 'GET', path: '/api/session/list', headers: {}, isDeviceValid: false }
  );
  assert.equal(result.status, 401);
  assert.match(result.body.toString(), /需要配对/);
  assert.equal(hooks.acquires, undefined, '未认证请求绝不建立凭据');
});

test('转发集成：401 触发凭据刷新并重试一次', async () => {
  let first = true;
  const { server, port } = await startLoopback((req, res) => {
    if (first) {
      first = false;
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok-after-refresh');
  });
  try {
    const audit = await tmpAudit();
    const hooks = {};
    const result = await forwardRequest(
      { credential: fakeCredential(`http://127.0.0.1:${port}`, 'dsh-auth-old=v1', hooks), policy: createPolicy({ remoteAgentPreset: 'default', allowedAgentPresets: ['default'] }), audit: (e) => audit.append(e), logger: console },
      { deviceId: 'd1', method: 'GET', path: '/', headers: {}, isDeviceValid: true }
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), 'ok-after-refresh');
    assert.equal(hooks.invalidations, 1, '401 恰好触发一次 invalidate');
    assert.equal(hooks.acquires, 2, '重新交换一次凭据');
    assert.ok(audit.tail(5).some((e) => e.kind === 'proxy.credential-refresh'));
  } finally {
    server.close();
  }
});

test('转发集成：session/create 走策略重写后才转发', async () => {
  const { server, port } = await startLoopback((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(Buffer.concat(chunks).toString('utf8') || '{}');
    });
  });
  try {
    const audit = await tmpAudit();
    const result = await forwardRequest(
      { credential: fakeCredential(`http://127.0.0.1:${port}`), policy: createPolicy({ remoteAgentPreset: 'default', allowedAgentPresets: ['default'] }), audit: (e) => audit.append(e), logger: console },
      { deviceId: 'd1', method: 'POST', path: '/api/session/create', headers: { 'content-type': 'application/json' }, body: Buffer.from('{"cwd":"/tmp"}'), isDeviceValid: true }
    );
    const forwarded = JSON.parse(result.body.toString());
    assert.equal(forwarded.cwd, '/tmp');
    assert.equal(forwarded.agentPreset, 'default', '远程预设已注入');
  } finally {
    server.close();
  }
});

test('转发集成：非法方法 405、非法路径 400', async () => {
  const audit = await tmpAudit();
  const deps = { credential: fakeCredential('http://127.0.0.1:1'), policy: createPolicy({ remoteAgentPreset: 'default', allowedAgentPresets: ['default'] }), audit: (e) => audit.append(e), logger: console };
  assert.equal((await forwardRequest(deps, { deviceId: 'd', method: 'TRACE', path: '/', headers: {}, isDeviceValid: true })).status, 405);
  assert.equal((await forwardRequest(deps, { deviceId: 'd', method: 'GET', path: 'http://evil/x', headers: {}, isDeviceValid: true })).status, 400);
});

test('配对引导页不含宿主信息', () => {
  const html = pairRequiredPage().toString('utf8');
  assert.match(html, /需要配对/);
  assert.doesNotMatch(html, /127\.0\.0\.1|dsh-auth-/);
});

test('★流式响应：SSE 必须边收边转发（不得缓冲到结束）', async () => {
  // 起一个 SSE 服务：先发头 + 一条事件，3 秒后才结束 —— 若代理缓冲，首块会等到 3 秒后
  const { server, port } = await startLoopback((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: first\n\n');
    setTimeout(() => { res.write('data: second\n\n'); res.end(); }, 3000);
  });
  try {
    const audit = await tmpAudit();
    const t0 = Date.now();
    const result = await forwardRequest(
      { credential: fakeCredential(`http://127.0.0.1:${port}`), policy: createPolicy({ remoteAgentPreset: 'default', allowedAgentPresets: ['default'] }), audit: (e) => audit.append(e), logger: console },
      { deviceId: 'd1', method: 'POST', path: '/api/session/follow', headers: { 'content-type': 'application/json' }, body: Buffer.from('{}'), isDeviceValid: true }
    );
    const elapsed = Date.now() - t0;
    // 关键断言：拿到的是 stream（未缓冲），且返回得远早于 3 秒
    assert.ok(result.stream, '应返回可读流而非缓冲后的 body');
    assert.ok(elapsed < 1500, `首块应立即可得（实际 ${elapsed}ms，>1500ms 说明被缓冲）`);
    // 消费流验证内容完整
    const reader = result.stream.getReader();
    let text = '';
    for (;;) { const { done, value } = await reader.read(); if (done) break; text += Buffer.from(value).toString('utf8'); }
    assert.match(text, /first/);
    assert.match(text, /second/);
  } finally { server.close(); }
});

test('★ 大型插件模块边 gzip 边转发，首块先于上游完整下载到达', async () => {
  const payload = Buffer.from(('export const value = "mobile-startup-module";\n').repeat(16_384).slice(0, 512 * 1024));
  const { server, port } = await startLoopback((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'content-length': String(payload.length),
      'cache-control': 'public, max-age=31536000, immutable'
    });
    res.write(payload.subarray(0, 256 * 1024));
    setTimeout(() => res.end(payload.subarray(256 * 1024)), 700);
  });
  try {
    const deps = {
      credential: fakeCredential(`http://127.0.0.1:${port}`),
      policy: createPolicy({ remoteAgentPreset: 'default', allowedAgentPresets: ['default'] }),
      audit: () => {},
      logger: console
    };
    const startedAt = Date.now();
    const result = await forwardRequest(deps, {
      deviceId: 'd1',
      method: 'GET',
      path: '/plugins/??@deepseek-ai/client.js&rev=abc12345',
      headers: { 'accept-encoding': 'gzip' },
      isDeviceValid: true
    });

    assert.ok(result.stream, '大静态模块应返回流，而不是等待完整缓冲');
    assert.ok(Date.now() - startedAt < 500, '代理应在上游响应尚未完成时返回');
    assert.equal(result.headers['content-encoding'], 'gzip');
    assert.equal(result.headers['content-length'], undefined, '流式压缩不得沿用原始长度');
    assert.match(result.headers.vary, /Accept-Encoding/i);
    assert.equal(result.headers['cache-control'], 'public, max-age=31536000, immutable');

    const reader = result.stream.getReader();
    const first = await reader.read();
    assert.equal(first.done, false, '应收到首个压缩块');
    assert.ok(Date.now() - startedAt < 600, '首块应在上游第二块到达前送出');
    const chunks = [Buffer.from(first.value)];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
  } finally { server.close(); }
});

test('静态资源尊重 gzip;q=0，并保留原始长度', async () => {
  const payload = Buffer.alloc(300 * 1024, 0x61);
  const { server, port } = await startLoopback((_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/javascript',
      'content-length': String(payload.length)
    });
    res.end(payload);
  });
  try {
    const result = await forwardRequest({
      credential: fakeCredential(`http://127.0.0.1:${port}`),
      policy: createPolicy({ remoteAgentPreset: 'default', allowedAgentPresets: ['default'] }),
      audit: () => {},
      logger: console
    }, {
      deviceId: 'd1',
      method: 'GET',
      path: '/assets/app.js',
      headers: { 'accept-encoding': 'gzip;q=0, *;q=1' },
      isDeviceValid: true
    });

    assert.ok(result.stream, '大资源仍应采用流式转发');
    assert.equal(result.headers['content-encoding'], undefined, 'gzip;q=0 必须优先于通配符');
    assert.equal(result.headers['content-length'], String(payload.length));
    const reader = result.stream.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    assert.deepEqual(Buffer.concat(chunks), payload);
  } finally { server.close(); }
});
