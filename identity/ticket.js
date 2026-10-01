/**
 * 会话票据 + 挑战 nonce（方案 §6.3）。
 *
 * - 无长期 bearer：手机不持有可长期盗用的令牌；票据 12h（可配），仅存内存/cookie。
 * - 每次连接：Connector 发 32B nonce，手机 Ed25519 签 `nonce ‖ connectorId ‖ ts`；
 *   验签 + ts ∈ ±60s + nonce 未用过（LRU 1024）。
 * - 撤销即时生效：ACL 删公钥后，下一次握手失败；在线连接由调用方主动 kick。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { b64d, b64e } from '../transport/frames.js';

const NONCE_LRU_CAPACITY = 1024;
const TIMESTAMP_TOLERANCE_MS = 60_000;

/** 定容 FIFO LRU（nonce 查重）。 */
export class NonceLru {
  #capacity;
  #seen;
  #order;
  constructor(capacity = NONCE_LRU_CAPACITY) {
    this.#capacity = capacity;
    this.#seen = new Set();
    this.#order = [];
  }
  /** true = 首次出现（并登记）；false = 重复。 */
  add(nonceHex) {
    if (this.#seen.has(nonceHex)) return false;
    this.#seen.add(nonceHex);
    this.#order.push(nonceHex);
    while (this.#order.length > this.#capacity) {
      this.#seen.delete(this.#order.shift());
    }
    return true;
  }
  get size() {
    return this.#seen.size;
  }
}

/** 新的 32B 挑战 nonce（b64url）。 */
export function newChallenge() {
  return b64e(randomBytes(32));
}

/**
 * 构造票据签发/校验器。
 * keys: identity/keys.js 的返回值；ttlMs: 票据有效期。
 */
export function createTicketService(keys, ttlMs, logger) {
  return {
    /** 签发 {deviceId} → cookie 值（`v1.<payload>.<sig>`）。 */
    issue(deviceId) {
      const now = Date.now();
      return keys.signPayload({ deviceId, iat: now, exp: now + ttlMs });
    },
    /** 校验 cookie/ticket：签名、有效期、字段完整。返回 deviceId | null。 */
    verify(token) {
      const payload = keys.verifyPayload(token);
      if (!payload) return null;
      const { deviceId, iat, exp } = payload;
      if (typeof deviceId !== 'string' || deviceId.length === 0) return null;
      const now = Date.now();
      if (typeof iat !== 'number' || typeof exp !== 'number') return null;
      if (iat > now + TIMESTAMP_TOLERANCE_MS) return null;
      if (exp <= now) return null;
      if (exp <= iat || exp - iat > ttlMs + TIMESTAMP_TOLERANCE_MS) return null;
      return deviceId;
    },
    /**
     * 校验设备挑战应答：`sig(nonce ‖ connectorId ‖ ts)`。
     * 返回 {ok:true, deviceId} | {ok:false, reason}。
     */
    verifyChallenge(devicePubRaw, deviceId, challengeB64, sigB64, ts) {
      const expectedChallenge = Buffer.from(String(challengeB64 ?? ''));
      const connectorIdMsg = Buffer.from(keys.fingerprint);
      if (typeof ts !== 'number' || Math.abs(Date.now() - ts) > TIMESTAMP_TOLERANCE_MS) {
        return { ok: false, reason: 'timestamp out of tolerance' };
      }
      const message = Buffer.concat([expectedChallenge, connectorIdMsg, Buffer.from(String(ts))]);
      if (!keys.verifyDeviceSignature(devicePubRaw, message, sigB64)) {
        return { ok: false, reason: 'signature verify failed' };
      }
      const nonceHex = b64d(challengeB64, 'challenge').toString('hex');
      if (!this.nonces.add(nonceHex)) {
        return { ok: false, reason: 'nonce replayed' };
      }
      return { ok: true, deviceId };
    },
    nonces: new NonceLru()
  };
}

/** 常量导出（测试用）。 */
export const TIMING = { TIMESTAMP_TOLERANCE_MS };
export { timingSafeEqual };
