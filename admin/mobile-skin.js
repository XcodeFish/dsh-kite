/**
 * 移动端自适应层（方案 v5，2026-10-02）。
 *
 * 设计纪律（四轮原型返工换来的，勿回退）：
 * - 不发明任何交互。宿主 GUI（dsh-client-ui-layout）在 viewport<1024 时本来就会
 *   自动收侧栏（SIDEBAR_AUTO_COLLAPSE=1024）、中列放不下 400px 时自动藏右栏、
 *   弹层自带 width:min(264px,100vw-24px) 防溢出——这些是宿主自己的代码，本层绝不碰。
 * - 本层只补「元素级缺口」，全部规则使用稳定语义属性或通用可访问性属性：
 *   composer、模型选择器、审批/提问卡、消息操作、右栏、终端/代码、弹窗和设置表单。
 * - 断点只用 @media (max-width:1023.9px)，与宿主 1024 阈值对齐，不自造断点。
 * - 零 JS 行为、零结构改动、零哈希类名选择器（只依赖 data-* 属性与 --dsw/--dsh token）。
 * - 载体：reverse-proxy 的 forwardRequest 在缓冲路径上调用 applyMobileSkin()。
 *   手机 PWA 是唯一流量入口（桌面 LAN 直连宿主不经反代），桌面物理性零影响。
 *   DSH 升级后宿主窄屏模式不变；本层最坏情况=个别选择器不命中而静默失效，绝不半套。
 */

/** 注入版本：写进 marker，便于真机 devtools 一眼确认层是否生效/为哪一版。 */
export const SKIN_VERSION = '5';

/** 幂等标记：页面 HTML 中已含此串则跳过注入。 */
export const SKIN_MARKER = '__DSH_KITE_MOBILE__';

/** 超大 HTML 不注入（shell 文档实际 ~2KB；2MB 是防御性上限）。 */
const MAX_HTML_BYTES = 2 * 1024 * 1024;

