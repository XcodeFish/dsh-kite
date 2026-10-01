import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConnectorKeys } from '../identity/keys.js';
import { createTicketService, NonceLru, newChallenge, TIMING } from '../identity/ticket.js';
import { DeviceStore } from '../identity/device-store.js';
import { generateKeyPairSync, sign } from 'node:crypto';
import { b64e } from '../transport/frames.js';

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'ra-test-'));
}

async function fixture() {
  const dir = await tmpDir();
  const keys = await loadConnectorKeys(dir);
  const store = await new DeviceStore(dir, console).load();
  const tickets = createTicketService(keys, 12 * 3600_000, console);
  return { dir, keys, store, tickets };
}

function deviceKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return { publicRaw: spki.subarray(spki.length - 32), privateKey };
}

function signChallenge(device, challengeB64, connectorFingerprint, ts) {
  const msg = Buffer.concat([Buffer.from(challengeB64), Buffer.from(connectorFingerprint), Buffer.from(String(ts))]);
  return b64e(sign(null, msg, device.privateKey));
}

test('票据：签发→校验通过，deviceId 正确', async () => {
  const { tickets } = await fixture();
  const token = tickets.issue('device-1');
  assert.equal(tickets.verify(token), 'device-1');
});

test('票据：篡改 / 换钥签名 / 垃圾输入全部拒绝', async () => {
  const { keys, tickets } = await fixture();
  const token = tickets.issue('device-1');
  const parts = token.split('.');
  assert.equal(tickets.verify(`v1.${parts[1]}.${b64e(Buffer.alloc(64))}`), null, '坏签名');
  assert.equal(tickets.verify('garbage'), null);
  assert.equal(tickets.verify('v1.!!!.???'), null);
  // 其它密钥签的票
  const otherDir = await tmpDir();
  const otherKeys = await loadConnectorKeys(otherDir);
  const foreign = createTicketService(otherKeys, 12 * 3600_000, console).issue('device-1');
  assert.equal(tickets.verify(foreign), null, '外部签发的票不被接受');
  void keys;
});

test('票据：过期票拒绝', async () => {
  const { dir, store } = await fixture();
  const keys = await loadConnectorKeys(dir);
  const shortTtl = createTicketService(keys, 1000, console); // 1s
  const token = shortTtl.issue('device-1');
  assert.equal(shortTtl.verify(token), 'device-1');
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(shortTtl.verify(token), null, '过期');
  void store;
});

test('挑战应答：正确签名通过；nonce 重放被拒；时间偏移被拒', async () => {
  const { keys, store, tickets } = await fixture();
  const device = deviceKeypair();
  const entry = await store.upsert({ pubKey: b64e(device.publicRaw), name: 'p1' });
  const challenge = newChallenge();
  const ts = Date.now();
  const sig = signChallenge(device, challenge, keys.fingerprint, ts);
  const ok = tickets.verifyChallenge(device.publicRaw, entry.deviceId, challenge, sig, ts);
  assert.equal(ok.ok, true, `首验应通过: ${JSON.stringify(ok)}`);
  const replay = tickets.verifyChallenge(device.publicRaw, entry.deviceId, challenge, sig, ts);
  assert.equal(replay.ok, false, 'nonce 重放');
  assert.match(replay.reason, /replay/);
  const stale = tickets.verifyChallenge(device.publicRaw, entry.deviceId, newChallenge(), signChallenge(device, challenge, keys.fingerprint, ts - TIMING.TIMESTAMP_TOLERANCE_MS * 2), ts - TIMING.TIMESTAMP_TOLERANCE_MS * 2);
  assert.equal(stale.ok, false, '过期时间戳');
  const forged = tickets.verifyChallenge(device.publicRaw, entry.deviceId, newChallenge(), sig, Date.now());
  assert.equal(forged.ok, false, '错误签名（挑战不匹配）');
});

test('NonceLru：容量淘汰后同一 nonce 可再次登记（容量语义）', () => {
  const lru = new NonceLru(3);
  assert.equal(lru.add('a'), true);
  assert.equal(lru.add('a'), false);
  lru.add('b');
  lru.add('c');
  lru.add('d'); // 淘汰 a
  assert.equal(lru.add('a'), true);
  assert.equal(lru.size, 3);
});

test('撤销后票据立即失效（isActive 判定）', async () => {
  const { store, tickets } = await fixture();
  const token = tickets.issue('device-x');
  assert.equal(tickets.verify(token), 'device-x');
  await store.upsert({ pubKey: b64e(new Uint8Array(32).fill(7)), name: 'x' });
  // 未注册的设备仍能过票据验签，但调用方必须再查 isActive —— 契约见 relay-client#resolveDevice
  assert.equal(store.isActive('device-x'), false, '未注册设备不在 ACL');
  const entry = await store.upsert({ pubKey: b64e(new Uint8Array(32).fill(9)), name: 'y' });
  assert.equal(store.isActive(entry.deviceId), true);
  await store.revoke(entry.deviceId);
  assert.equal(store.isActive(entry.deviceId), false, '撤销后立即失效');
});
