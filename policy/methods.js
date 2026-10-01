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

/** 请求行是否可安全透传（只允许 http(s) 的 path+query 形态）。 */
export function safeProxyPath(path, limit = 8192) {
  if (typeof path !== 'string' || path.length === 0 || path.length > limit) return false;
  if (!path.startsWith('/')) return false;
  if (path.includes(' ') || path.includes('\\')) return false;
  // ★ 逗号是合法路径字符：DSH 用 /plugins/??a/client.js,b/client.js 形式批量加载
  //   客户端模块（真机事故 2026-09-30：旧的宽松校验把逗号当非法 → 400 → 前端加载失败）。
  // 拒绝伪装成 absolute-form 的请求目标与控制字符。
  if (/^https?:\/\//i.test(path)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  return true;
}

export function createPolicy(cfg) {
  return new Policy(cfg);
}
