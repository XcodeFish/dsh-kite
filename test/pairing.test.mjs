import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConnectorKeys } from '../identity/keys.js';
import { createTicketService } from '../identity/ticket.js';
import { DeviceStore } from '../identity/device-store.js';
import { createPairingService, verificationCode, PairingError, deviceCookieFrom, deviceCookie } from '../identity/pairing.js';
import { newChallenge } from '../identity/ticket.js';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { b64e } from '../transport/frames.js';

async function fixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ra-pair-'));
  const keys = await loadConnectorKeys(dir);
  const store = await new DeviceStore(dir, console).load();
  const tickets = createTicketService(keys, 12 * 3600_000, console);
  const audits = [];
  const pairing = createPairingService({
    keys,
    tickets,
    devices: store,
    ttlMs: 120_000,
    audit: (entry) => audits.push(entry)
  });
  return { keys, store, tickets, pairing, audits };
}

function deviceKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return { pubB64: b64e(spki.subarray(spki.length - 32)), raw: spki.subarray(spki.length - 32), privateKey };
}

test('配对：完整 happy path（begin → submit → 签名 → complete）', async () => {
  const { keys, pairing, store, tickets } = await fixture();
  const { token } = pairing.begin({ name: '我的手机' });
  const device = deviceKeypair();
  const { challenge, code, deviceId } = await pairing.submit({ token, pubKey: device.pubB64, name: '我的手机' });
  assert.match(code, /^\d{6}$/);
  assert.equal(code, verificationCode(device.pubB64, keys.ed25519.publicB64u), '校验码确定性且两端一致');
  const ts = Date.now();
  const msg = Buffer.concat([Buffer.from(challenge), Buffer.from(keys.fingerprint), Buffer.from(String(ts))]);
  const sig = b64e(sign(null, msg, device.privateKey));
  const done = await pairing.complete({ challenge, sig, ts });
  assert.equal(done.deviceId, deviceId);
  assert.equal(tickets.verify(done.ticket), deviceId, '配对完成即拿到有效票据');
  assert.match(done.setCookie, /^ra-device=v1\./);
  assert.ok(store.isActive(deviceId));
});

test('配对：token 一次性（重放拒绝）', async () => {
  const { pairing } = await fixture();
  const { token } = pairing.begin({});
  const device = deviceKeypair();
  await pairing.submit({ token, pubKey: device.pubB64 });
  await assert.rejects(() => pairing.submit({ token, pubKey: device.pubB64 }), PairingError);
});

test('配对：过期 token 拒绝', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ra-pair2-'));
  const keys = await loadConnectorKeys(dir);
  const store = await new DeviceStore(dir, console).load();
  const tickets = createTicketService(keys, 12 * 3600_000, console);
  const pairing = createPairingService({ keys, tickets, devices: store, ttlMs: 30 });
  const { token } = pairing.begin({});
  await new Promise((r) => setTimeout(r, 40));
  const device = deviceKeypair();
  await assert.rejects(() => pairing.submit({ token, pubKey: device.pubB64 }), PairingError);
});

test('配对：非法公钥拒绝', async () => {
  const { pairing } = await fixture();
  const { token } = pairing.begin({});
  await assert.rejects(() => pairing.submit({ token, pubKey: '!!!not-base64!!!' }), PairingError);
  const { token: t2 } = pairing.begin({});
  await assert.rejects(() => pairing.submit({ token: t2, pubKey: b64e(Buffer.alloc(8)) }), /32 字节/);
});

test('配对：错误签名拒绝', async () => {
  const { pairing } = await fixture();
  const { token } = pairing.begin({});
  const device = deviceKeypair();
  const { challenge } = await pairing.submit({ token, pubKey: device.pubB64 });
  await assert.rejects(() => pairing.complete({ challenge, sig: b64e(Buffer.alloc(64)), ts: Date.now() }), PairingError);
  await assert.rejects(() => pairing.complete({ challenge: newChallenge(), sig: b64e(Buffer.alloc(64)), ts: Date.now() }), PairingError);
});

test('校验码：6 位数字、确定性与敏感性', () => {
  const a = verificationCode('AAA', 'BBB');
  assert.match(a, /^\d{6}$/);
  assert.equal(a, verificationCode('AAA', 'BBB'));
  assert.notEqual(a, verificationCode('AAA', 'CCC'));
  assert.notEqual(a, verificationCode('AAC', 'BBB'));
});

test('设备 cookie 解析：精确名匹配', () => {
  const value = deviceCookie('ra-device', 'v1.abc.sig');
  assert.match(value, /HttpOnly/);
  assert.match(value, /SameSite=Lax/);
  assert.match(value, /Secure/);
  assert.equal(deviceCookieFrom('other=v1.x; ra-device=v1.abc.sig'), 'v1.abc.sig');
  assert.equal(deviceCookieFrom('ra-devicex=v1.abc.sig'), undefined, '不做前缀匹配');
  assert.equal(deviceCookieFrom(undefined), undefined);
});

test('配对：abortAll 清空未完成会话', async () => {
  const { pairing } = await fixture();
  pairing.begin({});
  pairing.begin({});
  assert.equal(pairing.abortAll(), 2);
  assert.equal(pairing.pendingCount(), 0);
});

test('★ 校验码：手机侧本地算法必须与服务端逐字节一致（P1-3 防中继抢配的前提）', () => {
  // 浏览器实现（admin/panel.js 配对页内联脚本）：sha256(devicePubB64 + '|' + connectorPubB64)
  //   取前 3 字节大端 % 1000000，左补零。这里用 Node 复刻同一算法做交叉验证 ——
  //   两处一旦分叉，「两端比对」就退化成「连接器跟自己对账」，中继偷换设备公钥不会被发现。
  const browserSide = (devicePubB64, connectorPubB64) => {
    const digest = createHash('sha256').update(`${devicePubB64}|${connectorPubB64}`).digest();
    const n = ((digest[0] << 16) | (digest[1] << 8) | digest[2]) % 1_000_000;
    return String(n).padStart(6, '0');
  };
  const samples = [
    [b64e(Buffer.from('a'.repeat(32))), 'connector-pub-key-b64u'],
    [b64e(randomBytes(32)), ''],
    [b64e(randomBytes(32)), b64e(randomBytes(32))],
    ['AAAA', 'BBBB']
  ];
  for (const [dev, conn] of samples) {
    assert.equal(browserSide(dev, conn), verificationCode(dev, conn), `两侧算法分叉：${dev}|${conn}`);
  }
});

test('★ 幽灵设备：提交公钥但未完成挑战签名，不得写进设备表（P2）', async () => {
  const { pairing, store } = await fixture();
  const { token } = pairing.begin({ name: 'ghost' });
  const device = deviceKeypair();
  const submitted = await pairing.submit({ token, pubKey: device.pubB64, name: 'ghost' });
  assert.ok(submitted.deviceId, '配对挑战应正常签发');
  assert.equal(store.get(submitted.deviceId), undefined, '未验签前不得落 ACL（否则面板出现永远连不上的幽灵条目）');

  await assert.rejects(
    () => pairing.complete({ challenge: submitted.challenge, sig: 'not-a-signature', ts: Date.now() }),
    /挑战验证失败/
  );
  assert.equal(store.get(submitted.deviceId), undefined, '验签失败同样不得留下设备条目');
  assert.equal(store.list().length, 0, '设备表必须保持干净');
});
