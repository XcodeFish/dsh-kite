/**
 * 反向代理（ADR-002，方案 §8.3(b)）：重建请求，不是透传。
 *
 * 只复制白名单头（cookie 注入 + content-type），其余一切（Origin / Sec-Fetch-* /
 * X-Forwarded-* / x-dsh-desktop-renderer / 手机带来的 cookie）一律丢弃 ——
 * 转发的 Host 恒为 127.0.0.1:<port>，isTrustedApiRequest 走 loopback 分支直接通过，
 * 无需改 trustedHosts；同时消灭一整类 header smuggling。
 *
 * 契约测试断言：发往 loopback 的头集合 ⊆ 白名单（防回归）。
 * 响应头同样走白名单回给远端；Set-Cookie 一律剥离（设备 cookie 只由配对路径签发）。
 */
import { canonicalizeTarget } from '../policy/methods.js';

const REQUEST_HEADER_WHITELIST = new Set(['content-type', 'content-disposition']);
const RESPONSE_HEADER_WHITELIST = [
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
  'location',
  'accept-ranges',
  'content-range',
  'access-control-allow-origin',
  'x-request-id',
  // ★ 设备凭据必须下发到手机浏览器：剥离它会导致「配对成功但后续请求无法路由」
  //   （真机事故 2026-09-30：配对页下的 ra-device cookie 被吞，点「进入 DSH」后无凭据）。
  'set-cookie'
];
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024; // PWA 资产 + 页面上限；超过回 502（可读）

/**
 * ★ P0-4 来源标记头：连接器转发时无条件写入（值 = 进程级随机，见 index.js）。
 * 管理面（admin/panel.js 的 adminAuth）见到它就 403 —— 把「回环 = 已认证 = 可信」
 * 这条在代理场景下失效的假设重新拆开：经代理到达的请求永远进不了管理面。
 */
export const VIA_HEADER = 'x-kite-via-connector';

/** 组装发往 loopback 的头（白名单唯一出口；契约测试直接测这个函数）。
 *  ★ P0-4：`x-kite-via-connector` 在**白名单过滤之后**无条件写入 —— 手机带来的同名头
 *  在循环里被丢弃（不在白名单里），数据流向决定它无法伪造，管理面据此拒绝经代理到达的请求。 */
export function rebuildRequestHeaders(logicalHeaders, cookie, viaValue) {
  const headers = { cookie };
  if (typeof viaValue === 'string' && viaValue) headers[VIA_HEADER] = viaValue;
  for (const [name, value] of Object.entries(logicalHeaders ?? {})) {
    const lower = String(name).toLowerCase();
    if (!REQUEST_HEADER_WHITELIST.has(lower)) continue;
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) continue;
    headers[lower] = value;
  }
  return headers;
}

/** 组装回给远端的响应头（白名单；剥离 set-cookie / content-encoding / 跳数头）。 */
export function filterResponseHeaders(rawHeaders) {
  const out = {};
  for (const [name, value] of Object.entries(rawHeaders ?? {})) {
    const lower = String(name).toLowerCase();
    if (!RESPONSE_HEADER_WHITELIST.includes(lower)) continue;
    // ★ set-cookie 只放行**我方设备凭据**（ra-device）；宿主的 dsh-auth-* 等一律剥离，
    //   既保证配对后手机有凭据可路由，又绝不把宿主会话 cookie 泄露给远端。
    if (lower === 'set-cookie') {
      const list = (Array.isArray(value) ? value : [value])
        .filter((v) => typeof v === 'string' && /^ra-device=/.test(v.trim()));
      if (list.length > 0) out[lower] = list.length === 1 ? list[0] : list;
      continue;
    }
    if (typeof value !== 'string') continue;
    out[lower] = value;
  }
  return out;
}