/** CSS（保持 ASCII，避免任何 charset 假设下的字节拼接问题）。 */
const SKIN_CSS = [
  '@media (max-width:1023.9px){',
  /* Global geometry: keep every mobile surface inside the visual viewport. */
  ':root{--dsh-chat-user-width:min(calc(100% - 32px),920px);--dsh-mobile-edge:12px;}',
  '#root{box-sizing:border-box;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);}',
  '*,*::before,*::after{box-sizing:border-box;}',
  'input,textarea,select,[contenteditable="true"],[contenteditable=""]{font-size:max(16px,1em);max-width:100%;}',
  'button{touch-action:manipulation;}',
  /* Composer: the host already wraps this row; make both groups shrinkable and usable. */
  '[data-composer-seat]{min-width:0;width:100%;padding-inline:0;padding-bottom:max(8px,env(safe-area-inset-bottom));}',
  '[data-composer-seat] [data-model-compact]{align-items:stretch;row-gap:8px;}',
  '[data-composer-seat] [data-model-compact] [data-composer-model],\n[data-composer-seat] [data-model-compact] [data-model-selector]{min-width:0;max-width:100%;}',
  '[data-composer-seat] [data-model-compact] button{min-width:0;max-width:100%;}',
  '[data-composer-seat] button{min-height:44px;}',
  '[data-composer-seat] [aria-haspopup="menu"]{max-width:min(260px,calc(100vw - 112px));min-width:0;min-height:44px;padding-inline:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  /* ModelSelect portals escape data-composer-seat: constrain both root and model panes. */
  'body > [role="menu"],body > [role="group"][aria-busy="true"],body > [role="group"][aria-busy="false"]{box-sizing:border-box;width:min(420px,calc(100vw - 24px));max-width:calc(100vw - 24px);max-height:min(68dvh,520px);overflow:auto;overscroll-behavior:contain;}',
  'body > [role="menu"] button[role="menuitem"],body > [role="menu"] button[role="menuitemradio"],body > [role="group"] button[role="menuitem"],body > [role="group"] button[role="menuitemradio"]{box-sizing:border-box;width:100%;min-width:0;min-height:44px;max-width:100%;padding-block:8px;touch-action:manipulation;}',
  'body > [role="menu"] [role="searchbox"],body > [role="group"] [role="searchbox"]{box-sizing:border-box;width:100%;min-width:0;min-height:44px;font-size:16px;}',
  'body > [role="menu"] button[role="menuitem"] > *,body > [role="group"] button[role="menuitemradio"] > *{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;}',
  /* Host InputBar row: first group owns the listbox add button, last group owns send. */
  '[data-composer-seat] div:has(> div:first-child > button[aria-haspopup="listbox"]):has(> div:last-child > button){flex-wrap:wrap;min-width:0;column-gap:8px;row-gap:8px;}',
  '[data-composer-seat] div:has(> div:first-child > button[aria-haspopup="listbox"]):has(> div:last-child > button) > :last-child{flex:1 1 0;min-width:0;margin-left:0;}',
  '[data-composer-seat] div:has(> div:first-child > button[aria-haspopup="listbox"]):has(> div:last-child > button) > :last-child > :not(button){flex:1 1 auto;min-width:0;max-width:100%;overflow:hidden;}',
  '[data-composer-seat] div:has(> div:first-child > button[aria-haspopup="listbox"]):has(> div:last-child > button) > :last-child > :not(button) > *{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '[data-composer-seat] div:has(> div:first-child > button[aria-haspopup="listbox"]):has(> div:last-child > button) > :last-child > :not(button) [role="button"]{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;}',
  '[data-composer-seat] div:has(> div:first-child > button[aria-haspopup="listbox"]):has(> div:last-child > button) > :last-child > button:last-child{flex:0 0 44px;width:44px;height:44px;}',
  /* Approval and question cards: bounded scrolling, readable copy, reliable touch targets. */
  '[data-approval-key],[data-question-key]{width:100%;max-width:100%;min-width:0;}',
  '[data-approval-key] [data-approval-scroll],[data-question-key] [data-question-scroll]{max-height:min(42dvh,360px);overflow:auto;overscroll-behavior:contain;}',
  '[data-approval-key] button,[data-question-key] button{min-width:44px;min-height:44px;}',
  '[data-approval-key] [data-approval-scroll] pre,[data-question-key] [data-question-scroll] pre{max-width:100%;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;}',
  '[data-question-key] textarea,[data-question-key] input{width:100%;min-width:0;}',
  '[data-question-key] [role="radiogroup"],[data-question-key] [role="group"]{min-width:0;}',
  /* Message actions: reveal on coarse pointers and enlarge the hit box without enlarging icons. */
  '[data-actions-reveal] > :last-child button{min-width:44px;min-height:44px;}',
  '@media (pointer:coarse){[data-actions-reveal="hover"] > :last-child{opacity:1!important;}}',
  /* Right column, terminal, code and media surfaces. */
  '[data-sidebar-right-session]{min-width:0;max-width:100vw;}',
  '[data-sidebar-right-session] [data-dockkit-pane],[data-sidebar-right-session] [data-dockkit-host="dock"]{min-width:0;max-width:100%;}',
  '[data-terminal],[data-code-block-content]{min-width:0;max-width:100%;overflow:auto;}',
  '[data-terminal] pre,[data-code-block-content] pre{max-width:none;white-space:pre;}',
  '#root pre{overflow-x:auto;}',
  '#root table{display:block;max-width:100%;overflow-x:auto;}',
  'img,video,canvas,svg{max-width:100%;}',
  /* Dialogs, popovers and settings forms: fit narrow screens and keep controls tappable. */
  '[role="dialog"],[aria-modal="true"]{max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);}',
  '[role="dialog"] form,[aria-modal="true"] form{min-width:0;max-width:100%;}',
  '[role="dialog"] input,[role="dialog"] textarea,[role="dialog"] select,[aria-modal="true"] input,[aria-modal="true"] textarea,[aria-modal="true"] select{width:100%;min-width:0;}',
  '[role="dialog"] button,[aria-modal="true"] button{min-height:44px;}',
  '[role="dialog"] [role="tablist"],[aria-modal="true"] [role="tablist"]{max-width:100%;overflow-x:auto;}',
  '[role="dialog"] [role="tablist"]>*{flex:none;}',
  /* Avoid the optional floating kite entry covering the composer when it is enabled. */
  '#dsh-ra-menu-entry{bottom:max(14px,env(safe-area-inset-bottom));}',
  '}',
  '@media (max-width:767.9px){',
  '[data-conversation-region="chat"]{min-width:0;width:100%;}',
  '[data-conversation-scroll]{min-width:0;overflow-x:hidden;}',
  '[data-conversation-region="composer"]{position:sticky;bottom:0;z-index:20;background:var(--dsw-alias-bg-base,var(--dsw-specific-input-major));}',
  '[data-sidebar-right-session] [data-sidebar-right-panel="fullscreen"]{width:100vw!important;max-width:100vw!important;}',
  '#dsh-ra-menu-entry{right:max(10px,env(safe-area-inset-right));}',
  '}',
  '@media (max-width:479.9px){',
  '[data-composer-seat] [data-model-compact]{gap:6px;padding-inline:4px;}',
  '[data-composer-seat] [data-model-compact] > *{flex:1 1 0;min-width:0;}',
  '[data-approval-key] [data-approval-scroll],[data-question-key] [data-question-scroll]{max-height:45dvh;}',
  '[role="dialog"],[aria-modal="true"]{border-radius:12px!important;}',
  '}',
  /* Keep the keyboard viewport honest on Android; iOS ignores the extra directive. */
  ''
].join('\n');

