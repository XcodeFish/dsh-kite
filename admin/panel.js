/**
 * 本地管理面板（方案 §6.4）+ 手机配对页（PWA 模式的设备入口）。
 *
 * 两个面严格分开：
 * - 管理面 `/kite`：经 webServer.register 挂载，走 ctx.connection.requestRejection
 *   复用宿主认证（仅回环可达；浏览器需带 dsh-auth cookie，即从「在浏览器打开」入口进入）。
 * - 配对页 `/kite/pair*`：不出现在 webServer —— 它经中继以 carrier 帧到达，
 *   由 relay-client 的保留路径直接调 handlePairPage()，无需宿主认证（设备凭据就是目的）。
 *
 * Kill switch：持久化 killswitch.json；enabled=true 时 connector 不再重连（P0 手段）。
 */
import { randomBytes } from 'node:crypto';
import { qrMatrix } from './qr.js';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIA_HEADER } from '../proxy/reverse-proxy.js';

const KILL_FILE = 'killswitch.json';
const OVERRIDE_FILE = 'relay-override.json';
const ADMIN_BODY_LIMIT = 64 * 1024;
/** 浏览器端 QR 模块源码（面板页 `import('/kite/qr.js')` 用）。 */
const QR_SOURCE = await fsp.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'qr.js'), 'utf8');

/**
 * 原子写 JSON（tmp + rename + chmod 0600）—— 对齐 identity/device-store.js 的写法。
 * ★ 为什么不能直接 writeFile：① 进程在写一半时被杀 → 文件半截 → 下次读取回退默认值
 *   （kill switch 静默失效 / 中继令牌丢失）；② 已存在文件的 `{mode}` 不会被收紧，
 *   含明文中继令牌的 relay-override.json 可能停在 0644。
 */
async function atomicWriteJson(file, obj) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 });
  await fsp.rename(tmp, file);
  try {
    await fsp.chmod(file, 0o600);
  } catch {
    /* Windows 忽略 */
  }
}

export class KillSwitch {
  #file;
  #enabled = false;
  constructor(dataDir) {
    this.#file = path.join(dataDir, KILL_FILE);
  }
  async load() {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.#file, 'utf8'));
      this.#enabled = parsed?.enabled === true;
    } catch {
      this.#enabled = false;
    }
    return this.#enabled;
  }
  get enabled() {
    return this.#enabled;
  }
  async set(enabled) {
    this.#enabled = enabled === true;
    await atomicWriteJson(this.#file, { enabled: this.#enabled, changedAt: Date.now() });
    return this.#enabled;
  }
}

/**
 * 面板写入的中继覆盖配置（HANDOVER §5.2 数据契约）。与 KillSwitch 同构：
 * 缺失或损坏 = **无覆盖**（静默回退 patch/默认，不引入新容错模型）；mode 0600。
 * 删除文件即回退 —— 不做版本历史/回滚 UI 的理由见 §5.8。
 */
export class RelayOverrideStore {
  #file;
  #data = null;
  constructor(dataDir) {
    this.#file = path.join(dataDir, OVERRIDE_FILE);
  }
  async load() {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.#file, 'utf8'));
      this.#data = parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      this.#data = null;
    }
    return this.#data;
  }
  get() {
    return this.#data;
  }
  async set(data) {
    this.#data = {
      relayUrl: String(data?.relayUrl ?? ''),
      relayPublicUrl: String(data?.relayPublicUrl ?? ''),
      relayToken: String(data?.relayToken ?? ''),
      changedAt: Date.now()
    };
    await atomicWriteJson(this.#file, this.#data);
    return this.#data;
  }
  async clear() {
    this.#data = null;
    try {
      await fsp.unlink(this.#file);
    } catch {
      /* 不存在即目标状态 */
    }
  }
}

