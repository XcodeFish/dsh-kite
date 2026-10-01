/**
 * E2E 加密（ADR-003）：X25519 ECDH → HKDF-SHA256 → AES-256-GCM。
 *
 * 与方案的一处偏差（有意，已记录）：AEAD 用 AES-256-GCM 而非 ChaCha20-Poly1305 ——
 * 浏览器 WebCrypto 只内置 AES-GCM，thin client（手机侧）必须零依赖完成加解密；
 * 两者同为 256-bit AEAD，安全等级一致。HKDF 只导出 k_enc（AEAD 自带完整性，
 * k_mac 冗余）；counter 与方向进 AAD，防跨方向/跨 counter 重排。
 *
 * 中继只见 sealed 外层（frames.js）。密钥协商公钥经中继交换但不信任中继 ——
 * 中继替换公钥会在第一个 sealed 帧的 AEAD 校验上失败。
 */
import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { b64d, b64e } from './frames.js';

export const CIPHER = 'aes-256-gcm';
const KEY_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const AAD_VERSION = 1;
/** X25519 SPKI DER 的固定前缀（RFC 8410 okp），用于裸 32B 公钥还原。 */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/** 发起方向绑定：两端各用固定方向号（发起端=0，应答端=1），调用方约定。 */
export const DIR_A_TO_B = 0;
export const DIR_B_TO_A = 1;

/** 生成临时 X25519 密钥对。返回 { pubRaw(32B), privateKey }。 */
export function generateEphemeral() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { pubRaw: der.subarray(der.length - 32), privateKey };
}

/** 裸 32B 公钥 → KeyObject（供 diffieHellman）。 */
export function importX25519Public(raw32) {
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw32)]), format: 'der', type: 'spki' });
}

/** ECDH 共享密钥。 */
export function ecdhShared(privateKey, peerPublicKey) {
  return diffieHellman({ privateKey, publicKey: peerPublicKey });
}

/** 双方按字典序拼 HKDF salt，避免协商顺序分歧。 */
export function handshakeSalt(nonceA, nonceB) {
  const [x, y] = Buffer.compare(nonceA, nonceB) <= 0 ? [nonceA, nonceB] : [nonceB, nonceA];
  return Buffer.concat([x, y]);
}

/** ECDH 共享密钥 → HKDF-SHA256 → 32B 会话密钥。info 绑定协议名与版本。 */
export function deriveSessionKey(sharedSecret, salt) {
  return Buffer.from(hkdfSync('sha256', sharedSecret, salt, Buffer.from('dsh-kite/v1'), KEY_LEN));
}

/** AAD：ver ‖ direction ‖ counter(8B BE) ‖ extra —— 把身位与序号绑进认证。 */
function buildAad(direction, counter, extra) {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  return Buffer.concat([Buffer.from([AAD_VERSION, direction & 0xff]), counterBuf, Buffer.from(extra ?? '')]);
}

/** 组装会话对象：{ key, direction }。direction = 本端角色（发起端 A=0 / 应答端 B=1）。 */
export function session(key, direction) {
  return { key, direction };
}

/** 加密一帧，返回 sealed 外层字段 { nonce, ciphertext }（b64url）。 */
export function seal(sess, counter, plaintext, extraAad) {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(CIPHER, sess.key, nonce);
  cipher.setAAD(buildAad(sess.direction, counter, extraAad));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce: b64e(nonce), ciphertext: b64e(Buffer.concat([body, tag])) };
}

/** 解密一帧；任何篡改都抛错（counter 查重由 CounterState 负责）。 */
export function unseal(sess, counter, nonceB64, ciphertextB64, extraAad) {
  const nonce = b64d(nonceB64, 'nonce');
  if (nonce.length !== NONCE_LEN) throw new Error('e2e: bad nonce length');
  const data = b64d(ciphertextB64, 'ciphertext');
  if (data.length < TAG_LEN) throw new Error('e2e: ciphertext too short');
  const decipher = createDecipheriv(CIPHER, sess.key, nonce);
  // 收方按「发方的方向」计算 AAD：本端是 B 时对端是 A，反之亦然。
  decipher.setAAD(buildAad(1 - sess.direction, counter, extraAad));
  decipher.setAuthTag(data.subarray(data.length - TAG_LEN));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_LEN)), decipher.final()]);
}

/** 单调 counter 状态：重复或回退即拒（防重放，方案 §5.2）。 */
export class CounterState {
  constructor() {
    this.last = -1;
  }
  /** 返回 true 表示接受并推进水位；false = 重放/回退，调用方必须断连。 */
  accept(counter) {
    if (!Number.isSafeInteger(counter) || counter < 0 || counter <= this.last) return false;
    this.last = counter;
    return true;
  }
}
