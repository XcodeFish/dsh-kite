/**
 * 配对（方案 §6.2）：一次性 pairingToken + 挑战 + 6 位校验码。
 *
 * - token：32B 随机，TTL（默认 120s），用后即焚，timingSafeEqual 比较。
 * - 校验码：SHA256(devicePubKey ‖ connectorPubKey) 前 6 位十进制，双方独立计算，
 *   用户比对一致才确认 —— 用户成为信任根（Signal safety number 轻量版）。
 * - 流程（thin client）：pair-begin(token,pubKey) → pair-challenge →
 *   pair-done(sig(challenge‖connectorId‖ts)) → pair-result(ok, deviceId, setCookie)。
 *   PWA 模式的配对页（admin/pair-page）走同一套验证函数，经 HTTP 表达。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { b64d, b64e } from '../transport/frames.js';
import { newChallenge } from './ticket.js';

export class PairingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 前 6 位十进制校验码（确定性）。 */
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

  function sweep() {
    const now = Date.now();
    for (const [token, session] of pending) {
      if (session.expiresAt <= now) pending.delete(token);
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

    pendingCount() {
      sweep();
      return pending.size;
    },

    /**
     * 设备提交 token + 公钥（thin client pair-begin / PWA 配对页）。
     * 校验通过 → 登记 pubKey 并签发挑战。返回 {challenge, code}。
     */
    async submit({ token, pubKey, name, channel }) {
      sweep();
      const session = typeof token === 'string' ? pending.get(token) : undefined;
      if (!session || session.used) {
        audit?.({ kind: 'pair.reject', detail: { reason: session?.used ? 'token reused' : 'token unknown/expired' } });
        throw new PairingError('pair/invalid-token', '配对令牌无效、过期或已被使用');
      }
      session.used = true; // 用后即焚：即使后续挑战失败也要重新生成 token（防穷举窗口）
      let pubRaw;
      try {
        pubRaw = b64d(pubKey, 'pubKey');
      } catch {
        throw new PairingError('pair/invalid-pubkey', '设备公钥格式非法');
      }
      if (pubRaw.length !== 32) throw new PairingError('pair/invalid-pubkey', '设备公钥必须是 32 字节 Ed25519');
      const entry = await devices.upsert({ pubKey, name: name || session.name, kind: 'thin' });
      const challenge = newChallenge();
      const code = verificationCode(pubKey, keys.ed25519.publicB64u);
      session.challenge = challenge;
      session.deviceId = entry.deviceId;
      session.code = code;
      audit?.({ kind: 'pair.challenge', deviceId: entry.deviceId, detail: { name: entry.name } });
      return { challenge, code, deviceId: entry.deviceId };
    },

    /**
     * 设备提交挑战签名 → 验签 + nonce 查重 → 完成（设备已在 ACL）。
     * 会话按 challenge 定位（thin client 帧流与 PWA 页共用）。
     * 返回 {ok:true, deviceId, ticket, code, setCookie} 或抛 PairingError。
     */
    complete({ challenge, sig, ts }) {
      sweep();
      const session = [...pending.values()].find((entry) => entry.deviceId && entry.challenge === challenge);
      if (!session) {
        throw new PairingError('pair/invalid-token', '配对会话不存在或挑战不匹配');
      }
      const device = devices.get(session.deviceId);
      if (!device) throw new PairingError('pair/revoked', '设备已在配对期间被撤销');
      const verdict = tickets.verifyChallenge(b64d(device.pubKey, 'pubKey'), session.deviceId, challenge, sig, ts);
      if (!verdict.ok) {
        audit?.({ kind: 'pair.reject', deviceId: session.deviceId, detail: { reason: verdict.reason } });
        throw new PairingError('pair/verify-failed', `挑战验证失败：${verdict.reason}`);
      }
      const ticket = tickets.issue(session.deviceId);
      audit?.({ kind: 'pair.success', deviceId: session.deviceId, detail: { name: device.name } });
      pending.delete(session.token);
      // ★ claim 凭证原件：手机私钥对 (challenge ‖ connectorId ‖ ts) 的签名 ——
      //   配对那一刻「该设备属于本连接器」的密码学事实。连接器应把它转交中继
      //   （device-claim 帧），中继验签后持久化归属（Pair-Proof，2026-10-02）。
      //   challenge 原样带上（b64url 字符串），中继无需解析即可复验绑定关系。
      return {
        deviceId: session.deviceId,
        ticket,
        code: session.code,
        setCookie: deviceCookie('ra-device', ticket, 12 * 3600, secureCookies),
        claim: { deviceId: session.deviceId, pubKey: device.pubKey, sig, ts, challenge }
      };
    },

    /** 销毁全部未完成配对（kill switch）。 */
    abortAll() {
      const n = pending.size;
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