/** 读请求体（上限内）。 */
function readBody(req, limit = ADMIN_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 服务端渲染 QR 为 SVG（内联注入的客户端不再依赖 canvas / 动态 import）。 */
function renderQrSvg(text, margin = 4) {
  const qr = qrMatrix(text);
  const dim = qr.size + margin * 2;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="配对二维码">`];
  parts.push(`<rect width="${dim}" height="${dim}" fill="#ffffff"/>`);
  parts.push('<path fill="#0e1116" d="');
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (qr.get(x, y)) parts.push(`M${x + margin} ${y + margin}h1v1h-1z`);
    }
  }
  parts.push('"/></svg>');
  return parts.join('');
}

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj, null, 1);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(extraHeaders ?? {}) });
  res.end(body);
}

/**
 * 创建管理面 handler。deps:
 * { adapter, killSwitch, devices, pairing, audit, relayStatus(), kickDevice(), probe(), relayPublicUrl(), fingerprint }
 */
/**
 * 管理面认证 = **来源隔离（⓪）+ 三轨**（真机结论：桌面 webview 顶层导航不带宿主 cookie；iframe src 带——
 * 但为摆脱这个不可控变量，入口 URL 内嵌插件自签引导令牌，兑换后全走自有 cookie）：
 *   ⓪ 来源隔离：连接器转发来的请求（带 x-kite-via-connector）**一律 403** —— 见下。
 *   ① kite_token（插件签名引导令牌，10 分钟有效，仅授权管理面）→ 兑换 kite-admin cookie
 *   ② kite-admin cookie（连接器密钥签名，12h）→ 直接放行
 *   ③ 宿主 dsh-auth 会话（从「在浏览器打开」进入的场景）→ 放行
 *
 * ★ 关于 ⓪：连接器**必然**以已认证的 loopback 身份访问宿主，所以「回环 = 已认证 = 可信」
 *   在代理场景下失效 —— 若没有 ⓪，任何能经代理触达 `/kite/*` 的请求都会走轨 ③ 进管理面。
 *   标记值由连接器在白名单重建之后无条件写入（进程级随机），手机既猜不到也拦不住。
 */
function adminAuth(req, url, deps) {
  if (deps.viaValue && req.headers?.[VIA_HEADER] === deps.viaValue) {
    // 审计：这不是普通 401，是「有人试图从远程代理面进管理面」——必须留痕。
    try {
      deps.audit?.append?.({ kind: 'admin.proxy-denied', detail: { path: String(url?.pathname ?? '').slice(0, 120) } });
    } catch {
      /* 审计失败不影响拒绝 */
    }
    return { ok: false, status: 403, body: '管理面不接受经远程代理到达的请求。请在桌面端本机打开。' };
  }
  // 轨 1：引导令牌（内嵌在注入的入口 URL）。★ 令牌无效/过期不终止判定 ——
  // 它只是「首次兑换」的加速器，不是唯一通路（父页面 fetch 自带宿主 cookie，
  // 轨 3 天然可用；把它写成唯一通路曾导致令牌 10 分钟过期后面板永久 403）。
  let tokenInvalid = false;
  const token = url.searchParams.get('kite_token');
  if (typeof token === 'string' && token.length > 0) {
    const payload = deps.keys?.verifyPayload?.(token);
    if (payload && payload.kind === 'kite-bootstrap' && typeof payload.exp === 'number' && payload.exp > Date.now()) {
      return { ok: true, mint: 'bootstrap' };
    }
    // ★ P2：不再接受宿主 launchToken —— 宿主主令牌不该同时是插件管理面凭据
    //   （它能开宿主的任意面，泄漏半径远大于本插件；入口令牌已足够）。
    tokenInvalid = true; // 继续往下试其它轨
  }

  // 轨 2：已兑换的 kite-admin cookie（12h，兑换后不再依赖令牌）。
  const admin = cookieValueOf(req.headers.cookie, 'kite-admin');
  if (admin) {
    const payload = deps.keys?.verifyPayload?.(admin);
    if (payload && payload.kind === 'kite-admin' && typeof payload.exp === 'number' && payload.exp > Date.now()) return { ok: true };
  }

  // 轨 3：宿主会话（webview 页内 fetch 自带 dsh-auth cookie）。
  const rejection = deps.adapter.requestRejection(req);
  // 通过宿主轨也下发长效 cookie（后续更稳），但**不跳转**（URL 里没有令牌要剥离）。
  if (rejection === undefined) return { ok: true, mint: 'session' };

  const detail = [
    tokenInvalid ? '引导令牌无效/过期' : (token ? '令牌被拒' : '未带令牌'),
    admin ? 'kite-admin cookie 无效/过期' : '无 kite-admin cookie',
    `宿主轨 rejection=${rejection}`
  ].join('；');
  return {
    ok: false,
    status: rejection,
    body: `远程访问面板认证失败（${detail}）。\n\n`
      + '处置：① 刷新 DSH 页面（F5）后重试；② 或用真实浏览器访问 http://127.0.0.1:<web端口>/kite（从 DSH 设置「在浏览器打开」进入）。'
  };
}

function cookieValueOf(headerValue, name) {
  if (typeof headerValue !== 'string') return undefined;
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1 || segment.slice(0, at).trim() !== name) continue;
    return segment.slice(at + 1).trim();
  }
  return undefined;
}

const ADMIN_COOKIE = 'kite-admin';
const ADMIN_COOKIE_MAX_AGE = 12 * 3600;
/** 引导令牌有效期：10 分钟（与注释/README 一致；面板每次打开都由 /api/entry 实时签发，
 *  注入 HTML 里已不再携带令牌，见 admin/menu-entry.js）。 */
const BOOTSTRAP_TTL_MS = 10 * 60 * 1000;

