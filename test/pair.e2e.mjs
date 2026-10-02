/**
 * 配对全链路 E2E（★可在无人值守下自测，不需要真手机）：
 *   起真实中继 → 起「模拟连接器」（直连中继，等价桌面插件）→ 无头 Chrome 打开配对页
 *   → 页面内真实生成 Ed25519 密钥、提交、签名挑战 → 断言配对完成 + 设备入库 + 校验码一致。
 * 覆盖用户 21:29 的故障：配对页 POST 不带 c 参数 → 中继 503 HTML → JSON 解析失败。
 */
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
import { fileURLToPath } from 'node:url';
// 仓库根目录：相对本文件解析，克隆到任意路径都能跑
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { createPairingService, verificationCode } = await import(`${ROOT}/identity/pairing.js`);
const { loadConnectorKeys } = await import(`${ROOT}/identity/keys.js`);
const { DeviceStore } = await import(`${ROOT}/identity/device-store.js`);
const { createTicketService } = await import(`${ROOT}/identity/ticket.js`);
const { createPairPageHandler } = await import(`${ROOT}/admin/panel.js`);
const { encodeFrame } = await import(`${ROOT}/transport/frames.js`);

const RELAY_PORT = 0; // 0 = 内核分配，测试自行解析真实端口
const RELAY_TOKEN = 'e2e-token-0123456789abcdef';
const CDP_PORT = 9300 + Math.floor(Math.random() * 600);
const results = [];
const check = (n, ok, extra) => { results.push([n, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ' → ' + extra : ''}`); };

// ---- 插件侧（模拟桌面连接器）----
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ra-paire2e-'));
const keys = await loadConnectorKeys(dir);
const devices = await new DeviceStore(dir, console).load();
const tickets = createTicketService(keys, 12 * 3600_000, console);
const pairing = createPairingService({ keys, tickets, devices, ttlMs: 120_000, secureCookies: false });
const pairPage = createPairPageHandler({ pairing, fingerprint: keys.fingerprint, tickets, devices, audit: () => {} });
const CONNECTOR_ID = keys.fingerprint;

// ---- 中继 ----
const relay = spawn(process.execPath, [`${ROOT}/relay/server.mjs`], {
  env: { ...process.env, PORT: String(RELAY_PORT), RELAY_TOKENS: RELAY_TOKEN, HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe']
});
relay.stderr.on('data', (c) => process.stderr.write(`[relay] ${c}`));
const relayPort = await new Promise((res, rej) => {
  const t = setTimeout(() => { relay.kill('SIGKILL'); rej(new Error('中继启动超时')); }, 8000);
  relay.stdout.on('data', (c) => {
    const m = /listening on [^:]+:(\d+)/.exec(String(c));
    if (m) { clearTimeout(t); res(Number(m[1])); }
  });
});
console.log(`中继已启动: 127.0.0.1:${relayPort}`);

// ---- 连接器：出站连中继（★必须在 relay 起来之后），转发到本机 pairPage ----
const relayUrl = `ws://127.0.0.1:${relayPort}/connector?c=${CONNECTOR_ID}`;
const connector = new WebSocket(relayUrl, ['ra.v1', `ra-bearer.${RELAY_TOKEN}`]);
const streams = new Map();
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('connector 连接超时')), 5000);
  connector.onopen = () => { connector.send(encodeFrame({ kind: 'hello', proto: 1, caps: ['http'] })); };
  connector.onmessage = (e) => {
    const f = JSON.parse(e.data);
    if (f.kind === 'hello-ack') {
      clearTimeout(t);
      // ★ 模拟生产行为：连接器上报已配对设备（中继据此路由带 cookie 的普通 HTTP）
      connector.send(encodeFrame({ kind: 'devices', deviceIds: devices.list().map((d) => d.deviceId) }));
      res();
      return;
    }
    if (f.kind === 'http-head') streams.set(f.streamId, { ...f, chunks: [] });
    else if (f.kind === 'http-body') {
      const s = streams.get(f.streamId); if (!s) return;
      s.chunks.push(Buffer.from(f.chunk, 'base64url'));
      if (f.final) void handleHttp(f.streamId, s);
    }
  };
  connector.onerror = (e) => { clearTimeout(t); rej(new Error('connector ws error: ' + (e && (e.message || e.error?.message) || 'unknown'))); };
});
console.log(`模拟连接器已接入中继（connectorId=${CONNECTOR_ID.slice(0, 12)}…）`);

