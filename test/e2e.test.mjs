import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateEphemeral,
  importX25519Public,
  ecdhShared,
  handshakeSalt,
  deriveSessionKey,
  seal,
  unseal,
  session,
  CounterState,
  DIR_A_TO_B,
  DIR_B_TO_A
} from '../transport/e2e.js';
import { b64e, b64d } from '../transport/frames.js';

function makePair() {
  const a = generateEphemeral();
  const b = generateEphemeral();
  const nonceA = Buffer.from('nonce-a-16b');
  const nonceB = Buffer.from('nonce-b-16b');
  const shared1 = ecdhShared(a.privateKey, importX25519Public(b.pubRaw));
  const shared2 = ecdhShared(b.privateKey, importX25519Public(a.pubRaw));
  assert.deepEqual(shared1, shared2, 'ECDH 两端共享密钥一致');
  const key = deriveSessionKey(shared1, handshakeSalt(nonceA, nonceB));
  const keyMirror = deriveSessionKey(shared2, handshakeSalt(nonceB, nonceA));
  assert.deepEqual(key, keyMirror, 'HKDF salt 字典序归一：两端密钥一致');
  return { key };
}

test('E2E：seal/unseal 往返一致', () => {
  const { key } = makePair();
  const sender = session(key, DIR_A_TO_B);
  const receiver = session(key, DIR_B_TO_A);
  const plaintext = Buffer.from('{"kind":"open","reqId":"r1","method":"POST","path":"/api/session/list"}');
  const sealed = seal(sender, 0, plaintext);
  const out = unseal(receiver, 0, sealed.nonce, sealed.ciphertext);
  assert.deepEqual(out, plaintext);
});

test('E2E：篡改 1 bit 必须解密失败', () => {
  const { key } = makePair();
  const sender = session(key, DIR_A_TO_B);
  const receiver = session(key, DIR_B_TO_A);
  const sealed = seal(sender, 1, Buffer.from('payload'));
  const raw = Buffer.from(b64d(sealed.ciphertext, 'ct'));
  raw[0] ^= 0x01;
  assert.throws(() => unseal(receiver, 1, sealed.nonce, b64e(raw)), /authenticat|decrypt/i);
});

test('E2E：方向绑定（跨方向使用必须失败）', () => {
  const { key } = makePair();
  const sameDirection = session(key, DIR_A_TO_B);
  const sealed = seal(sameDirection, 5, Buffer.from('x'));
  const wrongDir = session(key, DIR_A_TO_B); // 接收方也用了 A→B 方向号
  assert.throws(() => unseal(wrongDir, 5, sealed.nonce, sealed.ciphertext));
});

test('E2E：AAD counter 绑定（换 counter 必须失败）', () => {
  const { key } = makePair();
  const sender = session(key, DIR_A_TO_B);
  const receiver = session(key, DIR_B_TO_A);
  const sealed = seal(sender, 7, Buffer.from('x'));
  assert.throws(() => unseal(receiver, 8, sealed.nonce, sealed.ciphertext));
});

test('E2E：CounterState 单调，重复/回退被拒', () => {
  const cs = new CounterState();
  assert.equal(cs.accept(0), true);
  assert.equal(cs.accept(1), true);
  assert.equal(cs.accept(1), false, '重复');
  assert.equal(cs.accept(0), false, '回退');
  assert.equal(cs.accept(100), true);
  assert.equal(cs.accept(-1), false);
});

test('E2E：每次 seal 的 nonce 不同', () => {
  const { key } = makePair();
  const s = session(key, DIR_A_TO_B);
  const a = seal(s, 1, Buffer.from('x'));
  const b = seal(s, 2, Buffer.from('x'));
  assert.notEqual(a.nonce, b.nonce);
});
