/**
 * 完整链路追踪：用真实中继 + 真实插件（本机起一份新版），逐步验证每一步的凭据与路由。
 * 这是「拿着链接自测」的完整版。
 */
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// 仓库根目录：相对本文件解析，克隆到任意路径都能跑
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const { loadConnectorKeys } = await import(`${ROOT}/identity/keys.js`);
const { DeviceStore } = await import(`${ROOT}/identity/device-store.js`);
const { createTicketService } = await import(`${ROOT}/identity/ticket.js`);
const { createPairingService } = await import(`${ROOT}/identity/pairing.js`);
const { createAdminHandler, createPairPageHandler, KillSwitch } = await import(`${ROOT}/admin/panel.js`);

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ra-full-'));
const keys = await loadConnectorKeys(dir);
const devices = await new DeviceStore(dir, console).load();
const tickets = createTicketService(keys, 12 * 3600_000, console);
const pairing = createPairingService({ keys, tickets, devices, ttlMs: 120_000, secureCookies: false });
const pairPage = createPairPageHandler({ pairing, fingerprint: keys.fingerprint, tickets, devices, audit: () => {} });
const admin = createAdminHandler({
  adapter: { requestRejection: () => 401, launchToken: () => undefined },
  keys, killSwitch: new KillSwitch(dir), devices, pairing,
  audit: { tail: () => [], append: () => {} }, fingerprint: keys.fingerprint,
  relayStatus: () => ({ state: 'open', metrics: {} }), kickDevice: () => {},
  relayPublicUrl: () => 'http://127.0.0.1:9999', relayOwned: true, probe: async () => ({ overall: 'ok', checks: [] })
});

// 模拟 DSH 的 webServer：/kite/* 给插件，其余当作 DSH 首页
const dshHome = '<!doctype html><html><body><div id="app">DSH 主界面（真实用户会看到这个）</div></body></html>';
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/kite/pair')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let r;
      try { r = await pairPage({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks) }); }
      catch (e) { r = { status: 400, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ ok: false, error: e.message })) }; }
      res.writeHead(r.status, r.headers || {});
      res.end(r.body);
    });
    return;
  }
  if (url.pathname.startsWith('/kite')) return admin(req, res);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(dshHome);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const results = [];
const check = (n, ok, extra) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ' → ' + extra : ''}`); };

// ① entry 免认证
let r = await fetch(`http://127.0.0.1:${port}/kite/api/entry`);
let d = await r.json();
check('① /api/entry 免认证可用（修复死锁）', r.status === 200 && d.url.includes('kite_token='), `status=${r.status}`);

// ② 用 entry 令牌兑换 kite-admin
r = await fetch(`http://127.0.0.1:${port}${d.url}`, { redirect: 'manual' });
const adminCookie = (r.headers.get('set-cookie') || '').split(';')[0];
check('② 用令牌兑换管理凭据', r.status === 303 && adminCookie.startsWith('kite-admin='), `status=${r.status}`);

// ③ 生成配对链接
r = await fetch(`http://127.0.0.1:${port}/kite/api/pairings`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie }, body: JSON.stringify({ name: 'trace' })
});
d = await r.json();
check('③ 生成配对链接 + 二维码', r.status === 200 && /\/pair\?token=/.test(d.pairingUrl) && d.qrSvg, `qr=${d.qrSvg ? d.qrSvg.length + 'B' : '无'}`);
const token = new URL(d.pairingUrl, 'http://x').searchParams.get('token');

// ④ 手机侧：生成密钥 → begin
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const spki = publicKey.export({ type: 'spki', format: 'der' });
const pubB64 = spki.subarray(spki.length - 32).toString('base64url');
r = await fetch(`http://127.0.0.1:${port}/kite/pair/begin`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token, pubKey: pubB64, name: 'trace' })
});
const begin = await r.json();
check('④ pair/begin 返回挑战与校验码', r.status === 200 && begin.challenge && /^\d{6}$/.test(begin.code), `code=${begin.code}`);

// ⑤ 签名 → complete，观察 set-cookie
const ts = Date.now();
const sig = sign(null, Buffer.concat([Buffer.from(begin.challenge), Buffer.from(begin.connectorId), Buffer.from(String(ts))]), privateKey).toString('base64url');
r = await fetch(`http://127.0.0.1:${port}/kite/pair/complete`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ challenge: begin.challenge, sig, ts })
});
const setCookie = r.headers.get('set-cookie') || '';
const done = await r.json();
check('⑤ ★配对完成并下发设备 cookie', r.status === 200 && /^ra-device=v1\./.test(setCookie), `set-cookie=${setCookie.slice(0, 22)}… deviceId=${done.deviceId}`);

// ⑥ 带设备 cookie 访问根路径 → 应到达 DSH 首页（不是提示页）
const deviceCookie = setCookie.split(';')[0];
r = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: deviceCookie } });
const home = await r.text();
check('⑥ ★带设备 cookie 访问 / → 到达 DSH（非提示页）', r.status === 200 && home.includes('DSH 主界面'), `status=${r.status} ${home.length}B`);

// ⑦ 多设备：再配一台，两台都能路由
const { publicKey: pk2, privateKey: sk2 } = generateKeyPairSync('ed25519');
const spki2 = pk2.export({ type: 'spki', format: 'der' });
const token2 = (await (await fetch(`http://127.0.0.1:${port}/kite/api/pairings`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie }, body: JSON.stringify({ name: 'phone2' })
})).json()).pairingUrl;
const b2 = await (await fetch(`http://127.0.0.1:${port}/kite/pair/begin`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: new URL(token2, 'http://x').searchParams.get('token'), pubKey: spki2.subarray(spki2.length - 32).toString('base64url'), name: 'phone2' })
})).json();
const ts2 = Date.now();
const sig2 = sign(null, Buffer.concat([Buffer.from(b2.challenge), Buffer.from(b2.connectorId), Buffer.from(String(ts2))]), sk2).toString('base64url');
const r2c = await fetch(`http://127.0.0.1:${port}/kite/pair/complete`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challenge: b2.challenge, sig: sig2, ts: ts2 })
});
const cookie2 = (r2c.headers.get('set-cookie') || '').split(';')[0];
const r2 = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: cookie2 } });
const home2 = await r2.text();
check('⑦ 多设备：第二台也能独立路由', r2.status === 200 && home2.includes('DSH 主界面'), `devices=${devices.list().length}`);
const r1again = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: deviceCookie } });
check('  第一台仍有效（互不干扰）', r1again.status === 200, `status=${r1again.status}`);

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} 项通过`);
server.close();
process.exitCode = failed ? 1 : 0;