/** 注入块：marker global（真机 devtools 可见）+ 适配样式。 */
function skinPayload() {
  return `<script>window.${SKIN_MARKER}="${SKIN_VERSION}"</script><style id="dsh-kite-mobile">${SKIN_CSS}</style>`;
}

/**
 * 视口 meta 增强（仅修改 viewport meta，模式不匹配则静默跳过）：
 * - viewport-fit=cover：安全区 env() 生效的前提；
 * - interactive-widget=resizes-content：Android Chrome 软键盘弹出时收缩布局视口，
 *   输入区不被键盘遮挡（iOS 忽略未知键，无副作用）。
 */
function patchViewportFit(body) {
  const text = body.toString('latin1');
  if (/interactive-widget\s*=\s*resizes-content/i.test(text)) return body;

  const metaPattern = /<meta\b(?=[^>]*\bname\s*=\s*["']viewport["'])(?=[^>]*\bcontent\s*=)[^>]*>/i;
  const metaMatch = metaPattern.exec(text);
  if (metaMatch) {
    const meta = metaMatch[0];
    const contentMatch = /content\s*=\s*(["'])(.*?)\1/i.exec(meta);
    if (contentMatch) {
      let content = contentMatch[2];
      if (!/viewport-fit\s*=\s*cover/i.test(content)) content += ', viewport-fit=cover';
      content += ', interactive-widget=resizes-content';
      const patchedMeta = meta.replace(contentMatch[0], contentMatch[0].replace(contentMatch[2], content));
      return Buffer.from(text.slice(0, metaMatch.index) + patchedMeta + text.slice(metaMatch.index + meta.length), 'latin1');
    }
  }

  const variants = [
    'content="width=device-width, initial-scale=1"',
    'content="width=device-width,initial-scale=1"'
  ];
  for (const v of variants) {
    const idx = text.indexOf(v);
    if (idx !== -1) {
      const patched = v.replace('initial-scale=1', 'initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content');
      return Buffer.concat([body.slice(0, idx), Buffer.from(patched, 'utf8'), body.slice(idx + v.length)]);
    }
  }
  return body;
}

/**
 * 对一次缓冲响应应用移动适配层。
 * @param {{method:string, path:string, status:number, headers:object, body:Buffer}} input
 * @returns {{headers:object, body:Buffer}|null} null = 不适用（调用方原样透传）。
 *
 * 响应头契约（对应 relay-client #sendHttpResponse 原样转发 + 中继 writeHead 透传的链路）：
 * - content-length 必须重写为注入后长度，否则手机浏览器按旧长度收流 → 整页挂起；
 * - etag/last-modified 必须剥离：宿主对「未注入」内容签的 304 会让手机用回未注入缓存页，
 *   注入表现为随机失效；
 * - cache-control 置 no-store：shell 文档不缓存，注入内容随插件版本即时生效。
 * 之后 relay-client 的 gzip 分支会基于新 body 重算 content-length，顺序正确互不冲突。
 */
export function applyMobileSkin({ method, path, status, headers, body }) {
  if (!body || body.length === 0) return null;
  if (String(method || 'GET').toUpperCase() !== 'GET') return null;
  if (status !== 200) return null;
  const ct = String(headers?.['content-type'] ?? '');
  if (!/text\/html/i.test(ct)) return null;
  if (headers?.['content-disposition']) return null; // 附件下载绝不改写
  if (body.length > MAX_HTML_BYTES) return null;
  if (body.includes(SKIN_MARKER)) return null; // 幂等：已注入过

  // 只处理文档：路径末段无扩展名（或显式 .html）——资源类误判双保险
  const clean = String(path || '/').split('?')[0];
  const last = clean.slice(clean.lastIndexOf('/') + 1);
  if (last.includes('.') && !/\.html?$/i.test(last)) return null;

  const lower = body.toString('latin1').toLowerCase();
  const headClose = lower.lastIndexOf('</head>');
  if (headClose === -1) return null; // 没有 </head> 的非文档 HTML，不动

  let patched = patchViewportFit(body);
  const inject = Buffer.from(skinPayload(), 'utf8');
  // 重算 </head> 位置（viewport 补丁不改变前缀长度，但严谨起见重找）
  const idx = patched.toString('latin1').toLowerCase().lastIndexOf('</head>');
  const out = Buffer.concat([patched.slice(0, idx), inject, patched.slice(idx)]);

  const outHeaders = { ...headers };
  outHeaders['content-length'] = String(out.length);
  delete outHeaders.etag;
  delete outHeaders['last-modified'];
  outHeaders['cache-control'] = 'no-store';

  return { headers: outHeaders, body: out };
}
