/**
 * 设备公钥 ACL（方案 §6.1）。
 *
 * 服务端只存公钥 + 元数据 + 撤销位，不存任何私钥。
 * 存储：devices.json，0600，原子写（tmp+rename）；损坏 JSON → 视为空 ACL 并告警，
 * 绝不抛（宁可断开所有设备，也不能让 ACL 读失败拖垮代理路径）。
 * deviceId = base64url(sha256(pubKey)).slice(0, 22)，公开可暴露。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { b64d, b64e } from '../transport/frames.js';

const FILE_NAME = 'devices.json';
const SCHEMA_VERSION = 1;

/** 由设备公钥推 deviceId（公开标识）。 */
export function deviceIdFromPublicKey(pubRaw) {
  return b64e(createHash('sha256').update(Buffer.from(pubRaw)).digest()).slice(0, 22);
}

export class DeviceStore {
  #file;
  #devices = new Map(); // deviceId → entry
  #logger;

  constructor(dataDir, logger) {
    this.#file = path.join(dataDir, FILE_NAME);
    this.#logger = logger;
  }

  /** 读盘；损坏/缺失一律得到可用状态（损坏时空表 + 告警）。 */
  async load() {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.#file, 'utf8'));
      this.#devices.clear();
      if (parsed && parsed.version === SCHEMA_VERSION && Array.isArray(parsed.devices)) {
        for (const entry of parsed.devices) {
          if (entry && typeof entry.deviceId === 'string' && typeof entry.pubKey === 'string') {
            this.#devices.set(entry.deviceId, entry);
          }
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.#devices.clear();
        this.#logger?.warn?.(`[kite] devices.json unreadable (${error.message}); starting from empty ACL`);
      }
    }
    return this;
  }

  #snapshot() {
    return JSON.stringify({ version: SCHEMA_VERSION, devices: [...this.#devices.values()] }, null, 1);
  }

  async #persist() {
    const tmp = `${this.#file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, this.#snapshot(), { mode: 0o600 });
    await fsp.rename(tmp, this.#file);
    try {
      await fsp.chmod(this.#file, 0o600);
    } catch {
      /* Windows 忽略 */
    }
  }

  list() {
    return [...this.#devices.values()].map((entry) => ({ ...entry }));
  }

  get(deviceId) {
    const entry = this.#devices.get(deviceId);
    return entry ? { ...entry } : undefined;
  }

  /** 注册/更新设备（配对完成时调用）。同名设备重复配对 = 覆盖公钥（换机场景）。 */
  async upsert({ pubKey, name, kind }) {
    const pubRaw = b64d(pubKey, 'pubKey');
    const deviceId = deviceIdFromPublicKey(pubRaw);
    const now = Date.now();
    const prev = this.#devices.get(deviceId);
    const entry = {
      deviceId,
      pubKey,
      name: String(name || prev?.name || 'device').slice(0, 80),
      kind: kind || prev?.kind || 'pwa',
      pairedAt: prev?.pairedAt ?? now,
      lastActiveAt: prev?.lastActiveAt ?? now,
      revoked: false
    };
    this.#devices.set(deviceId, entry);
    await this.#persist();
    return { ...entry, created: !prev };
  }

  /** 撤销：位置删除（下一次握手即失败；在线连接由调用方 kick）。 */
  async revoke(deviceId) {
    if (!this.#devices.has(deviceId)) return false;
    this.#devices.delete(deviceId);
    await this.#persist();
    return true;
  }

  async revokeAll() {
    const n = this.#devices.size;
    this.#devices.clear();
    await this.#persist();
    return n;
  }

  async touch(deviceId) {
    const entry = this.#devices.get(deviceId);
    if (!entry) return;
    entry.lastActiveAt = Date.now();
    // 触达不立刻落盘（高频）；由周期 flush 或下次结构变更统一落。
  }

  async flush() {
    await this.#persist();
  }

  /** 设备是否当前有效（未撤销且公钥在册）。 */
  isActive(deviceId) {
    return this.#devices.has(deviceId);
  }

  /** 校验某设备公钥与在册一致（防 ACL 内换钥）。 */
  hasPublicKey(deviceId, pubKey) {
    const entry = this.#devices.get(deviceId);
    if (!entry) return false;
    const a = Buffer.from(entry.pubKey);
    const b = Buffer.from(pubKey);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
