/**
 * 配对（方案 §6.2）：一次性 pairingToken + 挑战 + 6 位校验码。
 *
 * - token：32B 随机，TTL（默认 120s），用后即焚，timingSafeEqual 比较。
 * - 校验码：SHA256(devicePubB64 ‖ "|" ‖ connectorPubB64) 的**前 3 字节按大端序**取值
 *   再 `% 1000000`，左补零到 6 位十进制；手机侧用 WebCrypto 独立算同一个值
 *   （算法必须逐字节一致，见 admin/panel.js 配对页与 test/pairing.test.mjs 的跨端断言）。
 *   注意不是「摘要 hex 的前 6 个字符」—— 两者会得到完全不同的数字。
 *   用户比对一致才确认 —— 用户成为信任根（Signal safety number 轻量版）。
 * - 流程（thin client）：pair-begin(token,pubKey) → pair-challenge →
 *   pair-done(sig(challenge‖connectorId‖ts)) → pair-result(ok, deviceId, setCookie)。
 *   PWA 模式的配对页（admin/pair-page）走同一套验证函数，经 HTTP 表达。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { b64d, b64e } from '../transport/frames.js';
import { newChallenge } from './ticket.js';
import { deviceIdFromPublicKey } from './device-store.js';

export class PairingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 6 位十进制校验码（确定性）：取摘要前 3 字节大端序 % 1000000 再左补零。
 *  ★ 与手机侧（admin/panel.js 配对页的 crypto.subtle 实现）必须逐字节一致 ——
 *  两处分叉会让「两端比对」退化为「连接器跟自己对账」。 */
export function verificationCode(devicePubB64, connectorPubB64) {
  const digest = createHash('sha256').update(`${devicePubB64}|${connectorPubB64}`).digest();
  const n = digest.readUIntBE(0, 3) % 1_000_000;
  return String(n).padStart(6, '0');
}

/**
 * 配对会话管理器。
 * keys: identity/keys.js；tickets: identity/ticket.js；devices: identity/device-store.js。
 * secureCookies: relayUrl 为 wss://（生产）时 true；ws:// 本地联调时 false ——
 * Secure cookie 在纯 http 下会被浏览器丢弃，故按中继 scheme 决定（README 偏差记录）。
 */