export function createAdminHandler(deps) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    /**
     * ★ 来源隔离必须在**所有**管理面入口之前（含免认证的 /api/entry）。
     *   /api/entry 是唯一免认证端点（避免「要令牌才能拿令牌」死锁），因此它曾是
     *   整条管理面上唯一没被来源标记保护的地方 —— 一旦代理侧策略被绕过，
     *   攻击者能白拿 10 分钟引导令牌。这里把它也纳入 ⓪ 轨。
     *   本机入口不受影响：标记头只由连接器在白名单重建后写入。
     */
    if (deps.viaValue && req.headers?.[VIA_HEADER] === deps.viaValue) {
      try {
        deps.audit?.append?.({ kind: 'admin.proxy-denied', detail: { path: String(url?.pathname ?? '').slice(0, 120) } });
      } catch {
        /* 审计失败不影响拒绝 */
      }
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('管理面不接受经远程代理到达的请求。请在桌面端本机打开。');
      return;
    }
    // ★ /api/entry 必须免认证：它是「获取引导令牌」的端点，若要求认证则形成死锁
    //   （客户端要令牌 → 调 entry → 需要令牌 → 401）。真机事故 2026-09-30。
    //   安全性：它只返回插件自签的短期令牌，且仅回环可达（宿主路由门 + Host 栅栏 +
    //   上面的来源隔离）。
    if (url.pathname.replace(/\/+$/, '') === '/kite/api/entry' && req.method === 'GET') {
      let entryUrl = '/kite';
      try {
        const now = Date.now();
        entryUrl = `/kite?kite_token=${encodeURIComponent(deps.keys.signPayload({ kind: 'kite-bootstrap', iat: now, exp: now + BOOTSTRAP_TTL_MS }))}`;
      } catch { /* keys 不可用 → 退回宿主轨 */ }
      sendJson(res, 200, { url: entryUrl });
      return;
    }
    const verdict = adminAuth(req, url, deps);
    if (!verdict.ok) {
      res.writeHead(verdict.status ?? 401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(verdict.body ?? (verdict.status === 401 ? '需要 DSH 浏览器会话：请从 DSH 设置的「在浏览器打开」入口进入后再访问本页。' : 'forbidden'));
      return;
    }
    const extraHeaders = {};
    if (verdict.mint && deps.keys) {
      const now = Date.now();
      const cookie = `${ADMIN_COOKIE}=${deps.keys.signPayload({ kind: 'kite-admin', iat: now, exp: now + ADMIN_COOKIE_MAX_AGE * 1000 })}; Path=/kite; Max-Age=${ADMIN_COOKIE_MAX_AGE}; HttpOnly; SameSite=Strict`;
      extraHeaders['set-cookie'] = cookie;
      // 入口页兑换后 303 到干净 URL：令牌不留在地址栏/历史（对齐宿主 authorizeIndex 做法）。
      // 仅 bootstrap 轨需要剥离；宿主轨 URL 无令牌，直接 200。
      if (verdict.mint === 'bootstrap' && req.method === 'GET' && url.pathname.replace(/\/+$/, '') === '/kite') {
        const clean = new URL(url);
        clean.searchParams.delete('kite_token');
        res.writeHead(303, { location: `${clean.pathname}${clean.search}`, 'set-cookie': cookie, 'cache-control': 'no-store' });
        res.end();
        return;
      }
    }
    const route = url.pathname.replace(/\/+$/, '') || '/kite';
    try {
      if (route === '/kite' && req.method === 'GET') {
        // ★ P2：管理面 HTML 走 CSP（nonce 只放行我们自己的两处内联脚本）+ no-referrer。
        //   前提是已移除内联 onclick 属性（行内事件处理器不受 nonce 保护，会直接被 CSP 打死）。
        const nonce = newNonce();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...htmlSecurityHeaders(nonce), ...extraHeaders });
        res.end(renderAdminHtml(nonce));
        return;
      }
      if (route === '/kite/qr.js' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(QR_SOURCE);
        return;
      }
      if (route === '/kite/api/status' && req.method === 'GET') {
        sendJson(res, 200, {
          relay: deps.relayStatus(),
          relayOwned: deps.relayOwned !== false,
          killswitch: { enabled: deps.killSwitch.enabled },
          fingerprint: deps.fingerprint,
          relayPublicUrl: deps.relayPublicUrl() ?? null,
          relayConfig: deps.relayConfigStatus ? deps.relayConfigStatus() : null,
          devices: deps.devices.list(),
          pairings: deps.pairing.list(),
          // ★ 配对终态（成功/失败/过期/中止）：list() 只含**进行中**会话，成功那一刻会话
          //   就被删掉了 —— 面板仅凭 list() 无法区分「成功」与「失败」，只能永久停在
          //   「等待手机提交…」（真机事故 2026-10-03）。旧实例无 last() → null，面板回退旧行为。
          pairingLast: typeof deps.pairing.last === 'function' ? deps.pairing.last() : null,
          audit: deps.audit.tail(30)
        });
        return;
      }
      // ---- 中继接入配置面（HANDOVER §5；全部在 adminAuth 之后，设备侧另有 /kite 前缀 deny 兜底）----
      if (route === '/kite/api/relay' && req.method === 'GET') {
        if (typeof deps.relayConfigStatus !== 'function') {
          sendJson(res, 503, { error: '中继配置面未就绪（旧实例？重启后可用）' });
          return;
        }
        sendJson(res, 200, deps.relayConfigStatus());
        return;
      }
      if (route === '/kite/api/relay/probe' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        sendJson(res, 200, await deps.probeRelayConfig(body));
        return;
      }
      if (route === '/kite/api/relay' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const result = await deps.applyRelayOverride(body);
        sendJson(res, result.ok ? 200 : (result.stage === 'killed' ? 409 : 400), result);
        return;
      }
      if (route === '/kite/api/pairings' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const { token, expiresAt } = deps.pairing.begin({ name: body.name });
        const base = deps.relayPublicUrl();
        // ★ P1-3：配对链接带上**连接器公钥**（公钥，放 URL 安全）。手机用它 + 自己本地
        //   生成的设备公钥独立算出 6 位校验码 —— 中继若偷换设备公钥，两端数字必然不一致。
        //   这条链接由桌面端面板生成、经扫码/复制进入手机，是校验码唯一可信的输入来源。
        const connectorPub = deps.keys?.ed25519?.publicB64u ?? '';
        const pairingUrl = base
          ? `${base}/kite/pair?token=${encodeURIComponent(token)}&name=${encodeURIComponent(body.name || 'phone')}&c=${encodeURIComponent(deps.fingerprint)}${connectorPub ? `&pk=${encodeURIComponent(connectorPub)}` : ''}`
          : null;
        let qrSvg = null;
        if (pairingUrl) {
          try {
            qrSvg = renderQrSvg(pairingUrl);
          } catch (error) {
            // 生成失败不阻塞：面板可复制链接手工打开。
            qrSvg = null;
            void error;
          }
        }
        sendJson(res, 200, {
          token,
          // 与 /status 的 pairingLast.tokenMasked 同一格式：面板据此把终态认领到本次配对。
          tokenMasked: `${token.slice(0, 6)}…${token.slice(-4)}`,
          pairingUrl,
          expiresAt,
          qrSvg,
          note: base ? null : '未配置 relayUrl，无法生成手机可打开的配对链接'
        });
        return;
      }
      const revokeMatch = /^\/kite\/api\/devices\/([^/]+)$/.exec(route);
      if (revokeMatch && req.method === 'DELETE') {
        const deviceId = decodeURIComponent(revokeMatch[1]);
        const ok = await deps.devices.revoke(deviceId);
        if (ok) deps.kickDevice(deviceId);
        deps.audit.append({ kind: ok ? 'device.revoked' : 'device.revoke-miss', deviceId });
        sendJson(res, ok ? 200 : 404, { ok });
        return;
      }
      if (route === '/kite/api/devices/revoke-all' && req.method === 'POST') {
        const n = await deps.devices.revokeAll();
        deps.pairing.abortAll();
        deps.audit.append({ kind: 'device.revoke-all', detail: { count: n } });
        sendJson(res, 200, { ok: true, revoked: n });
        return;
      }
      if (route === '/kite/api/killswitch' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const enabled = await deps.killSwitch.set(body.enabled === true);
        // ★ P1-1：真断开 / 真恢复（dispose 在途隧道；恢复走重建 + 锁检查）。
        await deps.onKillSwitch?.(enabled);
        deps.audit.append({ kind: enabled ? 'killswitch.on' : 'killswitch.off' });
        sendJson(res, 200, { enabled });
        return;
      }
      if (route === '/kite/api/audit' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 100);
        sendJson(res, 200, { entries: await deps.audit.recent(limit) });
        return;
      }
      if (route === '/kite/api/probe' && (req.method === 'GET' || req.method === 'POST')) {
        sendJson(res, 200, await deps.probe());
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
  };
}

