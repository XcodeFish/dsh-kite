/**
 * 方法策略（方案 §7.2）：远程请求的方法/路径收敛。
 *
 * 三条硬规则：
 * 1. 远程会话不允许继承默认预设 → 见 presets.js（session/create 注入）。
 * 2. 危险方法默认拒绝：终端写类、上传、plugin 相关写操作、HMR 事件通道。
 * 3. 绝不静默放行：每次拒绝都带可读原因并进审计（调用方负责落审计）。
 *
 * 已知边界（诚实清单）：/api/remote.mux 内部的 RPC 词汇无法逐帧过滤（那是 DSH
 * 自己的语义协议）；收敛靠 session/create 预设锁定 + 审批 ask 策略兜底。
 */
import { rewriteSessionCreateBody } from './presets.js';

/** 终端写类 endpoint（namespace terminal，见 dsh-api-terminal-controller）。 */
const TERMINAL_WRITE = new Set([
  'environment', // 改终端环境
  'create',
  'write',
  'resize',
  'rename',
  'close'
]);
const TERMINAL_READ = new Set(['shells', 'list', 'retain', 'follow']);

export class Policy {
  #cfg;

  constructor(cfg) {
    this.#cfg = cfg;
  }

  get config() {
    return { ...this.#cfg };
  }

  /**
   * 判定一个透传 HTTP 请求。返回：
   * { action:'allow' } | { action:'deny', status, reason } | { action:'rewrite', body }
   * （rewrite 仅 session/create，见 presets.js；调用方先经本方法再走重写。）
   *
   * ★ path 必须是 canonicalizeTarget(...).key（P0-1）—— 传原始串等于把两次解析的
   *   差异重新引回来：`/./kite/api/x` 不命中保留前缀，`new URL` 之后却会打到管理面。
   *   WS 侧（transport/relay-client.js 的 ws-open）走同一道门，不是后门。
   */
  decide({ method = 'GET', path: rawPath, body }) {
    const method_ = String(method).toUpperCase();
    const path = String(rawPath || '/');

    // ① HMR 事件通道与插件前端写操作：一律拒绝（方案 §11.3）。
    if (path === '/plugins/events' || path.startsWith('/plugins/events?')) {
      return deny(403, 'HMR 事件通道不经过远程代理（白名单优先）');
    }

    // ② 上传：默认拒绝（R5 危险动作收敛）。
    if (path.startsWith('/api/session/uploadFileBinary')) {
      if (!this.#cfg.allowUpload) return deny(403, '远程上传默认禁用（policy.allowUpload）');
    }

    // ③ 终端写类：默认拒绝。
    if (path.startsWith('/api/terminal/')) {
      const endpoint = path.slice('/api/terminal/'.length).split('?')[0].split('/')[0];
      if (!this.#cfg.allowTerminal && TERMINAL_WRITE.has(endpoint)) {
        return deny(403, `远程终端写类方法被策略拒绝：terminal/${endpoint}（policy.allowTerminal）`);
      }
      if (!TERMINAL_WRITE.has(endpoint) && !TERMINAL_READ.has(endpoint) && !this.#cfg.allowUnknownTerminal) {
        return deny(403, `未知终端方法默认拒绝：terminal/${endpoint}`);
      }
    }

    // ④ plugin 相关写操作拒绝；插件前端静态资源（GET）放行。
    //    ★ DSH 前端用合并请求加载客户端模块，形如：
    //      /plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=xxx
    //      /plugins/?modules=...
    //    这类路径**不以扩展名结尾**（含 `??`、`&rev=` 等），旧的扩展名白名单会把
    //    整个前端打死（真机症状：Failed to load plugins / HTML did not preload
    //    @deepseek-ai/dsh-client-modules/client.js）。因此改为：
    //    仅拒绝「明显是写操作或敏感通道」的插件请求，其余 GET/HEAD 静态资源一律放行。
    if (/^\/plugins\//.test(path) || path.startsWith('/api/plugin')) {
      const readOnly = method_ === 'GET' || method_ === 'HEAD';
      if (!readOnly) return deny(403, '远程禁用 plugin 相关写操作');
      // 仅拦 HMR 事件通道（已在 ① 处理）与目录遍历；其余静态资源放行。
      if (path.includes('..')) return deny(403, '插件路径含目录遍历');
    }

    // ⑤ 社区市场写操作拒绝（GET 也拒绝 —— 市场在远程没有意义且要凭据）。
    if (path.startsWith('/api/community-market')) {
      return deny(403, '远程禁用社区市场');
    }

    // ⑥ 本插件管理面前缀不出现在代理路径（reserved；调用方在转发前已摘除）。
    if (path === '/kite' || path.startsWith('/kite/')) {
      return deny(404, 'reserved');
    }

    // ⑦ session/create 预设锁定。
    if (path.startsWith('/api/session/create') && method_ === 'POST') {
      const rewrite = rewriteSessionCreateBody(body, this.#cfg);
      if (!rewrite.ok) return deny(403, rewrite.reason);
      return { action: 'rewrite', body: rewrite.body };
    }

    return { action: 'allow' };
  }
}

function deny(status, reason) {
  return { action: 'deny', status, reason };
}

/**
 * 规范化基准 origin：固定、不可路由，只用来让 URL 解析器做一次归一化。
 * 与真实 loopback origin 无关 —— 出站组装会把 pathname/search 贴到受信 origin 上（proxy/reverse-proxy.js）。
 */
const CANON_ORIGIN = 'http://kite.invalid';

/**
 * ★ 唯一收口（P0-1，安全审查终审报告 §1）：请求目标字符串 → origin-form 的 { pathname, search, key }。
 *
 * 根因：判定看原始串、发送用 `new URL(raw, base)` 的结果 —— 两次解析之间的映射差异
 * （点段折叠 `/./`、`/x/../`、`%2e`，authority 切换 `//host`）就是全部 Critical 绕过面。
 * 修法只有一条：**只解析一次**，判定 / 审计 / 出站组装共用这一个返回值。
 *
 * 返回 null = 直接 400（不可代理）。
 */
export function canonicalizeTarget(rawTarget, limit = 8192) {
  if (typeof rawTarget !== 'string' || rawTarget.length === 0 || rawTarget.length > limit) return null;
  // 必须 origin-form：恰好一个前导 '/'（'//' 是 protocol-relative，会切 authority）
  if (rawTarget[0] !== '/' || rawTarget[1] === '/') return null;
  if (rawTarget.includes(' ') || rawTarget.includes('\\') || rawTarget.includes('#')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(rawTarget)) return null;
  let url;
  try {
    url = new URL(rawTarget, CANON_ORIGIN);
  } catch {
    return null;
  }
  // authority 被改写（//host、http://host、\host 之类的变体）→ 一律拒
  if (url.origin !== CANON_ORIGIN) return null;
  // pathname 里出现百分号编码的 / \ . 与控制字符：URL 只折叠 %2e，%2f/%5c 会原样透给宿主，
  // 宿主若再做一次 decode 就又是一次「判定/发送」差异。这些字节在 DSH 的 pathname 里无合法用途。
  const ENCODED_STRUCTURAL = /%(2f|5c|2e|0[0-9a-f]|1[0-9a-f]|7f)/i;
  if (ENCODED_STRUCTURAL.test(url.pathname)) return null;
  // ★ 双编码（`%252e`）：URL 不会折叠它，本层判定也看不见点段 —— 但宿主若解码两次
  //   就会重新出现 `/kite/...`。这里只对「含 %25」的少数写法做一次额外解码检查：
  //   解一次后若仍暴露编码的点/斜杠/反斜杠，说明是刻意双编码 → 拒。
  if (/%25/i.test(url.pathname)) {
    let once;
    try {
      once = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    if (ENCODED_STRUCTURAL.test(once) || once.includes('\\')) return null;
  }
  return { pathname: url.pathname, search: url.search, key: `${url.pathname}${url.search}` };
}

/**
 * 兼容保留：现有测试与调用方只关心「是否可代理」。
 * ★ 但它只回答「能不能代理」，**不回答「会不会打到别处」** —— 新代码请直接用
 *   canonicalizeTarget 的返回值（判定/审计/出站同源）。
 */
export function safeProxyPath(path, limit = 8192) {
  return canonicalizeTarget(path, limit) !== null;
}

export function createPolicy(cfg) {
  return new Policy(cfg);
}
