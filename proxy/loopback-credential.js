/**
 * loopback 凭据（ADR-002 的关键机制，方案 §8.3(a)）。
 *
 * Connector 用本进程启动令牌（ctx.connection.authenticatedUrl）换 DSH 会话 cookie：
 *   GET http://127.0.0.1:<port>/?token=<launchToken> → 303 + Set-Cookie dsh-auth-*
 * cookie 只存内存，永不落盘、永不出机；手机永远拿不到。
 *
 * 契约：非 303 = 交换失败，必须抛错而非静默继续（契约测试覆盖）。
 * 401 恢复：代理路径收到 401 时调用 invalidate() + 下次 forward 前重新交换一次。
 */
const EXCHANGE_TIMEOUT_MS = 10_000;

export class LoopbackCredential {
  #adapter;
  #logger;
  #base;
  #cookie;
  #exchanging;

  constructor(adapter, logger) {
    this.#adapter = adapter;
    this.#logger = logger;
  }

  get base() {
    return this.#base;
  }

  /** 一次性交换（并发调用共享同一 in-flight promise）。 */
  acquire() {
    if (this.#cookie) return Promise.resolve({ base: this.#base, cookie: this.#cookie });
    this.#exchanging ??= this.#exchange().catch((error) => {
      this.#exchanging = undefined;
      throw error;
    });
    return this.#exchanging;
  }

  invalidate() {
    this.#cookie = undefined;
    this.#exchanging = undefined;
  }

  async #exchange() {
    const port = this.#adapter.webServerPort();
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error('credential exchange failed: webServer port unavailable (plugin not ready or wrong profile)');
    }
    const base = `http://127.0.0.1:${port}`;
    let authedUrl;
    try {
      authedUrl = this.#adapter.authenticatedUrl(`${base}/`);
    } catch (error) {
      throw new Error(`credential exchange failed: authenticatedUrl unavailable (${error.message})`);
    }
    if (!authedUrl) throw new Error('credential exchange failed: authenticatedUrl returned empty (connection service missing?)');
    const res = await fetch(authedUrl, { redirect: 'manual', signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS) });
    // 官方契约：令牌交换成功 = 303（BrowserAuth.authorizeIndex）。
    if (res.status !== 303) {
      throw new Error(`credential exchange failed: HTTP ${res.status} (expected 303; launch token stale or consumed)`);
    }
    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const cookie = cookies[0]?.split(';', 1)[0];
    if (!cookie || !cookie.startsWith('dsh-auth-')) {
      throw new Error('credential exchange returned no dsh-auth cookie');
    }
    this.#base = base;
    this.#cookie = cookie;
    this.#logger?.info?.(`[kite] loopback credential acquired for 127.0.0.1:${port} (${cookie.split('=', 1)[0]}=…)`);
    return { base, cookie };
  }
}