export function createPairingService({ keys, tickets, devices, ttlMs, logger, audit, secureCookies = true }) {
  /** pairingToken → { token, code?, expiresAt, pubKey?, name?, channel?, challenge?, used } */
  const pending = new Map();

  /**
   * 最近一次配对结局 —— 面板把「等待手机提交…」换成确定终态的唯一依据。
   *
   * ★ 为什么必须有（真机事故 2026-10-03）：`list()` 只反映**进行中**的会话，而配对成功的
   *   那一刻 `complete()` 就把会话删掉了 —— 面板能观察到的只有「条目消失」，无法区分
   *   「配对成功 / 挑战验签失败 / 二维码过期 / kill switch 清空」。桌面浮层因此永久停在
   *   「等待手机提交…」，而下面的设备表已经出现新设备，用户无从判断到底连上没有。
   *   单槽 + 时间单调守卫：状态有界（不随配对次数增长）；客户端用 tokenMasked 关联自己
   *   发起的那一次，无关结局（例如别人拿旧二维码重扫）自动忽略。
   */
  let lastOutcome = null;

  /** 与 list() 同一遮罩格式：客户端据此认领自己那次配对，且不泄漏令牌本体。 */
  const mask = (token) => `${token.slice(0, 6)}…${token.slice(-4)}`;

  /**
   * 记录终态。`tokenMasked` = 单个会话的遮罩（面板认领用）；批量终局（一次性过期多条、
   * kill switch 清空）用 `tokenMasks` 数组列出全部相关遮罩 —— 面板匹配任一即可，
   * 否则「被批量清掉的那条会话」的所属面板仍会停在过程态。
   */
  function recordOutcome(outcome) {
    const at = Date.now();
    if (lastOutcome && lastOutcome.at > at) return; // 时间单调：乱序回调不得覆盖更新的结局
    lastOutcome = { at, ...outcome };
  }

  /** 单个会话的终态（附 tokenMasked + tokenMasks 双标记，面板两者取或）。 */
  function recordSession(session, outcome) {
    const tokenMasked = mask(session.token);
    recordOutcome({ ...outcome, tokenMasked, tokenMasks: [tokenMasked] });
  }

  function sweep() {
    const now = Date.now();
    const expired = [];
    for (const [token, session] of pending) {
      if (session.expiresAt <= now) {
        pending.delete(token);
        expired.push({ name: session.name, tokenMasked: mask(token) });
      }
    }
    // 过期是终局：面板据此把「等待手机提交…」翻成「已过期，请重新生成」。
    if (expired.length > 0) {
      recordOutcome({
        ok: false,
        reason: 'expired',
        name: expired[expired.length - 1].name,
        tokenMasked: expired[expired.length - 1].tokenMasked,
        tokenMasks: expired.map((e) => e.tokenMasked)
      });
    }
  }

  return {
    /** 创建一次性配对（admin 面板调用）。返回 {token, expiresAt}；校验码待设备公钥到位后确定。 */
    begin({ name, channel }) {
      sweep();
      const token = b64e(randomBytes(32));
      const session = { token, name: String(name || 'phone').slice(0, 80), channel: channel ?? null, expiresAt: Date.now() + ttlMs, used: false };
      pending.set(token, session);
      audit?.({ kind: 'pair.create', detail: { name: session.name } });
      return { token, expiresAt: session.expiresAt };
    },

    list() {
      sweep();
      return [...pending.values()].map(({ token, name, expiresAt, used, code }) => ({
        tokenMasked: `${token.slice(0, 6)}…${token.slice(-4)}`,
        name,
        expiresAt,
        used,
        // 校验码在设备提交公钥后才产生；出示给面板供用户与手机两端比对（防中继抢配）。
        ...(code ? { code } : {})
      }));
    },

    /**
     * 最近一次配对的结局（终态）或 null：
     *   {ok, reason?, deviceId?, name?, detail?, tokenMasked?, tokenMasks: [], at}
     *
     * ★ 与 list() 的分工：list() = 进行中（提交公钥后才有 code）；last() = 已终结。
     *   面板必须两者合起来看 —— 只看 list() 时「配对成功」在列表里表现为「条目凭空消失」，
     *   与「失败/过期」不可区分，这正是浮层滞留「等待手机提交…」的原因。
     *   reason 取值：'done'（成功）/ 'expired' / 'rejected'（验签失败）/ 'reused'
     *   / 'invalid-pubkey' / 'aborted'（kill switch 清空）。
     *   认领方式：tokenMasks 含本次面板的 tokenMasked 才算自己的（单个终态即 [那个]）。
     */
    last() {
      return lastOutcome ? { ...lastOutcome, tokenMasks: [...(lastOutcome.tokenMasks || [])] } : null;
    },

    pendingCount() {
      sweep();
      return pending.size;
    },

    /**
     * 设备提交 token + 公钥（thin client pair-begin / PWA 配对页）。
     * 校验通过 → 签发挑战。返回 {challenge, code, deviceId}。
     *
     * ★ P2（幽灵设备）：**不在这里写 ACL**。旧实现在提交公钥时就 `devices.upsert()`，
     *   于是「提交了公钥但从未完成挑战签名」的设备会永久留在设备表里 —— 面板显示一堆
     *   永远连不上的幽灵条目，用户只能手工撤销。ACL 落库推迟到 complete() 验签通过之后。
     *   deviceId 是公钥的纯函数（device-store.deviceIdFromPublicKey），不需要预先入库。
     */
    async submit({ token, pubKey, name, channel }) {
      sweep();
      const session = typeof token === 'string' ? pending.get(token) : undefined;
      if (!session || session.used) {
        audit?.({ kind: 'pair.reject', detail: { reason: session?.used ? 'token reused' : 'token unknown/expired' } });
        // ★ 只有「已知会话被重复提交」才记结局；未知令牌（别人拿旧二维码来扫）不记 ——
        //   否则会盖掉用户自己那次正在进行的配对。重复提交也不是终态：会话仍在
        //   pending 里（挑战已发），手机签名成功后 complete() 会用更新的时间戳覆盖它。
        if (session?.used) recordSession(session, { ok: false, reason: 'reused', name: session.name });
        throw new PairingError('pair/invalid-token', '配对令牌无效、过期或已被使用');
      }
      session.used = true; // 用后即焚：即使后续挑战失败也要重新生成 token（防穷举窗口）
      let pubRaw;
      try {
        pubRaw = b64d(pubKey, 'pubKey');
      } catch {
        recordSession(session, { ok: false, reason: 'invalid-pubkey', name: session.name });
        throw new PairingError('pair/invalid-pubkey', '设备公钥格式非法');
      }
      if (pubRaw.length !== 32) {
        recordSession(session, { ok: false, reason: 'invalid-pubkey', name: session.name });
        throw new PairingError('pair/invalid-pubkey', '设备公钥必须是 32 字节 Ed25519');
      }
      const deviceId = deviceIdFromPublicKey(pubRaw);
      const challenge = newChallenge();
      const code = verificationCode(pubKey, keys.ed25519.publicB64u);
      session.pubKey = pubKey;
      session.deviceName = String(name || session.name).slice(0, 80);
      session.challenge = challenge;
      session.deviceId = deviceId;
      session.code = code;
      audit?.({ kind: 'pair.challenge', deviceId, detail: { name: session.deviceName, pending: true } });
      return { challenge, code, deviceId };
    },

    /**
     * 设备提交挑战签名 → 验签 + nonce 查重 → 完成（设备已在 ACL）。
     * 会话按 challenge 定位（thin client 帧流与 PWA 页共用）。
     * 返回 {ok:true, deviceId, ticket, code, setCookie} 或抛 PairingError。
     */
    async complete({ challenge, sig, ts }) {
      sweep();
      const session = [...pending.values()].find((entry) => entry.deviceId && entry.challenge === challenge);
      if (!session) {
        throw new PairingError('pair/invalid-token', '配对会话不存在或挑战不匹配');
      }
      // 验签用会话里暂存的公钥（尚未入 ACL）；deviceId 也是它的纯函数。
      const verdict = tickets.verifyChallenge(b64d(session.pubKey, 'pubKey'), session.deviceId, challenge, sig, ts);
      if (!verdict.ok) {
        audit?.({ kind: 'pair.reject', deviceId: session.deviceId, detail: { reason: verdict.reason } });
        recordSession(session, { ok: false, reason: 'rejected', detail: verdict.reason, name: session.deviceName ?? session.name });
        throw new PairingError('pair/verify-failed', `挑战验证失败：${verdict.reason}`);
      }
      // ★ P2：验签通过**之后**才写设备表 —— 未完成的配对不会留下幽灵设备条目。
      const device = await devices.upsert({ pubKey: session.pubKey, name: session.deviceName ?? session.name, kind: 'thin' });
      const ticket = tickets.issue(session.deviceId);
      audit?.({ kind: 'pair.success', deviceId: session.deviceId, detail: { name: device.name } });
      pending.delete(session.token);
      // ★ claim 凭证原件：手机私钥对 (challenge ‖ connectorId ‖ ts) 的签名 ——
      //   配对那一刻「该设备属于本连接器」的密码学事实。连接器应把它转交中继
      //   （device-claim 帧），中继验签后持久化归属（Pair-Proof，2026-10-02）。
      //   challenge 原样带上（b64url 字符串），中继无需解析即可复验绑定关系。
      //   同时落到设备条目（devices.json）—— 连接器重连/中继重启后可重放恢复归属。
      const claim = { deviceId: session.deviceId, pubKey: device.pubKey, sig, ts, challenge };
      await devices.attachClaim(session.deviceId, claim);
      // ★ 成功也是终局：面板据此把「等待手机提交…」翻成「✓ 配对成功」。
      //   必须有这一条 —— 会话已从 pending 删除，list() 从此看不到任何痕迹。
      recordSession(session, { ok: true, reason: 'done', deviceId: session.deviceId, name: device.name });
      return {
        deviceId: session.deviceId,
        ticket,
        code: session.code,
        setCookie: deviceCookie('ra-device', ticket, 12 * 3600, secureCookies),
        claim
      };
    },

    /** 销毁全部未完成配对（kill switch）。 */
    abortAll() {
      const n = pending.size;
      // 批量终局也要带全部遮罩：否则被清掉的会话所属面板仍停在「等待手机提交…」。
      if (n > 0) {
        const masks = [...pending.keys()].map(mask);
        recordOutcome({ ok: false, reason: 'aborted', count: n, tokenMasks: masks });
      }
      pending.clear();
      return n;
    }
  };
}

/**
 * 设备 cookie 序列化（经代理透传给手机浏览器）。
 * secure=false 仅限 ws:// 中继本地联调（http 下 Secure 会被浏览器丢弃）。
 */
export function deviceCookie(name, value, maxAgeSeconds = 12 * 3600, secure = true) {
  const attrs = `Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  return `${name}=${value}; ${attrs}`;
}

/** 从 Cookie 头取 ra-device 值（只解析精确名，不做通用 Cookie 解析）。 */
export function deviceCookieFrom(headerValue, name = 'ra-device') {
  if (typeof headerValue !== 'string') return undefined;
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1 || segment.slice(0, at).trim() !== name) continue;
    return segment.slice(at + 1).trim();
  }
  return undefined;
}

export { timingSafeEqual };
