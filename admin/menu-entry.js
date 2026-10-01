/**
 * Web GUI 入口注入：把「手机远程」按钮 + **原生 DOM 面板客户端**内联进 DSH 主页面。
 *
 * 历史教训（2026-09-30 真机，勿再回退到容器方案）：
 *   iframe src    → 时好时坏（同源判定随文档来源漂移）
 *   iframe srcdoc → 空白（opaque origin → 内部请求跨站 403）
 *   window.open   → 桌面壳静默拦截
 *   顶层导航       → 401 白页（webview 顶层导航不带宿主 cookie）
 *   ★ 父页面 fetch → 始终 200（每次探测都通过）
 * 结论：面板不再放进任何容器，直接渲染进主页面 DOM，数据全走父上下文 fetch。
 * 只依赖一条已被反复证明可用的通道。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_SOURCE = await fsp.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'panel-client.js'), 'utf8');

/** 注入行：global(入口URL，含 kite-bootstrap 令牌) + script(内联面板客户端)。 */
export function menuEntryRows({ authedUrl } = {}) {
  return [
    {
      kind: 'global',
      name: '__DSH_KITE_AUTH__',
      value: { url: typeof authedUrl === 'string' && authedUrl ? authedUrl : '/kite' }
    },
    {
      kind: 'script',
      placement: 'body',
      text: CLIENT_SOURCE
    }
  ];
}

export { CLIENT_SOURCE };
