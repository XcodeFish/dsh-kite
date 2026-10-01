/**
 * 审批/提问的远程侧接入（方案 §7.3，R5「危险动作须在手机上确认」）。
 *
 * 已核实的宿主事实（0.1.7-rc.2）：`dsh-api-remotes` 已把 `approval/request` 与
 * `user-questions/request` 两个 waterfall 以 pending-event 形式转发给**所有已连接的
 * 远程客户端**（桌面 webview、经代理的 PWA 手机同源），首个 `/api/$events/result`
 * 应答生效。因此本插件**不注册应答者**（与桌面 UI 抢答只会制造双确认歧义），
 * 只做两件事：
 *   ① 旁听审计：每个审批请求记审计（绝不吞 next()，绝不阻塞判定链）；
 *   ② 推送提醒：fire-and-forget 把「有待审批」提示推给在线设备（经中继 Notify 帧；
 *      v0.1 落审计 + 指标，帧通道随 thin client 一并启用）。
 *
 * 作用域纪律（memory 教训④）：waterfall 在 agent 作用域分发；根级 ctx.on 可听见，
 * listener 里只读 request.agent 做归属，不做任何应答。
 */

export function registerApprovalAudit(ctx, { audit, logger, metrics }) {
  const listeners = [];
  for (const event of ['approval/request', 'user-questions/request']) {
    if (typeof ctx.on !== 'function') return () => {};
    let dispose;
    try {
      dispose = ctx.on(event, (request, next) => {
        // 只旁听：先交棒，再做异步副作用（fire-and-forget + catch）。
        try {
          const agent = request?.agent;
          const toolName = request?.toolName ?? request?.tool ?? event;
          audit?.({
            kind: event === 'approval/request' ? 'approval.asked' : 'question.asked',
            detail: {
              tool: String(toolName),
              agent: agent?.id ?? null,
              reason: typeof request?.reason === 'string' ? request.reason.slice(0, 200) : undefined
            }
          });
          metrics?.approvalShown();
        } catch {
          /* 审计失败绝不影响判定链 */
        }
        return typeof next === 'function' ? next() : undefined;
      });
    } catch (error) {
      logger?.warn?.(`[kite] approval audit register failed for ${event}: ${error.message}`);
      continue;
    }
    listeners.push(() => {
      try {
        dispose?.();
      } catch {
        /* ignore */
      }
    });
  }
  return () => {
    for (const off of listeners) off();
  };
}