/**
 * 配对页（经中继到达）。返回 {status, headers, body, setCookie?}。
 * deps: { pairing, fingerprint, tickets, devices, audit }
 */
export function createPairPageHandler(deps) {
  return async function handlePairPage({ method, path, headers, body }) {
    const url = new URL(path, 'https://pair.invalid');
    if (method !== 'GET' && method !== 'POST') {
      return json(405, { error: 'method not allowed' });
    }
    if (method === 'GET') {
      // ★ /kite/welcome：配对完成后的落地页。它的职责是「确保设备凭据生效」
      //   然后跳转 DSH 首页 —— 避免「配对成功但首屏无凭据」的窗口期（真机事故）。
      if (url.pathname === '/kite/welcome') {
        const c = url.searchParams.get('c') ?? '';
        const next = c ? `/?c=${encodeURIComponent(c)}` : '/';
        return {
          status: 302,
          headers: { location: next, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' },
          body: Buffer.from('')
        };
      }
      const token = url.searchParams.get('token');
      if (!token) return html(400, '<h1>缺少配对令牌</h1><p>请使用桌面端「远程访问」面板生成的完整链接。</p>');
      return html(200, renderPairHtml());
    }
    // POST /kite/pair/{begin|complete}
    const action = url.pathname.split('/').pop();
    let payload;
    try {
      payload = JSON.parse(Buffer.from(body ?? Buffer.alloc(0)).toString('utf8') || '{}');
    } catch {
      return json(400, { ok: false, error: '请求体不是 JSON' });
    }
    if (action === 'begin') {
      const { challenge, code, deviceId } = await deps.pairing.submit({
        token: payload.token,
        pubKey: payload.pubKey,
        name: payload.name
      });
      return json(200, { ok: true, challenge, code, deviceId, connectorId: deps.fingerprint });
    }
    if (action === 'complete') {
      const result = await deps.pairing.complete({ challenge: payload.challenge, sig: payload.sig, ts: payload.ts });
      // ★ Pair-Proof：result.claim（配对凭证原件）由 handlePairPage 的调用方
      //   （relay-client HTTP 保留路径）读取并转发 device-claim 给中继。
      //   不进 HTTP 响应体 —— 验签材料无需暴露给手机端页面。
      return {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': result.setCookie },
        claim: result.claim ?? null,
        body: Buffer.from(JSON.stringify({ ok: true, deviceId: result.deviceId, code: result.code }), 'utf8')
      };
    }
    return json(404, { ok: false, error: 'unknown pair action' });
  };
}

/** 每响应一个 nonce（CSP 只放行带它的内联脚本）。模板里用占位符，渲染时替换。 */
const NONCE_PLACEHOLDER = '__KITE_NONCE__';
function newNonce() {
  return randomBytes(16).toString('base64');
}
function htmlSecurityHeaders(nonce) {
  return {
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' 'self'`,
      "style-src 'unsafe-inline'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ].join('; ')
  };
}

function json(status, obj) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    body: Buffer.from(JSON.stringify(obj), 'utf8')
  };
}
function html(status, inner) {
  const nonce = newNonce();
  const doc = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH Kite · 配对</title><style>${PAIR_CSS}</style></head><body><main>${inner}</main></body></html>`.replaceAll(NONCE_PLACEHOLDER, nonce);
  return {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...htmlSecurityHeaders(nonce) },
    body: Buffer.from(doc, 'utf8')
  };
}

const PAIR_CSS = `
:root{color-scheme:dark}
body{font-family:system-ui,-apple-system,sans-serif;background:#0e1116;color:#e6e8eb;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:26rem;padding:2rem;width:100%;box-sizing:border-box}
h1{font-size:1.3rem;margin:0 0 1rem}
p{line-height:1.7;color:#9aa4b2;margin:.6rem 0}
code{background:#1c2128;padding:.2em .45em;border-radius:.35em;font-size:.92em;word-break:break-all}
button{width:100%;padding:.9rem;border:0;border-radius:.7rem;background:#2f81f7;color:#fff;font-size:1rem;font-weight:600;margin-top:1.2rem}
button:disabled{background:#29313c;color:#6b7684}
.code{font-size:2.4rem;letter-spacing:.35em;text-align:center;font-weight:700;margin:1rem 0;color:#7ee2b8}
.state{text-align:center;margin-top:1rem}
.hidden{display:none}
`;

function renderPairHtml() {
  return `
<h1>DSH Kite · 设备配对</h1>
<div id="step-error" class="hidden"><p style="color:#f85149">配对失败：<span id="err"></span></p></div>
<div id="step-doing"><p>正在生成本机设备密钥并提交…</p></div>
<div id="step-code" class="hidden">
  <p>请核对两边显示的校验码一致：</p>
  <div class="code" id="code"></div>
  <p class="note" id="code-src" style="font-size:.82rem"></p>
  <p>桌面端面板（「远程访问」）应显示同样的 6 位数字。不一致请不要继续。</p>
  <button id="confirm">确认并进入 DSH</button>
</div>
<div id="step-done" class="hidden"><p>配对完成，正在进入 DSH…</p>
<p id="stuck" class="hidden" style="color:#f85149;line-height:1.7">超过 20 秒仍未进入：中继没能把请求送到桌面端（常见于同一中继挂着多个 DSH 实例，或连接器掉线未被清理）。请回桌面端「远程访问」面板确认连接器在线后，<a id="retry-enter" style="color:#58a6ff;cursor:pointer;text-decoration:underline">点此重试</a>。</p></div>
<script nonce="${NONCE_PLACEHOLDER}">
(async () => {
  const $ = (id) => document.getElementById(id);
  const fail = (msg) => { $('step-doing').classList.add('hidden'); $('step-error').classList.remove('hidden'); $('err').textContent = msg; };
  try {
    const params = new URLSearchParams(location.search);
    const token = params.get('token');
    const name = params.get('name') || 'phone';
    const connectorId = params.get('c') || '';
    if (!token) return fail('缺少配对令牌');
    if (!crypto?.subtle) return fail('浏览器不支持 WebCrypto（需要 HTTPS + 现代浏览器）');
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign']);
    const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
    const pubB64 = btoa(String.fromCharCode(...new Uint8Array(spki).slice(-32))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
    const begin = await fetch('/kite/pair/begin' + (connectorId ? '?c=' + encodeURIComponent(connectorId) : ''), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, pubKey: pubB64, name }) });
    const beginData = await begin.json();
    if (!beginData.ok) return fail(beginData.error || 'begin failed');
    const ts = Date.now();
    const msg = new TextEncoder().encode(beginData.challenge + beginData.connectorId + String(ts));
    const sig = await crypto.subtle.sign('Ed25519', pair.privateKey, msg);
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\\+/g,'-').replace(/\\//g,'_');
    const done = await fetch('/kite/pair/complete' + (connectorId ? '?c=' + encodeURIComponent(connectorId) : ''), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challenge: beginData.challenge, sig: sigB64, ts }) });
    const doneData = await done.json();
    if (!doneData.ok) return fail(doneData.error || 'complete failed');
    $('step-doing').classList.add('hidden');
    $('step-code').classList.remove('hidden');
    // ★ P1-3：校验码**在本机计算**，不再直接显示服务端回传值。
    //   算法必须与 identity/pairing.js 的 verificationCode 逐字节一致：
    //   sha256(devicePubB64 + '|' + connectorPubB64) 取前 3 字节大端 % 1000000，左补零。
    //   连接器公钥来自配对链接的 pk 参数（桌面端面板生成 → 扫码/复制进入手机，
    //   中继改不了这段来源）；若中继偷换设备公钥，两端数字必然不一致。
    //   边界（README 已如实写明）：能改写本页 JS 的中继仍可绕过 —— 那需要 sealed 客户端或局域网直连。
    const connectorPub = params.get('pk');
    let shown = null;
    if (connectorPub) {
      try {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pubB64 + '|' + connectorPub)));
        const n = ((digest[0] << 16) | (digest[1] << 8) | digest[2]) % 1000000;
        shown = String(n).padStart(6, '0');
        $('code-src').textContent = '（本机计算：设备公钥 ‖ 连接器公钥，未经服务端转手）';
      } catch (e) { shown = null; }
    }
    if (shown === null) {
      shown = doneData.code || '------';
      $('code-src').textContent = '⚠ 未取得连接器公钥，此码来自服务端，无法防中继替换';
    }
    $('code').textContent = shown;
    $('confirm').onclick = () => {
      $('step-code').classList.add('hidden');
      $('step-done').classList.remove('hidden');
      // ★ 跳转时带上 c=<connectorId>：确保中继能路由（配对页的 cookie 可能因各种
      //   浏览器策略未生效；c 参数是确定性凭据）。真机事故 2026-09-30。
      var q = connectorId ? ('?c=' + encodeURIComponent(connectorId)) : '';
      location.href = 'about:blank';  // 立即离开配对页
      location.href = '/kite/welcome' + q;
      // ★ 跳转看门狗：正常跳转会销毁本页、定时器随之失效；若 20s 后本页仍活着，
      //   说明 welcome/首页请求在中继侧被黑洞化（多连接器兜底投错/僵尸连接器）。
      //   与其无限转圈，给出可操作指引。真机事故 2026-10-01。
      setTimeout(() => { $('stuck').classList.remove('hidden'); }, 20000);
      $('retry-enter').onclick = () => { location.href = '/kite/welcome' + q; };
    };
  } catch (e) { fail(String(e && e.message || e)); }
})();
</script>`;
}

function renderAdminHtml(nonce) {
  return ADMIN_HTML.replaceAll(NONCE_PLACEHOLDER, nonce ?? '');
}

const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Kite · 手机远程</title><style>
:root{color-scheme:dark}
body{font-family:system-ui,-apple-system,sans-serif;background:#0e1116;color:#e6e8eb;margin:0;padding:2rem 1rem}
.wrap{max-width:52rem;margin:0 auto}
h1{font-size:1.4rem}h2{font-size:1.05rem;margin-top:2rem;color:#9aa4b2;text-transform:none}
.card{background:#151a21;border:1px solid #232b36;border-radius:.8rem;padding:1rem 1.2rem;margin:.8rem 0}
.row{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
button{padding:.5rem .9rem;border:1px solid #2f81f7;border-radius:.5rem;background:transparent;color:#58a6ff;cursor:pointer;font-size:.9rem}
button.danger{border-color:#f85149;color:#f85149}
button.primary{background:#2f81f7;color:#fff}
input{background:#0e1116;border:1px solid #2d3744;border-radius:.5rem;color:#e6e8eb;padding:.5rem .7rem;flex:1;min-width:10rem}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th,td{text-align:left;padding:.45rem .5rem;border-bottom:1px solid #1d242e}
.mono{font-family:ui-monospace,monospace;font-size:.82rem;word-break:break-all}
.badge{padding:.15rem .55rem;border-radius:99px;font-size:.78rem}
.ok{background:#123527;color:#7ee2b8}.bad{background:#3a1518;color:#f85149}.idle{background:#2a303a;color:#9aa4b2}
pre{background:#0b0e12;border-radius:.6rem;padding:.8rem;font-size:.78rem;max-height:18rem;overflow:auto}
.note{color:#8b949e;font-size:.85rem;line-height:1.6}
.hidden{display:none}
</style></head><body><div class="wrap">
<div class="row" style="justify-content:space-between;align-items:center"><h1 style="margin:0">DSH Kite · 手机远程</h1><button id="btn-home">← 返回 DSH</button></div>
<div class="card"><div class="row"><span id="relay-badge" class="badge idle">未知</span><span class="mono" id="relay-url"></span></div>
<div class="note" id="relay-note" style="margin-top:.6rem"></div></div>

<h2>中继接入（可视化配置）</h2>
<div class="card"><div class="row"><span id="rc-badge" class="badge idle">未知</span><span class="mono" id="rc-effective">（未配置）</span></div>
<div class="row" style="margin-top:.6rem"><input id="rc-url" placeholder="wss://中继地址:端口" style="flex:2;min-width:14rem"><input id="rc-token" type="password" placeholder="令牌（留空 = 沿用当前）" style="flex:1;min-width:10rem"><input id="rc-public" placeholder="公网入口（默认派生 https）" style="flex:1;min-width:12rem"></div>
<div class="row" style="margin-top:.6rem"><button id="rc-probe">测试连接</button><button id="rc-apply" class="primary">应用并重连</button><span class="note" id="rc-msg"></span></div>
<div id="rc-confirm" class="hidden" style="margin-top:.6rem;border:1px solid #d29922;border-radius:.5rem;padding:.6rem .8rem;background:#241a05">
<div class="note" id="rc-summary"></div><div class="note" id="rc-rewarn" style="color:#f85149;display:none;margin-top:.3rem">⚠ 改公网入口 = 所有已配对手机都要重新扫码（设备私钥按 origin 隔离，新 origin 里没有它）。</div>
<div class="row" style="margin-top:.5rem"><button id="rc-yes" class="primary">确认写入并重连</button><button id="rc-no">取消</button></div></div>
<div class="note" id="rc-current" style="margin-top:.6rem"></div></div>

<h2>添加设备（扫码连接）</h2>
<div class="card"><div class="row"><input id="dev-name" placeholder="设备名（如 我的手机）"><button class="primary" id="btn-pair">生成配对二维码</button></div>
<div id="pair-out" class="hidden" style="margin-top:1rem">
<div class="row" style="align-items:flex-start;gap:1.2rem">
<div style="flex:0 0 auto"><canvas id="pair-qr" width="200" height="200" style="border:6px solid #fff;border-radius:8px;background:#fff;display:block"></canvas>
<div class="note" id="pair-countdown" style="text-align:center;margin-top:.4rem"></div></div>
<div style="flex:1;min-width:14rem">
<div class="note">用手机相机或浏览器扫码打开（一次性，用后即焚）：</div>
<div class="row" style="margin-top:.4rem"><input id="pair-url" readonly><button id="btn-copy">复制</button></div>
<div class="note" style="margin-top:.8rem">配对时<b>两边会各自显示 6 位校验码</b>，一致才点确认（防中间人）。手机提交后这里会显示桌面侧校验码：</div>
<div id="pair-code" class="mono" style="font-size:1.6rem;color:#7ee2b8;min-height:2rem"></div>
<div id="pair-pending" class="mono note"></div>
</div></div>
</div></div>

<h2>已配对设备</h2>
<div class="card"><table><thead><tr><th>名称</th><th>设备 ID</th><th>配对时间</th><th>最近活跃</th><th></th></tr></thead><tbody id="dev-rows"><tr><td colspan="5" class="note">加载中…</td></tr></tbody></table>
<div class="row" style="margin-top:1rem"><button class="danger" id="btn-revoke-all">撤销全部设备</button><button class="danger" id="btn-kill">紧急停用（kill switch）</button></div>
<div class="note">紧急停用会立即断开中继并停止重连；恢复需再次点击。</div></div>

<h2>宿主 API 探针（方案 §8.5）</h2>
<div class="card"><div class="row"><button id="btn-probe">运行探针</button><span id="probe-state" class="note"></span></div><pre id="probe-out" class="hidden"></pre></div>

<h2>审计（最近事件）</h2>
<div class="card"><pre id="audit"></pre></div>

<div class="note" style="margin-top:2rem">前置条件：DSH NEXT 设置需开启「浏览器访问」（Browser Access），否则中继回环请求会被桌面 browser-access 门 403。本机未开任何入站端口。</div>
</div>
<script nonce="${NONCE_PLACEHOLDER}">
const $ = (id) => document.getElementById(id);
async function api(path, opts) { const r = await fetch(path, opts); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }
function badge(state) {
  const el = $('relay-badge');
  const map = { open: ['ok', '已连接'], connecting: ['idle', '连接中'], retrying: ['idle', '重试中'], standby: ['idle', '待机（未配置中继）'], killed: ['bad', '已紧急停用'] };
  const [cls, label] = map[state] || ['bad', state];
  el.className = 'badge ' + cls; el.textContent = label;
}
async function refresh() {
  rcLoad();
  try {
    const s = await api('/kite/api/status');
    if (s.relayOwned === false && s.relay.state !== 'open') { $('relay-badge').className = 'badge idle'; $('relay-badge').textContent = '由另一 DSH 实例接管'; }
    else badge(s.relay.state);
    $('relay-url').textContent = s.relay.relayUrl || '';
    var note = s.relayPublicUrl ? ('手机入口 ' + s.relayPublicUrl) : '未配置手机可达入口（relayPublicUrl）';
    if (s.killswitch.enabled) note = 'kill switch 生效中。';
    else if (s.relay.metrics.lastError) note += ' · 最近错误：' + s.relay.metrics.lastError;
    note += ' · 指纹 ' + (s.fingerprint || '').slice(0, 16);
    $('relay-note').textContent = note;
    $('dev-rows').innerHTML = s.devices.length ? s.devices.map((d) => '<tr><td>' + esc(d.name) + '</td><td class="mono">' + esc(d.deviceId) + '</td><td>' + new Date(d.pairedAt).toLocaleString() + '</td><td>' + (d.lastActiveAt ? new Date(d.lastActiveAt).toLocaleString() : '-') + '</td><td><button class="danger" data-revoke="' + esc(d.deviceId) + '">撤销</button></td></tr>').join('') : '<tr><td colspan="5" class="note">暂无设备</td></tr>';
    // 待配对：倒计时 + 桌面侧校验码（手机提交公钥后出现，用于两端比对）
    const pendingList = s.pairings || [];
    // ★ 配对终态渲染（真机事故 2026-10-03 定稿版）：改由服务端给确定结局（s.pairingLast），
    //   不再用「条目消失 + 设备表 2 分钟内有新条目」的启发式 —— 那个启发式有三个洞：
    //   ① 它只在**已经出现过校验码**时才武装（先提交后失败的路径看不见）；
    //   ② 失败/过期/验签不过的条目消失后一律不显示，面板就停在「等待手机提交…」；
    //   ③ 别的连接器/别的面板刚配对成功的设备也会落进 2 分钟窗口，可能误报「✓ 配对成功」。
    const codedNow = pendingList.find((p) => p.code);
    const last = s.pairingLast;
    if (pendingList.length > 0 && !$('pair-out').classList.contains('hidden')) {
      const left = Math.max(0, Math.round((pendingList[0].expiresAt - Date.now()) / 1000));
      $('pair-countdown').textContent = left > 0 ? left + 's 后过期' : '已过期，请重新生成';
      $('pair-code').innerHTML = codedNow
        ? ('桌面侧校验码 ' + esc(codedNow.code))
        : '等待手机提交…';
      $('pair-pending').textContent = '';
    } else if (!$('pair-out').classList.contains('hidden')) {
      // 会话已终结：等终态落地（或它早已就位）。
      // ★ 归属保护：只有终态带上了**本次面板**的 tokenMasked 才认领 —— 别人的面板 /
      //   有人拿旧二维码在扫，都不能把结论写到这里。终态就位后清掉 watch（幂等）。
      const mine = last && window.__pairWatch && Array.isArray(last.tokenMasks)
        && last.tokenMasks.indexOf(window.__pairWatch.tokenMasked) !== -1;
      if (mine) {
        window.__pairWatch = null;
        if (last.ok) {
          $('pair-code').innerHTML = '<span style="color:#4ade80;font-weight:600">✓ 配对成功</span> · 设「' + esc(last.name || 'device') + '」已加入';
          $('pair-pending').textContent = '';
          setTimeout(() => { try { $('pair-out').classList.add('hidden'); } catch { /* 已被刷新 */ } }, 3000);
        } else {
          const text = {
            expired: '二维码已过期（120 秒未完成），请重新生成。',
            rejected: '挑战验签失败' + (last.detail ? '：' + esc(last.detail) : '') + '，请重新生成二维码再扫。',
            reused: '该二维码已被使用过（一次性），请重新生成。',
            'invalid-pubkey': '手机提交的公钥格式非法，请重新生成二维码再扫。',
            aborted: '配对已被中止（紧急停用 kill switch），请先解除停用。'
          }[last.reason] || '配对未完成，请重新生成二维码。';
          $('pair-code').innerHTML = '<span style="color:#f85149;font-weight:600">✗ 未完成</span>';
          $('pair-pending').textContent = text;
        }
      }
    }
    $('audit').textContent = (s.audit || []).map((e) => new Date(e.ts).toLocaleTimeString() + ' ' + JSON.stringify(e)).join('\\n') || '（暂无事件）';
  } catch (e) { $('relay-note').textContent = '状态加载失败：' + e.message; }
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// ---- 中继接入（可视化配置）：令牌永不回显；探针走临时 connectorId；写入 0600 ----
let rcData = null;
const RC_HINT = {
  format: '地址格式不对：只接受 wss:// 开头。',
  dns: '域名解析失败：核对地址拼写，或服务器已下线。',
  tls: 'TLS/证书异常：证书过期或不被信任（裸 IP 证书 7 天短期档，Caddy 会自动续）。',
  timeout: '超时：服务未运行或云防火墙未放行端口（丢包表现为持续超时，秒回拒绝才是服务没起）。',
  server: '中继异常：查看 /healthz 与日志；确认部署的是新版中继（/metrics 含 wire_frame_limit 行）。',
  auth: '令牌被拒：与中继 RELAY_TOKENS 不一致，或当前未配置令牌。'
};
function rcSetMsg(text, bad) { const el = $('rc-msg'); el.textContent = text; el.style.color = bad ? '#f85149' : ''; }
function rcInputUrl() { return $('rc-url').value.trim() || (rcData && rcData.effective.relayUrl) || ''; }
function rcRender() {
  if (!rcData) return;
  const map = { open: ['ok', '已连接'], connecting: ['idle', '连接中'], retrying: ['idle', '重试中'], standby: ['idle', '待机'], killed: ['bad', '已紧急停用'] };
  const [cls, label] = map[rcData.relay && rcData.relay.state] || ['bad', '未知'];
  $('rc-badge').className = 'badge ' + cls; $('rc-badge').textContent = label;
  $('rc-effective').textContent = (rcData.effective.relayUrl || '（未配置）') + (rcData.relay && rcData.relay.lastError ? ' · ' + rcData.relay.lastError : '');
  const srcMap = { env: 'env（优先级最高，面板改动不生效）', override: '面板覆盖', patch: 'cordis.patch.yml', derived: '自动派生', default: '默认' };
  const s = rcData.sources || {};
  const tokenText = rcData.effective.relayTokenSet ? '已设置（指纹 ' + rcData.effective.relayTokenFp + '）' : '未设置';
  $('rc-current').textContent = '生效来源：地址=' + (srcMap[s.relayUrl] || s.relayUrl) + ' · 令牌=' + (srcMap[s.relayToken] || s.relayToken) + ' · 入口=' + (srcMap[s.relayPublicUrl] || s.relayPublicUrl)
    + '　|　令牌 ' + tokenText + '　|　覆盖文件 ' + (rcData.override && rcData.override.exists ? '存在（' + new Date(rcData.override.changedAt).toLocaleString() + ' 写入）' : '无');
  const killed = rcData.killswitch && rcData.killswitch.enabled;
  $('rc-apply').disabled = Boolean(killed);
  if (killed) rcSetMsg('kill switch 生效中：解除后才可应用新配置', true);
}
function rcLoad() {
  return api('/kite/api/relay').then((d) => { rcData = d; rcRender(); }).catch((e) => rcSetMsg('配置读取失败：' + e.message, true));
}
$('rc-url').oninput = () => {
  const v = $('rc-url').value.trim();
  // ws:// 仅回环放行（本机联调）；远程明文入口在输入阶段就拦下。
  if (/^ws:\\/\\//i.test(v) && !/^ws:\\/\\/(127\\.0\\.0\\.1|localhost|\\[::1\\])/i.test(v)) rcSetMsg('✗ 远程地址只允许 wss://（本机联调可用 ws://127.0.0.1）', true);
  else rcSetMsg('', false);
};
$('rc-probe').onclick = () => {
  rcSetMsg('探测中…（临时 connectorId，不影响在线连接）', false);
  $('rc-probe').disabled = true;
  api('/kite/api/relay/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relayUrl: rcInputUrl(), relayToken: $('rc-token').value.trim(), relayPublicUrl: $('rc-public').value.trim() }) })
    .then((r) => { if (r.ok) rcSetMsg('✓ 探针通过（' + (r.latencyMs || 0) + 'ms）· 可以「应用并重连」', false); else rcSetMsg('✗ ' + (RC_HINT[r.code] || '') + (r.reason ? '（' + r.reason + '）' : ''), true); })
    .catch((e) => rcSetMsg('探针失败：' + e.message, true))
    .then(() => { $('rc-probe').disabled = false; });
};
$('rc-apply').onclick = () => {
  const url = rcInputUrl().trim();
  if (!/^wss:\\/\\//i.test(url) && !/^ws:\\/\\/(127\\.0\\.0\\.1|localhost|\\[::1\\])(:\\d+)?(\\/|$)/i.test(url)) { rcSetMsg('✗ 远程地址只允许 wss://（本机联调可用 ws://127.0.0.1）', true); return; }
  const pub = $('rc-public').value.trim() || url.replace(/^wss/i, 'https');
  const changed = rcData && rcData.effective.relayPublicUrl && rcData.effective.relayPublicUrl !== pub;
  $('rc-summary').textContent = '将写入并生效：地址 ' + url + ' ｜ 公网入口 ' + pub + ' ｜ 令牌 ' + ($('rc-token').value.trim() ? '更新为新值' : '沿用当前');
  $('rc-rewarn').style.display = changed ? 'block' : 'none';
  $('rc-confirm').classList.remove('hidden');
  $('rc-apply').disabled = true;
};
$('rc-no').onclick = () => { $('rc-confirm').classList.add('hidden'); $('rc-apply').disabled = false; };
$('rc-yes').onclick = () => {
  $('rc-yes').disabled = true;
  rcSetMsg('写入并重连中…', false);
  api('/kite/api/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relayUrl: rcInputUrl(), relayToken: $('rc-token').value.trim(), relayPublicUrl: $('rc-public').value.trim() }) })
    .then((r) => {
      if (r.ok) {
        rcSetMsg('✓ 已写入 relay-override.json 并重连（来源：面板覆盖；删该文件即回退）', false);
        $('rc-token').value = '';
        $('rc-confirm').classList.add('hidden');
        $('rc-apply').disabled = false;
        refresh();
      } else {
        const prefix = r.stage === 'killed' ? '被拒绝' : (r.stage === 'probe' ? '探针未通过' : (r.stage === 'write' ? '写入失败' : '校验未通过'));
        rcSetMsg('✗ ' + prefix + '：' + (r.code ? (RC_HINT[r.code] || '') + ' ' : '') + (r.reason || ''), true);
        if (r.stage !== 'validate') { $('rc-confirm').classList.add('hidden'); $('rc-apply').disabled = false; }
      }
    })
    .catch((e) => rcSetMsg('请求失败：' + e.message, true))
    .then(() => { $('rc-yes').disabled = false; });
};
// ★ P2：弃用内联 onclick 拼接（行内事件处理器不受 CSP nonce 保护，会被直接打死；
//   字符串拼接 onclick 也是 XSS 放大器）—— 改为 data 属性 + 事件委托。
async function revokeDevice(id) { await api('/kite/api/devices/' + encodeURIComponent(id), { method: 'DELETE' }); refresh(); }
$('dev-rows').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-revoke]');
  if (btn) revokeDevice(btn.getAttribute('data-revoke'));
});
$('btn-home').onclick = () => { location.href = '/'; };
$('btn-pair').onclick = async () => {
  const name = $('dev-name').value.trim() || 'phone';
  const d = await api('/kite/api/pairings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  $('pair-out').classList.remove('hidden');
  $('pair-code').textContent = '等待手机提交…';
  $('pair-pending').textContent = '';
  // ★ 认领本次配对的终态：只有 tokenMasked 对得上，成功/失败结论才落到这块面板
  //   （别的面板或别人拿旧二维码扫出的结局不得污染这里）。
  window.__pairWatch = d.tokenMasked ? { tokenMasked: d.tokenMasked } : null;
  $('pair-url').value = d.pairingUrl || '';
  if (d.pairingUrl) {
    try {
      const { qrMatrix } = await import('/kite/qr.js');
      const qr = qrMatrix(d.pairingUrl);
      const canvas = $('pair-qr');
      const quiet = 4;
      const scale = Math.floor(200 / (qr.size + quiet * 2)) || 1;
      const dim = (qr.size + quiet * 2) * scale;
      canvas.width = dim; canvas.height = dim;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, dim, dim);
      ctx.fillStyle = '#0e1116';
      for (let y = 0; y < qr.size; y += 1) {
        for (let x = 0; x < qr.size; x += 1) {
          if (qr.get(x, y)) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
        }
      }
      $('pair-countdown').textContent = Math.round((d.expiresAt - Date.now()) / 1000) + 's 后过期';
    } catch (e) {
      $('pair-countdown').textContent = '二维码生成失败（可复制链接）：' + e.message;
    }
  } else {
    $('pair-url').value = '（未配置中继）token=' + d.token;
    $('pair-countdown').textContent = d.note || '';
  }
};
$('btn-copy').onclick = () => { navigator.clipboard?.writeText($('pair-url').value); $('btn-copy').textContent = '已复制'; setTimeout(() => ($('btn-copy').textContent = '复制'), 1200); };
$('btn-revoke-all').onclick = async () => { if (!confirm('撤销全部设备并断开其连接？')) return; await api('/kite/api/devices/revoke-all', { method: 'POST' }); refresh(); };
$('btn-kill').onclick = async () => { if (!confirm('紧急停用远程访问？（立即断开中继并停止重连）')) return; await api('/kite/api/killswitch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) }); refresh(); };
$('btn-probe').onclick = async () => {
  $('probe-state').textContent = '运行中…';
  try { const d = await api('/kite/api/probe', { method: 'POST' }); $('probe-out').classList.remove('hidden'); $('probe-out').textContent = JSON.stringify(d, null, 2); $('probe-state').textContent = d.overall === 'ok' ? '全部通过' : '存在失败项'; }
  catch (e) { $('probe-state').textContent = '失败：' + e.message; }
};
refresh(); setInterval(refresh, 5000);
</script></body></html>`;