async function handleHttp(streamId, s) {
  streams.delete(streamId);
  const body = s.chunks.length ? Buffer.concat(s.chunks) : Buffer.alloc(0);
  let res;
  try {
    res = await pairPage({ method: s.method, path: s.path, headers: s.headers ?? {}, body });
    // 配对成功（complete）后设备表变化 → 重新上报，使后续带 cookie 的请求可路由
    if (s.path.includes('/pair/complete') && res.status === 200) {
      connector.send(encodeFrame({ kind: 'devices', deviceIds: devices.list().map((d) => d.deviceId) }));
    }
  } catch (error) {
    // 服务端正常抛错（假 token 探针）→ 转成 JSON 错误响应，绝不让异常逃逸成未捕获。
    res = { status: 400, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ ok: false, error: error.message }), 'utf8') };
  }
  connector.send(encodeFrame({ kind: 'http-res-head', deviceId: s.deviceId, streamId, status: res.status, headers: res.headers ?? {} }));
  const buf = res.body ?? Buffer.alloc(0);
  connector.send(encodeFrame({ kind: 'http-res-body', deviceId: s.deviceId, streamId, chunk: buf.toString('base64url'), final: true }));
}

// ---- 配对链接 ----
const base = `http://127.0.0.1:${relayPort}`;
const { token } = pairing.begin({ name: '我的手机' });
const pairUrl = `${base}/kite/pair?token=${encodeURIComponent(token)}&name=${encodeURIComponent('我的手机')}&c=${encodeURIComponent(CONNECTOR_ID)}&pk=${encodeURIComponent(keys.ed25519.publicB64u)}`;
console.log(`配对链接: ${pairUrl.slice(0, 96)}…`);

// ★ 场景：裸访问根路径（用户 21:35 的情况）—— 必须给出可自助的指引，而非仅「未就绪」
const bare = await fetch(`${base}/`);
const bareHtml = await bare.text();
// 单连接器兜底后，裸访问会被投给连接器（由它裁决），不再是中继的 503 提示页。
check('裸访问根路径 → 被兜底路由到连接器（非中继 503）', bare.status !== 503, `status=${bare.status}`);

// ★ 回归：陈旧 cookie（hint 存在但查不到映射）时，单连接器场景仍应路由
//   （真机事故 2026-09-30：旧实现只认「hint 完全为空」才兜底 → 界面卡在「重新连接中…」）
const stale = await fetch(`${base}/?c=${encodeURIComponent(CONNECTOR_ID)}`, {
  headers: { cookie: 'ra-device=v1.eyJkZXZpY2VJZCI6InN0YWxlLWRldmljZS1pZCJ9.x' }
});
check('★陈旧 cookie（hint 无效）仍能路由到连接器', stale.status !== 503, `status=${stale.status}`);

// 先直接验证中继路由（不带 c 会 503 —— 这是用户故障的根因）
const noC = await fetch(`${base}/kite/pair/begin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
// 配对路径始终可达（单连接器兜底）；由插件返回 JSON 错误而非中继 HTML 503。
check('中继：POST 配对路径可达（不再 503 HTML）', noC.status !== 503, `status=${noC.status} type=${(noC.headers.get('content-type') || '').split(';')[0]}`);
// 带 c 时应到达插件：用不存在的 token 换取 JSON 错误响应（不消耗真实会话）
const withC = await fetch(`${base}/kite/pair/begin?c=${encodeURIComponent(CONNECTOR_ID)}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: 'definitely-not-a-real-token', pubKey: 'x' })
});
check('中继：POST 带 c → 到达插件（JSON 响应）', (withC.headers.get('content-type') || '').includes('application/json'), `status=${withC.status}`);

