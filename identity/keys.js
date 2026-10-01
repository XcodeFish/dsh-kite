/**
 * 连接器长期密钥：Ed25519（票据签名 + 设备挑战验签）+ X25519（sealed 模式 E2E 静态侧）。
 *
 * 私钥只落数据目录（0600，原子写），永不出机。首次启动自动生成。
 * Cookie/票据格式统一 `v1.<b64url(payload)>.<b64url(sig)>`，sig = Ed25519(canonical(payload))。
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { b64d, b64e } from '../transport/frames.js';

const KEY_FILES = {
  ed25519: 'connector-ed25519.json',
  x25519: 'connector-x25519.json'
};

/** Ed25519/X25519 的 SPKI/PKCS#8 DER 固定前缀（RFC 8410），用于裸 32B 密钥还原。 */
const SPKI_PREFIX = {
  ed25519: Buffer.from('302a300506032b6570032100', 'hex'),
  x25519: Buffer.from('302a300506032b656e032100', 'hex')
};
const PKCS8_PREFIX = {
  ed25519: Buffer.from('302e020100300506032b657004220420', 'hex'),
  x25519: Buffer.from('302e020100300506032b656e04220420', 'hex')
};

async function atomicWrite0600(file, text) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, text, { mode: 0o600 });
  await fsp.rename(tmp, file);
  try {
    await fsp.chmod(file, 0o600);
  } catch {
    /* Windows 无 POSIX 权限位，忽略 */
  }
}

function rawToPublic(kind, raw32) {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX[kind], Buffer.from(raw32)]), format: 'der', type: 'spki' });
}
function rawToPrivate(kind, raw32) {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX[kind], Buffer.from(raw32)]), format: 'der', type: 'pkcs8' });
}

async function loadOrCreate(dataDir, kind) {
  const file = path.join(dataDir, KEY_FILES[kind]);
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (parsed && parsed.kind === kind && typeof parsed.private === 'string' && typeof parsed.public === 'string') {
      const publicRaw = b64d(parsed.public, 'public');
      return { privateKey: rawToPrivate(kind, b64d(parsed.private, 'private')), publicRaw, file };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const pair = generateKeyPairSync(kind);
  const pubDer = pair.publicKey.export({ type: 'spki', format: 'der' });
  const privDer = pair.privateKey.export({ type: 'pkcs8', format: 'der' });
  const publicRaw = pubDer.subarray(pubDer.length - 32);
  await atomicWrite0600(file, JSON.stringify({ kind, private: b64e(privDer.subarray(privDer.length - 32)), public: b64e(publicRaw) }, null, 1));
  return { privateKey: pair.privateKey, publicRaw, file };
}

/**
 * 加载（或生成）连接器密钥。返回：
 * { ed25519:{privateKey,publicRaw,publicB64u}, x25519:{...}, fingerprint,
 *   signPayload(payload)→token, verifyPayload(token)→payload|null,
 *   verifyDeviceSignature(devicePubRaw, challenge, sigB64)→bool }
 */
export async function loadConnectorKeys(dataDir) {
  const ed = await loadOrCreate(dataDir, 'ed25519');
  const x25519 = await loadOrCreate(dataDir, 'x25519');
  const fingerprint = createHash('sha256').update(Buffer.concat([ed.publicRaw, x25519.publicRaw])).digest('hex').slice(0, 32);
  return {
    ed25519: { ...ed, publicB64u: b64e(ed.publicRaw) },
    x25519: { ...x25519, publicB64u: b64e(x25519.publicRaw) },
    fingerprint,
    /** 签名任意 JSON 可序列化 payload → `v1.<body>.<sig>`。 */
    signPayload(payload) {
      const body = b64e(Buffer.from(JSON.stringify(payload)));
      const sig = sign(null, Buffer.from(body), ed.privateKey);
      return `v1.${body}.${b64e(sig)}`;
    },
    /** 校验票据；返回 payload 或 null（格式/签名任意一环不合法都算 null）。 */
    verifyPayload(token) {
      if (typeof token !== 'string') return null;
      const parts = token.split('.');
      if (parts.length !== 3 || parts[0] !== 'v1') return null;
      let body;
      try {
        body = b64d(parts[1], 'payload');
      } catch {
        return null;
      }
      let sig;
      try {
        sig = b64d(parts[2], 'sig');
      } catch {
        return null;
      }
      if (!verify(null, Buffer.from(parts[1]), ed.privateKey, sig)) return null;
      try {
        return JSON.parse(body.toString('utf8'));
      } catch {
        return null;
      }
    },
    /** 验证设备对挑战的 Ed25519 签名（设备公钥来自 ACL）。 */
    verifyDeviceSignature(devicePubRaw, challenge, sigB64) {
      let sig;
      try {
        sig = b64d(sigB64, 'sig');
      } catch {
        return false;
      }
      let pub;
      try {
        pub = rawToPublic('ed25519', devicePubRaw);
      } catch {
        return false;
      }
      return verify(null, Buffer.from(challenge), pub, sig);
    }
  };
}

export { randomBytes };
