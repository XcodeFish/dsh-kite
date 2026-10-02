/**
 * 入口模式端到端验证（真机 Chrome + CDP，模拟 DSH 主页面）。
 *
 * 覆盖三件事：
 *   ① floating（默认）—— 悬浮按钮在、侧栏槽位也在（'both' 语义）
 *   ② sidebar 模式    —— 悬浮按钮**不建**，但面板引擎仍注入：
 *                        window.__DSH_KITE_OPEN__ 必须存在，且点它真能开出浮层
 *                        （这正是「入口与面板解耦」要防的回归：只砍按钮、把面板一起砍掉）
 *   ③ 侧栏槽位组件    —— 在真实的 .footerActions 容器里注册后，按钮出现在
 *                        「上下文洞察」下方、Settings 上方（order 20 vs 10）
 *
 * 用法：node test/entry-modes.e2e.mjs
 */
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createAdminHandler, KillSwitch } from '../admin/panel.js';
import { loadConnectorKeys } from '../identity/keys.js';
import { CLIENT_SOURCE } from '../admin/menu-entry.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = 9335;

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ra-entry-'));
const keys = await loadConnectorKeys(dir);
const deps = {
  adapter: { requestRejection: () => undefined, launchToken: () => undefined, webServerPort: () => 0 },
  keys,
  killSwitch: new KillSwitch(dir),
  devices: { list: () => [], revoke: async () => true, revokeAll: async () => 0 },
  pairing: { list: () => [], begin: () => ({ token: 'tok', expiresAt: Date.now() + 120000 }), abortAll: () => 0 },
  audit: { tail: () => [], append: () => {}, recent: async () => [] },
  fingerprint: 'fp',
  relayStatus: () => ({ state: 'open', relayUrl: 'wss://relay.example', metrics: { lastError: null } }),
  kickDevice: () => {},
  relayPublicUrl: () => 'https://relay.example',
  relayOwned: true,
  probe: async () => ({ overall: 'ok', checks: [] })
};
const adminHandler = createAdminHandler(deps);
const boot = keys.signPayload({ kind: 'kite-bootstrap', iat: Date.now(), exp: Date.now() + 600000 });

/** 侧栏半包源码：模拟宿主按 dsh.client 加载它（真实运行时由 client-modules 注入 <script>）。 */
const SIDEBAR_SOURCE = await fsp.readFile(new URL('../admin/sidebar-entry.js', import.meta.url), 'utf8');

/**
 * 模拟主页面。
 * `mode` 决定注入的 __DSH_KITE_ENTRY__（与 index.js 的注入行同形）。
 * 侧栏 DOM 模仿 client-ui-sidebar 的真实结构：.footerActions（sidebar.footer.action 的
 * 宿主）+ .settingsArea（Settings 行），以及一个 order 10 的「上下文洞察」条目作参照。
 */
function page(mode) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>DSH</title></head><body>
<div id="app-shell">DSH 主界面</div>
<div class="sidebar-foot">
  <div class="footerActions" data-slot="sidebar.footer.action"></div>
  <div class="settingsArea" data-slot="sidebar.settings"><button id="settings-row">设置</button></div>
</div>
<script>
  window.__DSH_KITE_AUTH__ = { url: ${JSON.stringify(`/kite?kite_token=${boot}`)} };
  window.__DSH_KITE_ENTRY__ = ${JSON.stringify(mode)};
</script>
<script>${CLIENT_SOURCE}<\/script>
<script>
  // 最小 __ModuleLoader__：捕获侧栏半包注册并立即物化（等价于宿主的 arrive + import）。
  window.__KITE_SIDEBAR__ = null;
  window.__ModuleLoader__ = {
    mode: 'live',
    load(reg) {
      window.__KITE_SIDEBAR__ = reg;
      var react = {
        createElement: function (type, props) {
          var children = Array.prototype.slice.call(arguments, 2).filter(function (c) { return c !== null && c !== undefined; });
          return { type: type, props: props || {}, children: children };
        }
      };
      var face = reg.factory(function (spec) { if (spec === 'react') return react; throw new Error('unexpected require ' + spec); });
      var entries = [];
      var ctx = {
        slots: {
          inject: function (key, cb) { if (key === 'sidebar.footer.action') entries.push(cb()); },
          register: function (opts, component) { return { opts: opts, component: component }; }
        }
      };
      face.apply(ctx);
      var entry = entries[0];
      if (!entry) return;
      // 参照条目：模拟 dsh-context「上下文洞察」（order 10）
      var anchor = document.createElement('button');
      anchor.id = 'context-overview';
      anchor.textContent = '上下文洞察';
      var host = document.querySelector('.footerActions');
      // 按 order 升序插入（list 槽的渲染语义）
      var rendered = entry.component({ wide: true });
      var node = document.createElement('button');
      node.id = rendered.props.className.indexOf('rail') === -1 ? 'kite-sidebar-entry' : 'kite-sidebar-entry-rail';
      node.textContent = (rendered.children[1] && rendered.children[1].children[0]) || '';
      node.setAttribute('data-order', String(entry.opts.order));
      node.addEventListener('click', rendered.props.onClick);
      var ctxBtn = anchor;
      // order 10 的条目先入；kite order 20 后入 → 落在其下方
      host.appendChild(ctxBtn);
      host.appendChild(node);
    }
  };
