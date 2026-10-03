
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
/**
 * ★ 可驱动的配对服务替身：让 e2e 能走完「生成二维码 → 手机提交公钥 → 配对成功」
 *   全过程，用来回归 2026-10-03「红框滞留等待手机提交…」事故。
 *   真身是 identity/pairing.js；这里只复刻面板依赖的契约：
 *   list() = 进行中（提交公钥后才有 code），last() = 已终结（成功/失败/过期）。
 */
const pairingStub = {
  state: null, // { token, expiresAt, code?, used } | null
  lastOutcome: null,
  list() {
    if (!this.state) return [];
    const { token, expiresAt, code } = this.state;
    return [{ tokenMasked: `${token.slice(0, 6)}…${token.slice(-4)}`, name: '我的手机', expiresAt, used: false, ...(code ? { code } : {}) }];
  },
  last() { return this.lastOutcome; },
  begin({ name } = {}) {
    const token = 'tok-' + Math.random().toString(36).slice(2, 10).padEnd(10, 'x');
    this.state = { token, name: name || 'phone', expiresAt: Date.now() + 120000, code: null, used: false };
    return { token, expiresAt: this.state.expiresAt };
  },
  /** 模拟手机提交公钥 → 出桌面侧校验码。 */
  submit() {
    if (this.state) this.state.code = '123456';
  },
  /** 模拟手机签完确认 → 配对成功（会话消失 + 记成功终态）。 */
  complete() {
    if (!this.state) return;
    const token = this.state.token;
    const tokenMasked = `${token.slice(0, 6)}…${token.slice(-4)}`;
    this.lastOutcome = { ok: true, reason: 'done', deviceId: 'dev-test', name: '我的手机', tokenMasked, tokenMasks: [tokenMasked], at: Date.now() };
    this.state = null;
  },
  /** 模拟失败终态（reason: 'rejected' | 'expired' | 'reused' | …），tokenMasked 取当前会话。 */
  fail(reason = 'rejected', detail = 'signature verify failed') {
    if (!this.state) return;
    const token = this.state.token;
    const tokenMasked = `${token.slice(0, 6)}…${token.slice(-4)}`;
    this.lastOutcome = { ok: false, reason, detail, name: this.state.name, tokenMasked, tokenMasks: [tokenMasked], at: Date.now() };
    this.state = null;
  },
  /** 模拟 kill switch：批量清空 + 带全部遮罩的批量终态。 */
  abortAll() {
    if (this.state) {
      const token = this.state.token;
      const tokenMasked = `${token.slice(0, 6)}…${token.slice(-4)}`;
      this.lastOutcome = { ok: false, reason: 'aborted', count: 1, tokenMasks: [tokenMasked], at: Date.now() };
    }
    this.state = null;
    return 1;
  }
};

const devicesStub = {
  rows: [],
  list() { return this.rows; },
  revoke: async () => true,
  revokeAll: async () => { this.rows = []; return 0; }
};

