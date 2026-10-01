/**
 * 远程会话预设锁定（方案 §7.2 硬规则 1，R5）。
 *
 * 已核实（0.1.7-rc.2）：`session/create` 的请求体里承载预设的字段是 `agentPreset`
 * （dsh-api-session-controller SessionCommandController.create；未知 id 报
 * `agent-preset/not-found`，天然 fail-closed）。本模块把远程发起的
 * session/create 收敛到配置的 preset 白名单：
 *   - 请求体省略 agentPreset → 注入 remoteAgentPreset（默认 'default'）；
 *   - 请求体显式要求的 agentPreset 不在 allowedAgentPresets → 403（可读原因）；
 *   - 其余字段（sessionId/cwd/workspaceId）不动。
 *
 * 权限预设（sandbox 档位）是另一条轴：它由会话内用户在 PWA 里选择，且提权要过
 * approval ask；本模块在 README 里如实标注这条边界。
 */

/**
 * 重写 session/create 请求体。body 是原始 Buffer 或 undefined。
 * 返回 { ok:true, body:Buffer } | { ok:false, reason }。
 */
export function rewriteSessionCreateBody(body, cfg) {
  const remotePreset = cfg.remoteAgentPreset;
  const allowed = new Set([...(cfg.allowedAgentPresets ?? []), remotePreset].filter(Boolean));
  if (!remotePreset) {
    // 未配置 = 不收敛（显式选择），但至少校验显式值在白名单内。
    if (allowed.size === 0) return { ok: true, body: body ?? Buffer.alloc(0) };
  }
  let parsed;
  if (body === undefined || body === null || body.length === 0) {
    parsed = {};
  } else {
    try {
      parsed = JSON.parse(Buffer.from(body).toString('utf8'));
    } catch {
      return { ok: false, reason: 'session/create 请求体不是合法 JSON' };
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'session/create 请求体必须是 JSON 对象' };
  }
  if (parsed.agentPreset !== undefined) {
    if (typeof parsed.agentPreset !== 'string') return { ok: false, reason: 'agentPreset 必须是字符串' };
    if (!allowed.has(parsed.agentPreset)) {
      return { ok: false, reason: `远程会话不允许使用 agent preset "${parsed.agentPreset}"（白名单：${[...allowed].join(', ')}）` };
    }
  }
  parsed.agentPreset = remotePreset || parsed.agentPreset;
  return { ok: true, body: Buffer.from(JSON.stringify(parsed), 'utf8') };
}

/** 内层 sealed 帧也走同一判定（open{method,path} → 语义等价 POST path）。 */
export function rewriteSealedOpen(open, cfg) {
  if (!/^\/api\/session\/create$/.test(open.path)) return { ok: true };
  const rewrite = rewriteSessionCreateBody(open.bodyRef === undefined ? undefined : Buffer.from(open.bodyRef, 'base64url'), cfg);
  if (!rewrite.ok) return rewrite;
  return { ok: true, body: rewrite.body.length ? rewrite.body.toString('base64url') : undefined };
}
