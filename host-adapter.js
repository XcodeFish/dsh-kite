/**
 * 与宿主的接触面唯一收口（方案 §8.4）。
 *
 * 所有 ctx.* 访问必须经此模块：DSH 仍在 0.1.7-rc.2，宿主 API 会漂移；
 * 可选服务一律 ctx.get(name, false)，绝不在未声明 inject 的 ctx 上直取属性
 * （真机事故：定时器内 ctx.xxx 直取抛 without-inject = 宿主崩进恢复模式）。
 */

export function hostAdapter(ctx) {
  return {
    /** webServer 静态注入后可用；port 在 listen 完成前是 undefined。 */
    webServerPort: () => {
      const ws = ctx.webServer;
      return ws && typeof ws.port === 'number' ? ws.port : undefined;
    },
    registerRoute: (route) => ctx.webServer.register(route),
    registerUpgrade: (route) => ctx.webServer.registerUpgrade(route),
    /** connection 是可选服务（ctx.inject 延迟注入后从 scope 取）。 */
    authenticatedUrl: (base) => {
      const connection = ctx.get('connection', false);
      if (!connection || typeof connection.authenticatedUrl !== 'function') return undefined;
      return connection.authenticatedUrl(base);
    },
    requestRejection: (req) => {
      const connection = ctx.get('connection', false);
      if (!connection || typeof connection.requestRejection !== 'function') return 503;
      return connection.requestRejection(req);
    },
    /** 本进程启动令牌（管理面 token 兑换用；与宿主 authenticatedUrl 同源，不出机）。 */
    launchToken: () => {
      const connection = ctx.get('connection', false);
      if (!connection || typeof connection.authenticatedUrl !== 'function') return undefined;
      try {
        return new URL(connection.authenticatedUrl('http://127.0.0.1/'), 'http://127.0.0.1').searchParams.get('token') ?? undefined;
      } catch {
        return undefined;
      }
    }
  };
}