<\/script>
<script>${SIDEBAR_SOURCE}<\/script>
</body></html>`;
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/kite')) return adminHandler(req, res);
  const mode = req.url.includes('sidebar-only')
    ? { floating: false, sidebar: true }
    : { floating: true, sidebar: true };
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page(mode));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
console.log(`模拟 DSH 主页: http://127.0.0.1:${port}/`);

const chrome = spawn(CHROME, [
  // ★ --no-sandbox 必需：在受限文件沙箱下，Chrome 无法写 Crashpad 目录（Operation not permitted），
  //   进程随即 SIGTRAP，页面级 CDP socket 以 1006 断开 → Runtime.enable 永远等不到回执。
  //   少了它，本测试会「静默挂起」或误连到上一次遗留的浏览器实例。
  '--no-sandbox',
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + path.join(os.tmpdir(), 'ra-chrome-entry-' + Date.now()), '--window-size=1440,900', 'about:blank'
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
const pageErrors = [];
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

const results = [];
const check = (name, ok, extra) => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? ' → ' + extra : ''}`); };
const goto = async (suffix) => {
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/${suffix}` });
  await new Promise((r) => setTimeout(r, 1200));
};

// ---- 模式一：both（默认）----
await goto('');
check('both：悬浮按钮已建', (await evaluate("!!document.getElementById('dsh-ra-menu-entry')")) === true);
check('both：面板引擎全局存在', (await evaluate("typeof window.__DSH_KITE_OPEN__ === 'function'")) === true);
check('both：侧栏条目已注册', (await evaluate("!!document.getElementById('kite-sidebar-entry')")) === true);
check('both：侧栏条目在上下文洞察之后（order 20 > 10）', (await evaluate(
  "Array.from(document.querySelector('.footerActions').children).map(n=>n.id).join(',')"
)) === 'context-overview,kite-sidebar-entry', undefined);
check('both：侧栏条目在 Settings 之上', (await evaluate(
  "document.querySelector('.footerActions').compareDocumentPosition(document.querySelector('.settingsArea')) & Node.DOCUMENT_POSITION_FOLLOWING ? true : false"
)) === true);
check('both：侧栏文案正确', (await evaluate("document.getElementById('kite-sidebar-entry').textContent")) === '手机远程');

// 点侧栏条目 → 浮层应打开（证明全局调用链通）
await evaluate("document.getElementById('kite-sidebar-entry').click()");
await new Promise((r) => setTimeout(r, 1200));
check('both：点侧栏条目可打开浮层', (await evaluate("!!document.getElementById('dsh-ra-overlay')")) === true);
await evaluate("document.getElementById('dsh-ra-overlay').remove()");

// ---- 模式二：sidebar-only ----
await goto('sidebar-only');
check('sidebar：悬浮按钮**不**建', (await evaluate("!!document.getElementById('dsh-ra-menu-entry')")) === false);
check('sidebar：面板引擎仍注入（关键回归点）', (await evaluate("typeof window.__DSH_KITE_OPEN__ === 'function'")) === true);
check('sidebar：侧栏条目仍在', (await evaluate("!!document.getElementById('kite-sidebar-entry')")) === true);

// 全局直接开面板 → 必须成功（否则 sidebar 模式是个死按钮）
await evaluate("window.__DSH_KITE_OPEN__()");
await new Promise((r) => setTimeout(r, 1200));
check('sidebar：全局可打开浮层', (await evaluate("!!document.getElementById('dsh-ra-overlay')")) === true);
const overlayText = await evaluate("document.getElementById('dsh-ra-overlay').innerText");
check('sidebar：浮层内容完整（标题）', String(overlayText).includes('手机远程访问'), undefined);
check('sidebar：浮层可拿到状态（已连接）', String(overlayText).includes('已连接'), undefined);
await evaluate("document.getElementById('dsh-ra-overlay').remove()");

// 点侧栏条目（无悬浮按钮可回退）→ 仍应打开
await evaluate("document.getElementById('kite-sidebar-entry').click()");
await new Promise((r) => setTimeout(r, 1200));
check('sidebar：点侧栏条目可打开浮层（不依赖悬浮按钮）', (await evaluate("!!document.getElementById('dsh-ra-overlay')")) === true);

check('页面无 JS 错误', pageErrors.length === 0, pageErrors.length ? pageErrors.join(' | ') : undefined);

const shot = await send('Page.captureScreenshot', {});
if (shot.result?.data) await fsp.writeFile('/tmp/ra-entry-modes.png', Buffer.from(shot.result.data, 'base64'));
console.log(`截图: /tmp/ra-entry-modes.png`);

ws.close();
chrome.kill();
server.close();
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length === 0 ? 0 : 1);
