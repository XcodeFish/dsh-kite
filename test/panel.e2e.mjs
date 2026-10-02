
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createAdminHandler, KillSwitch } from '../admin/panel.js';
import { loadConnectorKeys } from '../identity/keys.js';
import { CLIENT_SOURCE } from '../admin/menu-entry.js';


const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = 9333;

// ---- 模拟 DSH 主页 + 真实插件 handler ----
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ra-e2e-'));
const keys = await loadConnectorKeys(dir);

// connectorId 从数据目录的连接器公钥动态推导（不硬编码本机凭据）
const { createHash } = await import('node:crypto');
const FP = createHash('sha256').update(Buffer.concat([keys.ed25519.publicRaw, keys.x25519.publicRaw])).digest('hex').slice(0, 32);
const deps = {
  // 宿主轨可用（模拟 webview 页内 fetch 自带 dsh-auth cookie）——令牌过期后的回退路径。
  adapter: { requestRejection: () => undefined, launchToken: () => undefined, webServerPort: () => 0 },
  keys,
  killSwitch: new KillSwitch(dir),
  devices: { list: () => [], revoke: async () => true, revokeAll: async () => 0 },
  pairing: { list: () => [], begin: () => ({ token: 'tok', expiresAt: Date.now() + 120000 }), abortAll: () => 0 },
  audit: { tail: () => [{ ts: Date.now(), kind: 'proxy.forward', path: '/api/session/list' }], append: () => {}, recent: async () => [] },
  fingerprint: '${FP}',
  relayStatus: () => ({ state: 'open', relayUrl: 'wss://relay.example', metrics: { lastError: null } }),
  kickDevice: () => {},
  relayPublicUrl: () => 'https://relay.example',
  relayOwned: true,
  probe: async () => ({ overall: 'ok', checks: [{ name: 'webServer.port', status: 'passed' }] })
};
const adminHandler = createAdminHandler(deps);
// ★ 故意注入一个**已过期**的引导令牌：验证真实故障场景（用户 21:22 遇到的那个）。
const STALE = process.argv.includes('--stale');
const now0 = Date.now();
const boot = keys.signPayload(
  STALE
    ? { kind: 'kite-bootstrap', iat: now0 - 700000, exp: now0 - 1000 }
    : { kind: 'kite-bootstrap', iat: now0, exp: now0 + 600000 }
);

const pageErrors = [];

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/kite')) return adminHandler(req, res);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>DSH</title></head><body>
<div id="app-shell">DSH 主界面</div>
<script>window.__DSH_KITE_AUTH__={url:${JSON.stringify(`/kite?kite_token=${boot}`)}};</script>
<script>${CLIENT_SOURCE}<\/script>
</body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
console.log(`模拟 DSH 主页: http://127.0.0.1:${port}/`);

// ---- 无头 Chrome + CDP ----
const chrome = spawn(CHROME, [
  // ★ --no-sandbox 必需：受限文件沙箱下 Chrome 写不了 Crashpad 目录（Operation not permitted），
  //   随即 SIGTRAP，页面级 CDP socket 以 1006 断开 → Runtime.enable 永远无回执。
  //   缺了它，本测试可能静默挂起，或误连上一次遗留的浏览器实例而「假通过」。
  '--no-sandbox',
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + path.join(os.tmpdir(), 'ra-chrome-' + Date.now()), '--window-size=1440,900', 'about:blank'
], { stdio: 'ignore' });
async function waitCdp() {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('CDP 未就绪');
}
await waitCdp();

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const target = targets.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 0;
const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params?.exceptionDetails?.text ?? 'exception');
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') pageErrors.push('console: ' + (m.params.args?.[0]?.value ?? ''));
};
await new Promise((r) => { ws.onopen = r; });
const send = (method, params) => new Promise((resolve) => { const id = ++msgId; waiting.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
await new Promise((r) => setTimeout(r, 1200));

const results = [];
const check = (name, ok, extra) => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' → ' + extra : ''}`); };

check('入口按钮存在', (await evaluate("!!document.getElementById('dsh-ra-menu-entry')")) === true);
await evaluate("document.getElementById('dsh-ra-menu-entry').click()");
await new Promise((r) => setTimeout(r, 1200));
check('面板浮层出现', (await evaluate("!!document.getElementById('dsh-ra-overlay')")) === true);
const overlayText = await evaluate("document.getElementById('dsh-ra-overlay').innerText");
check('面板含标题', String(overlayText).includes('手机远程访问'), undefined);
check('徽章=已连接', String(overlayText).includes('已连接'));
check('空设备态', String(overlayText).includes('暂无设备'));
check('无 iframe', (await evaluate("document.querySelectorAll('iframe').length")) === 0);
check('审计已渲染', String(overlayText).includes('proxy.forward'));
// 生成二维码
await evaluate("document.querySelector('#dsh-ra-overlay input[placeholder*=\"设备名\"]').value='我的手机'");
await evaluate("[...document.querySelectorAll('#dsh-ra-overlay button')].find(b=>b.textContent.includes('生成配对二维码')).click()");
await new Promise((r) => setTimeout(r, 1000));
check('二维码 SVG 渲染', (await evaluate("document.querySelectorAll('#dsh-ra-overlay svg[aria-label=\"配对二维码\"]').length")) === 1);
const link = await evaluate("document.querySelector('#dsh-ra-overlay input[readonly]').value");
check('配对链接正确', String(link).includes('/kite/pair?token='), String(link).slice(0, 60));
check('页面无 JS 错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

// 截图
const shot = await send('Page.captureScreenshot', { format: 'png' });
await fsp.writeFile('/tmp/ra-e2e-panel.png', Buffer.from(shot.result.data, 'base64'));
console.log('截图: /tmp/ra-e2e-panel.png');

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 项通过`);
ws.close();
chrome.kill();
server.close();
process.exitCode = failed === 0 ? 0 : 1;