/**
 * 单次 HTTP 转发。
 * deps: { credential: LoopbackCredential, policy: Policy, audit, logger }
 * logical: { deviceId, method, path, headers, body(Buffer|undefined), isDeviceValid:boolean }
 * 返回 { status, headers, body:Buffer, ViaPolicyDeny?:string }。
 */
export async function forwardRequest(deps, logical) {
  const { credential, policy, audit, logger, viaValue } = deps;
  const method = String(logical.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'].includes(method)) {
    return respond(405, { 'content-type': 'application/json' }, json({ error: 'proxy/method-not-allowed', message: `不允许的方法 ${method}` }));
  }
  // ★ P0-1：规范化一次，之后判定/审计/出站全部用这一个结果（禁止再解析原始串）。
  const target = canonicalizeTarget(logical.path);
  if (!target) {
    return respond(400, { 'content-type': 'application/json' }, json({ error: 'proxy/bad-path', message: '非法请求路径' }));
  }

  // ① 设备票据必须有效（authn 先于 authz：未配对设备不应获得策略判定信息）。
  if (!logical.isDeviceValid) {
    // 审计口径：只记 pathname（query 里可能有会话标识 / 配对令牌）。
    audit?.({ kind: 'proxy.pair-required', deviceId: logical.deviceId, method, path: target.pathname, status: 401 });
    return respond(401, { 'content-type': 'text/html; charset=utf-8' }, pairRequiredPage());
  }

  // ② 策略判定（含 session/create 重写）—— 判定看的就是将要发出的那串。
  let body = logical.body;
  const verdict = policy.decide({ method, path: target.key, body });
  if (verdict.action === 'deny') {
    audit?.({ kind: 'policy.denied', deviceId: logical.deviceId, method, path: target.pathname, status: verdict.status, reason: verdict.reason });
    return respond(verdict.status, { 'content-type': 'application/json' }, json({ error: 'proxy/policy-denied', message: verdict.reason }));
  }
  if (verdict.action === 'rewrite') body = verdict.body;

  // ③ 重建请求转发 loopback（401 → 重新换凭据再试一次）。
  let attempt = 0;
  for (;;) {
    const { base, cookie } = await credential.acquire();
    // ★ P0-2：绝不再 `new URL(target, base)` —— 那会重新引入 authority 切换与点段折叠。
    //   pathname setter 只跑 path 解析、不碰 host/port，origin 不变式是结构性 SSRF 防线：
    //   即便 P0-1 未来被改坏，出站目标也无法离开受信 loopback origin。
    const origin = new URL(base);
    const url = new URL(origin.origin);
    url.pathname = target.pathname;
    url.search = target.search;
    if (url.origin !== origin.origin) {
      logger?.warn?.(`[kite] origin invariant violated: ${origin.origin} → ${url.origin}`);
      return respond(500, { 'content-type': 'application/json' }, json({ error: 'proxy/origin-violation', message: '出站目标被改写（内部不变式）' }));
    }
    const timeoutSignal = AbortSignal.timeout(115_000); // 稍高于中继看门狗，确保错误来自中继的可读提示
    const requestSignal = logical.signal
      ? (AbortSignal.any ? AbortSignal.any([logical.signal, timeoutSignal]) : logical.signal)
      : timeoutSignal;
    const res = await fetch(url, {
      method,
      headers: rebuildRequestHeaders(logical.headers, cookie, viaValue),
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      redirect: 'manual',
      signal: requestSignal
    });
    if (res.status === 401 && attempt === 0) {
      attempt += 1;
      credential.invalidate();
      audit?.({ kind: 'proxy.credential-refresh', deviceId: logical.deviceId });
      continue;
    }
    const rawHeaders = {};
    res.headers.forEach((value, name) => {
      rawHeaders[name] = value;
    });
    const headers = filterResponseHeaders(rawHeaders);
    // ★ 流式响应（SSE / chunked 长连接）必须**边收边转发**：
    //   旧实现用 await res.arrayBuffer() 会等整个响应结束 —— 对流式 LLM（思考过程
    //   SSE）等于「攒完再发」，长思考期间客户端零字节 → 超时断开 →
    //   raccoon: client has aborted request (HTTP 499)。真机事故 2026-10-01。
    const contentType = String(rawHeaders['content-type'] ?? '');
    // 只在**明确声明 SSE** 时走流式；其余一律缓冲（内容寻址资源可压缩、可算 length，
    // 且普通响应缓冲后语义更稳）。DSH 的 LLM 流与事件流都是 text/event-stream。
    const isStreaming = /text\/event-stream/i.test(contentType);
    if (isStreaming) {
      audit?.({ kind: 'proxy.forward-stream', deviceId: logical.deviceId, method, path: target.pathname, status: res.status });
      return { status: res.status, headers, stream: res.body };
    }
    const declaredLength = Number(rawHeaders['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      logger?.warn?.(`[kite] response too large (${declaredLength}B) for ${target.pathname}`);
      try { await res.body?.cancel?.(); } catch { /* ignore */ }
      return respond(502, { 'content-type': 'application/json' }, json({ error: 'proxy/response-too-large', message: '响应超过代理上限（64 MiB）' }));
    }
    const buf = await readResponseBody(res, MAX_RESPONSE_BYTES);
    if (!buf) {
      logger?.warn?.(`[kite] response exceeded ${MAX_RESPONSE_BYTES}B for ${target.pathname}`);
      return respond(502, { 'content-type': 'application/json' }, json({ error: 'proxy/response-too-large', message: '响应超过代理上限（64 MiB）' }));
    }
    /**
     * ★ 移动端皮肤注入（deps.mobileSkin，可选）：只对**缓冲路径**的 HTML 生效。
     *   为什么必须在 canonicalize 收口之后做：这是「已判定、已在途」的响应改写，
     *   与请求目标解析无关，不会重新引入两种解析 —— 但它必须同步修正
     *   content-length / etag 并强制 no-store，否则浏览器会按旧长度截断或拿缓存。
     *   未注入该 dep 时完全零开销（生产默认不开）。
     */
    let outBuf = buf;
    let outHeaders = headers;
    if (typeof deps.mobileSkin === 'function') {
      const patched = deps.mobileSkin({ method, path: target.key, status: res.status, headers, body: buf });
      if (patched && patched.body) {
        outBuf = patched.body;
        outHeaders = patched.headers ?? headers;
      }
    }
    audit?.({ kind: 'proxy.forward', deviceId: logical.deviceId, method, path: target.pathname, status: res.status, bytes: outBuf.length });
    return { status: res.status, headers: outHeaders, body: outBuf };
  }
}

function respond(status, headers, body) {
  return { status, headers, body };
}

async function readResponseBody(res, maxBytes) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      if (!value || value.length === 0) continue;
      total += value.length;
      if (total > maxBytes) {
        try { await reader.cancel('response too large'); } catch { /* ignore */ }
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

function json(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

/** 无票/票据失效时回给手机浏览器的配对引导页（经代理到达；不泄漏任何宿主信息）。 */
export function pairRequiredPage() {
  return Buffer.from(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 远程访问 · 需要配对</title>
<style>body{font-family:system-ui,sans-serif;background:#0e1116;color:#e6e8eb;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
main{max-width:26rem;padding:2rem;text-align:center;line-height:1.6}
code{background:#1c2128;padding:.2em .4em;border-radius:.3em;font-size:.9em}</style></head>
<body><main><h1>需要配对</h1>
<p>这台设备还没有接入当前 DSH 实例。</p>
<p>请在桌面端 DSH 的「远程访问」面板生成配对链接，并在本机浏览器打开形如<br>
<code>https://&lt;relay&gt;/kite/pair?token=…</code> 的地址。</p>
</main></body></html>`, 'utf8');
}

export { REQUEST_HEADER_WHITELIST };
