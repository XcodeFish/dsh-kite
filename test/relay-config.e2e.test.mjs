/**
 * 中继配置面全链路集成测试（HANDOVER §5.9 验收核心，真进程）：
 *   真中继（relay/server.mjs）+ 真插件 boot（fake ctx 承载 webServer 路由）。
 * 覆盖：
 *   ① 面板 POST 配置 → 服务端复探针 → relay-override.json 0600 落盘 → 原地生效 → 连接器上线；
 *   ② 探针绝不挤掉在线连接器（§5.5 坑 1 的回归红线）：探针后 /healthz connectors 不减、
 *      连接器不重连；
 *   ③ GET /kite/api/relay 响应不含令牌本体；审计 relay.reconfigure 只含指纹前缀；
 *   ④ 校验：远程 ws:// 被拒；探针错误分类（错令牌 → auth）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

const RELAY_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'relay', 'server.mjs');
const TOKEN = 'ra-e2e-token-0123456789abcdef';

function startRelay() {
  const child = spawn(process.execPath, [RELAY_SCRIPT], {
    env: { ...process.env, PORT: '0', RELAY_TOKENS: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('relay start timeout')); }, 8000);
    child.stdout.on('data', (chunk) => {
      const match = /listening on [^ ]+:(\d+)/.exec(String(chunk));
      if (match) { clearTimeout(timer); resolve({ child, port: Number(match[1]) }); }
    });
    child.on('exit', (code) => reject(new Error(`relay exited early: ${code}`)));
  });
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

async function bootPlugin(home) {
  const { apply } = await import('../index.js?e2e=' + Date.now());
  const routes = [];
  const disposers = [];
  const ctx = {
    logger: { info: () => {}, warn: (m) => process.stderr.write(`[kite] ${m}\n`) },
    inject: () => {},
    // 宿主轨：带 dsh-auth-fake cookie 视为有会话；authenticatedUrl 供 launchToken 轨解析
    get: (name) => (name === 'connection' ? {
      requestRejection: (req) => (String(req.headers.cookie ?? '').includes('dsh-auth-fake') ? undefined : 401),
      authenticatedUrl: (base) => `${base}/?token=e2e-launch-token`
    } : undefined),
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    // cordis 语义：effect(fn) 立即执行 fn（fn 返回 disposer），disposer 在 teardown 调用。
    effect: (fn) => { const d = typeof fn === 'function' ? fn() : undefined; disposers.push(d); return () => {}; },
    on: () => () => {}
  };
  apply(ctx, {});
  const adminRoute = () => routes.find((r) => r.path === '/kite');
  // 等 boot 完成（deps 就位 → /kite/api/relay 从 503「启动中」变为认证门的 401）
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const route = adminRoute();
    if (route) {
      const res = mockRes();
      await route.handler(mockReq('GET', '/kite/api/relay'), res);
      if (res.status !== 503) return { ctx, effects: disposers, adminRoute };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('plugin boot timeout');
}

/** 轨 1 的真实来源：插件自签引导令牌（/kite/api/entry 免认证端点）。
 *  ★ P2 已移除「宿主 launchToken 当插件管理面凭据」这条轨，测试同步改走生产同源路径。 */
async function bootstrapToken(adminRoute) {
  const res = mockRes();
  await adminRoute().handler(mockReq('GET', '/kite/api/entry'), res);
  const entryUrl = JSON.parse(res.body).url;
  return new URLSearchParams(entryUrl.split('?')[1] ?? '').get('kite_token');
}

async function callRoute(adminRoute, method, url, bodyObj) {
  const token = await bootstrapToken(adminRoute);
  const sep = url.includes('?') ? '&' : '?';
  const res = mockRes();
  await adminRoute().handler(mockReq(method, `${url}${sep}kite_token=${encodeURIComponent(token)}`, bodyObj), res);
  return res;
}

async function healthz(port) {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) });
  return res.json();
}