// ---- 无头 Chrome 走完整配对 ----
const chrome = spawn(CHROME, ['--no-sandbox', '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + path.join(os.tmpdir(), 'ra-pair-chrome-' + Date.now()), '--window-size=430,900', 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 60; i += 1) { try { if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
let msgId = 0; const waiting = new Map(); const pageErrors = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params?.exceptionDetails?.text); };
await new Promise((r) => { ws.onopen = r; });
const send = (method, params) => new Promise((resolve) => { const id = ++msgId; waiting.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.result?.value;
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: pairUrl });
await new Promise((r) => setTimeout(r, 2500));

const pageText = await evaluate('document.body.innerText');
check('配对页打开（标题正确）', String(pageText).includes('设备配对'), undefined);
check('★无 JSON 解析错误（用户故障已修）', !String(pageText).includes('Unexpected token'), String(pageText).slice(0, 80).replace(/\n/g, ' '));
check('页面无 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 1).join(''));
const code = await evaluate("document.getElementById('code') && document.getElementById('code').textContent");
check('6 位校验码显示', /^\d{6}$/.test(String(code)), String(code));
// ★ P1-3：链接带 &pk= 时必须走**手机本地计算**，页面要明确标注「本机计算」——
//   若退化成服务端回传值，校验码就重新变成「连接器跟自己对账」，中继偷换公钥不可见。
const codeSrc = await evaluate("document.getElementById('code-src') && document.getElementById('code-src').textContent");
check('★校验码为手机本地计算（非服务端回传）', /本机计算/.test(String(codeSrc)), String(codeSrc));
const devicesAfter = devices.list();
check('设备已入库 ACL', devicesAfter.length === 1, `devices=${devicesAfter.length}`);
if (devicesAfter.length === 1) {
  const expected = verificationCode(devicesAfter[0].pubKey, keys.ed25519.publicB64u);
  check('★桌面侧校验码与手机侧一致（防中间人）', expected === String(code), `桌面=${expected} 手机=${code}`);
  check('deviceId 前缀合法', /^[A-Za-z0-9_-]{22}$/.test(devicesAfter[0].deviceId), devicesAfter[0].deviceId.slice(0, 10) + '…');
}
// ★ 关键：点「确认并进入 DSH」→ 浏览器应带 ra-device cookie 跳转，且该 cookie 已保存
await evaluate("document.getElementById('confirm') && document.getElementById('confirm').click()");
await new Promise((r) => setTimeout(r, 2500));
const cookiesAfter = await send('Network.getAllCookies', {});
ws.send(JSON.stringify({ id: ++msgId, method: 'Network.enable' }));
await new Promise((r) => setTimeout(r, 300));
const cookieList = (await send('Network.getAllCookies', {})).result?.cookies ?? [];
const deviceCookie = cookieList.find((c) => c.name === 'ra-device');
check('★点确认后 ra-device cookie 已存入浏览器', Boolean(deviceCookie), deviceCookie ? `domain=${deviceCookie.domain} path=${deviceCookie.path}` : '未找到');
check('  cookie 作用域覆盖根路径（可路由到 DSH）', deviceCookie ? deviceCookie.path === '/' : false, deviceCookie ? `path=${deviceCookie.path}` : '');
const urlAfter = await evaluate('location.href');
check('  已跳转到 DSH 根路径（不再停在配对页）', String(urlAfter).endsWith('/') || !String(urlAfter).includes('/pair'), String(urlAfter).slice(0, 70));
const bodyAfter = await evaluate('document.body.innerText');
check('  后续页面可路由（非「需要配对链接」提示）', !String(bodyAfter).includes('需要配对链接'), String(bodyAfter).slice(0, 50).replace(/\n/g, ' '));

const shot = await send('Page.captureScreenshot', { format: 'png' });
await fsp.writeFile('/tmp/ra-pair-e2e.png', Buffer.from(shot.result.data, 'base64'));
console.log('截图: /tmp/ra-pair-e2e.png');

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 项通过`);
ws.close(); chrome.kill(); relay.kill(); connector.close();
process.exitCode = failed ? 1 : 0;

