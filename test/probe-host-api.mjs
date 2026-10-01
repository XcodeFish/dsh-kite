/**
 * 宿主 API 探针（方案 §8.5）——离线自检 + 在宿主内的运行说明。
 *
 * 三个待钉死的假设（写功能代码前必须验证）：
 *   A1 ctx.webServer 在 desktop profile 下可用（前缀路由可注册、可访问）；
 *   A2 ctx.connection.authenticatedUrl() 能换到 dsh-auth cookie；
 *   A3 重建请求（Host=127.0.0.1:port + cookie）能过 isTrustedApiRequest（/api 不 403）。
 *
 * A1–A3 都要在宿主进程内才能验证（ctx 与 loopback cookie 都不出机）。 therefore：
 * 本插件的探针实现在 admin 面板的 `/kite/api/probe`（index.js runProbe），
 * 安装并重启 DSH 后按以下步骤运行：
 *
 *   1. DSH NEXT 设置 → 开启「浏览器访问」（Browser Access）——否则一切非 Electron
 *      渲染器的请求（含探针自身）都会被桌面 browser-access 门 403；
 *   2. 从 DSH 设置的「在浏览器打开」入口进入 Web GUI（拿到 dsh-auth cookie）；
 *   3. 访问 http://127.0.0.1:<web端口>/kite，点「运行探针」；
 *   4. 期望输出 overall:"ok"（三项 passed）。任何 failed → 回到方案 §3 重新选型。
 *
 * 本脚本做离线能做的部分：模块加载自检 + 宿主包关键契约的静态断言
 * （WebServer.register 签名 / BrowserAuth 303 契约 / NextWebServer 浏览访问门），
 * 用于在 DSH 升级后快速发现 API 漂移（方案风险 R-05）。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const APP = '/Applications/DSH NEXT.app/Contents/Resources/app';

function check(name, fn) {
  try {
    const detail = fn();
    return { name, status: 'passed', detail };
  } catch (error) {
    return { name, status: 'failed', detail: error.message };
  }
}

const results = [
  check('modules.load', () => {
    // 动态加载全部功能模块（语法/依赖错误在此暴露）。
    return import('../index.js').then(() => 'index.js + 全部子模块可加载');
  }),
  check('host.webserver.register', () => {
    const src = readFileSync(path.join(APP, 'node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js'), 'utf8');
    if (!src.includes('register(route)')) throw new Error('register(route) not found');
    if (!src.includes('registerUpgrade(route)')) throw new Error('registerUpgrade(route) not found');
    if (!src.includes("kind: 'prefix'") && !src.includes('route.kind === "exact"')) throw new Error('kind dispatch missing');
    return 'register/registerUpgrade 契约在位';
  }),
  check('host.browserAuth.303', () => {
    const src = readFileSync(path.join(APP, 'node_modules/@deepseek-ai/dsh-client-connection/lib/index.js'), 'utf8');
    if (!src.includes('authenticatedUrl(baseUrl)')) throw new Error('authenticatedUrl missing');
    if (!src.includes('writeHead(303')) throw new Error('303 exchange missing');
    if (!src.includes('dsh-auth-')) throw new Error('cookie prefix missing');
    return 'authenticatedUrl + 303 + dsh-auth-* 契约在位';
  }),
  check('host.desktop.browser-access-gate', () => {
    const src = readFileSync(path.join(APP, 'lib/webserver.js'), 'utf8');
    if (!src.includes('Browser access is disabled')) throw new Error('gate message missing');
    if (!src.includes('this.permits(request)')) throw new Error('route wrapping missing');
    return 'NextWebServer 全路由 browser-access 门在位（前置条件：开启浏览器访问）';
  }),
  check('host.trusted-api-fence', () => {
    const src = readFileSync(path.join(APP, 'node_modules/@deepseek-ai/dsh-client-connection/lib/index.js'), 'utf8');
    if (!src.includes('isTrustedApiRequest')) throw new Error('fence missing');
    if (!src.includes('isLoopbackHostname')) throw new Error('loopback branch missing');
    return 'loopback Host 分支在位（重建请求的理论依据）';
  })
];

const settled = await Promise.all(results);
let failed = 0;
for (const r of settled) {
  if (r.status === 'failed') failed += 1;
  console.log(`[${r.status === 'passed' ? 'PASS' : 'FAIL'}] ${r.name}: ${r.detail}`);
}
if (!existsSync(APP)) {
  console.log('[WARN] 未找到 DSH NEXT 应用包；宿主静态断言不可用（离线环境正常）。');
}
console.log(failed === 0
  ? '\n离线自检全部通过。A1–A3 请按文件头说明在宿主内运行 /kite/api/probe。'
  : `\n${failed} 项失败：宿主 API 可能已漂移（R-05），先修 host-adapter.js 再继续。`);
process.exitCode = failed === 0 ? 0 : 1;