/** 健康检查轮询到条件成立（探针关闭握手等异步收敛），超时返回最后一个快照。 */
async function pollHealthz(port, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await healthz(port);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

test('中继配置面：面板改配置 → 探针 → 落盘 → 连接器上线 → 探针不挤掉在线连接', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'kite-e2e-home-'));
  const prevHome = process.env.DSH_HOME;
  const prevProfile = process.env.DSH_PROFILE;
  process.env.DSH_HOME = home;
  delete process.env.DSH_PROFILE;
  const relay = await startRelay();
  let booted = null;
  try {
    booted = await bootPlugin(home);
    const { adminRoute } = booted;
    const relayUrl = `ws://127.0.0.1:${relay.port}`;
    const dataDir = path.join(home, 'plugin-data', 'dsh-kite', 'default');

    // ① 校验：远程 ws://（非回环）直接拒绝，不探针不落盘
    const rejected = await callRoute(adminRoute, 'POST', '/kite/api/relay', { relayUrl: 'ws://203.0.113.1:8443', relayToken: TOKEN });
    assert.equal(rejected.status, 400);
    assert.equal(JSON.parse(rejected.body).stage, 'validate');
    assert.equal(await fsp.access(path.join(dataDir, 'relay-override.json')).then(() => true, () => false), false, '校验失败不得落盘');

    // ② 探针：错令牌 → auth 分类
    const badProbe = JSON.parse((await callRoute(adminRoute, 'POST', '/kite/api/relay/probe', { relayUrl, relayToken: 'wrong-token' })).body);
    assert.equal(badProbe.ok, false);
    assert.equal(badProbe.code, 'auth');

    // ③ 应用正确配置 → ok → 落盘 0600 → 连接器上线
    const applied = JSON.parse((await callRoute(adminRoute, 'POST', '/kite/api/relay', { relayUrl, relayToken: TOKEN, relayPublicUrl: '' })).body);
    assert.equal(applied.ok, true, `应用失败：${JSON.stringify(applied)}`);
    assert.equal(applied.effective.effective.relayTokenSet, true);
    assert.ok(applied.effective.effective.relayTokenFp && !JSON.stringify(applied).includes(TOKEN), '响应含指纹且不含令牌本体');
    const overrideStat = await fsp.stat(path.join(dataDir, 'relay-override.json'));
    if (process.platform !== 'win32') assert.equal(overrideStat.mode & 0o777, 0o600, 'override 文件必须 0600');
    const overrideData = JSON.parse(await fsp.readFile(path.join(dataDir, 'relay-override.json'), 'utf8'));
    assert.equal(overrideData.relayToken, TOKEN, '落盘的是本体（文件 0600 保护），接口响应才是指纹');

    // 等连接器上线（hello-ack → open）
    const deadline = Date.now() + 8000;
    let status = null;
    while (Date.now() < deadline) {
      status = JSON.parse((await callRoute(adminRoute, 'GET', '/kite/api/status')).body);
      if (status.relay.state === 'open') break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(status.relay.state, 'open', '连接器应在上限时间内上线');
    let hz = await healthz(relay.port);
    assert.equal(hz.connectors, 1, '中继上恰好一条连接器连接');

    // ④ 探针绝不挤掉在线连接器（§5.5 坑 1 红线）
    const reconnectsBefore = status.relay.metrics.reconnects;
    for (let i = 0; i < 3; i += 1) {
      const probeRes = JSON.parse((await callRoute(adminRoute, 'POST', '/kite/api/relay/probe', { relayUrl, relayToken: TOKEN })).body);
      assert.equal(probeRes.ok, true, `第 ${i + 1} 次探针应通过`);
    }
    hz = await pollHealthz(relay.port, (h) => h.connectors === 1);
    assert.equal(hz.connectors, 1, '探针后在线连接器仍恰好 1 条（被探针踢掉 = 坑 1 复发；探针关闭握手异步，允许短暂收敛窗口）');
    status = JSON.parse((await callRoute(adminRoute, 'GET', '/kite/api/status')).body);
    assert.equal(status.relay.state, 'open', '探针后连接器仍在线');
    assert.equal(status.relay.metrics.reconnects, reconnectsBefore, '探针不得引发连接器重连');

    // ⑤ 重复应用（重建路径）：留空令牌沿用 → dispose 旧连接 → 新连接上线 → 归于 1
    const reapplied = JSON.parse((await callRoute(adminRoute, 'POST', '/kite/api/relay', { relayUrl, relayToken: '', relayPublicUrl: '' })).body);
    assert.equal(reapplied.ok, true, '留空令牌 = 沿用当前，应成功');
    const deadline2 = Date.now() + 8000;
    let open = false;
    while (Date.now() < deadline2) {
      const s = JSON.parse((await callRoute(adminRoute, 'GET', '/kite/api/status')).body);
      if (s.relay.state === 'open') { open = true; break; }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(open, '重建后连接器应重新上线');
    hz = await healthz(relay.port);
    assert.equal(hz.connectors, 1, '重建后中继上仍恰好 1 条连接');

    // ⑥ GET 响应与审计纪律
    const relayCfg = JSON.parse((await callRoute(adminRoute, 'GET', '/kite/api/relay')).body);
    assert.equal(relayCfg.effective.relayUrl, relayUrl);
    assert.equal(relayCfg.sources.relayUrl, 'override');
    assert.ok(!JSON.stringify(relayCfg).includes(TOKEN), 'GET 响应不得包含令牌本体');
    const auditText = await fsp.readFile(path.join(dataDir, 'audit.jsonl'), 'utf8');
    const reconfigures = auditText.split('\n').filter((l) => l.includes('relay.reconfigure'));
    assert.equal(reconfigures.length, 2, '两次应用各一条审计');
    assert.ok(!auditText.includes(TOKEN), '审计不得包含令牌本体');
    for (const line of reconfigures) {
      const entry = JSON.parse(line);
      assert.ok(entry.tokenFingerprint && entry.tokenFingerprint.length === 8, '审计只含 8 位指纹');
    }
  } finally {
    // 清理：调用插件注册的 disposer（dispose relay / 释放锁），再关中继
    for (const d of booted?.effects ?? []) {
      try {
        if (typeof d === 'function') await d();
      } catch { /* ignore */ }
    }
    relay.child.kill('SIGKILL');
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    if (prevProfile === undefined) delete process.env.DSH_PROFILE;
    else process.env.DSH_PROFILE = prevProfile;
  }
});