const deps = {
  // 宿主轨可用（模拟 webview 页内 fetch 自带 dsh-auth cookie）——令牌过期后的回退路径。
  adapter: { requestRejection: () => undefined, launchToken: () => undefined, webServerPort: () => 0 },
  keys,
  killSwitch: new KillSwitch(dir),
  devices: devicesStub,
  pairing: pairingStub,
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

// ---- ★ 红框回归（2026-10-03 真机事故）：配对完成后不得滞留「等待手机提交…」----
// 事故现场：手机扫码成功、设备已进「已配对设备」表，二维码区红框里仍是「等待手机提交…」。
// 根因是面板**没有终态来源**（配对成功即从 pending 删除，list() 只剩「条目消失」）。
// 这里用真浏览器驱动完整生命周期，钉死三个阶段各自的可见文案。
const pairOutVisible = async () => await evaluate("(function(){var e=document.getElementById('dsh-ra-overlay');if(!e)return null;var n=[...e.querySelectorAll('div')].find(d=>d.textContent.trim()==='等待手机提交…'||d.textContent.trim()==='✓ 配对成功'||d.textContent.trim()==='✗ 未完成'||/^\\d{6}$/.test(d.textContent.trim()));return n?n.textContent.trim():null;})()");
check('① 生成后显示「等待手机提交…」', (await pairOutVisible()) === '等待手机提交…', String(await pairOutVisible()));

// 手机提交公钥 → 出校验码（3 秒内必须自己变，无需手点刷新）
pairingStub.submit();
await new Promise((r) => setTimeout(r, 3500));
check('② 手机提交公钥后自动显示 6 位校验码', /^\d{6}$/.test(String(await pairOutVisible())), String(await pairOutVisible()));

// 手机确认 → 配对成功：设备进表 + 红框翻成成功态（事故点）
devicesStub.rows = [{ deviceId: 'dev-test', name: '我的手机', pairedAt: Date.now(), lastActiveAt: null }];
pairingStub.complete();
await new Promise((r) => setTimeout(r, 3500));
const okText = await pairOutVisible();
check('③ 配对成功后不再滞留「等待手机提交…」', okText !== '等待手机提交…', String(okText));
check('③ 红框明确显示「✓ 配对成功」', String(okText).includes('✓ 配对成功'), String(okText));
const afterOk = await evaluate("document.getElementById('dsh-ra-overlay').innerText");
check('③ 设备已出现在已配对设备表', String(afterOk).includes('dev-test') || String(afterOk).includes('我的手机'));
check('③ 成功提示含设备名', String(afterOk).includes('我的手机'));

// 失败路径：重新生成 → 验签失败 → 必须给出可操作的失败文案，而不是干等
await evaluate("[...document.querySelectorAll('#dsh-ra-overlay button')].find(b=>b.textContent.includes('生成配对二维码')).click()");
await new Promise((r) => setTimeout(r, 1500));
check('④ 重新生成后回到「等待手机提交…」', (await pairOutVisible()) === '等待手机提交…', String(await pairOutVisible()));
pairingStub.fail('rejected');
await new Promise((r) => setTimeout(r, 3000));
const badText = await pairOutVisible();
check('④ 配对失败翻成「✗ 未完成」', String(badText).includes('✗ 未完成'), String(badText));
const badOverlay = String(await evaluate("document.getElementById('dsh-ra-overlay').innerText"));
check('④ 失败原因可见且可操作', badOverlay.includes('验签失败') && badOverlay.includes('重新生成'), badOverlay.split('\n').filter((l) => l.includes('重')).slice(0, 2).join(' / '));

// 归属保护：别的面板/别人扫旧码的结局不得污染本面板
pairingStub.lastOutcome = { ok: true, reason: 'done', deviceId: 'other', name: '别人的手机', tokenMasked: 'someoneelse…0000', tokenMasks: ['someoneelse…0000'], at: Date.now() };
await new Promise((r) => setTimeout(r, 2500));
const foreign = await pairOutVisible();
check('⑤ 他人配对的结局不得污染本面板', String(foreign).includes('✗ 未完成'), String(foreign));

// ---- ★ 真机事故的**极速路径**（用户截图现场）：手机在面板两次轮询之间就完成了配对，
//      面板从未观察到「已出校验码」那个中间态。旧码的 `if (list.length > 0)` 分支
//      一次都没进过，初始文案「等待手机提交…」就永久留在那里 —— 这正是截图里红框的样子。
//      （审计佐证：pair.create 11:33:09 → pair.challenge/success 11:33:21，而旧面板 5 秒一轮。）
await evaluate("[...document.querySelectorAll('#dsh-ra-overlay button')].find(b=>b.textContent.includes('生成配对二维码')).click()");
await new Promise((r) => setTimeout(r, 1000));
check('⑥ 新一轮配对已开始', (await pairOutVisible()) === '等待手机提交…', String(await pairOutVisible()));
pairingStub.submit();
pairingStub.complete(); // 同一 tick：面板绝不会看到中间态
await new Promise((r) => setTimeout(r, 3500));
const fast = await pairOutVisible();
check('⑥ 手机快于轮询完成时不得滞留「等待手机提交…」', fast !== '等待手机提交…', String(fast));
check('⑥ 直接翻成「✓ 配对成功」', String(fast).includes('✓ 配对成功'), String(fast));

// ---- ⑦ kill switch 批量清空：被清掉的会话所属面板也必须认领到终态 ----
await evaluate("[...document.querySelectorAll('#dsh-ra-overlay button')].find(b=>b.textContent.includes('生成配对二维码')).click()");
await new Promise((r) => setTimeout(r, 1000));
check('⑦ 新配对已开始', (await pairOutVisible()) === '等待手机提交…', String(await pairOutVisible()));
pairingStub.abortAll();
await new Promise((r) => setTimeout(r, 3000));
const killed = await pairOutVisible();
check('⑦ kill switch 清空后翻成「✗ 未完成」', String(killed).includes('✗ 未完成'), String(killed));
const killedText = String(await evaluate("document.getElementById('dsh-ra-overlay').innerText"));
check('⑦ 提示指向 kill switch', killedText.includes('kill switch'), killedText.split('\n').filter((l) => l.includes('停用')).slice(0, 1).join(''));

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
