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

/**
 * ★ 配对终态（pairing.last）—— 面板「等待手机提交…」永驻事故的直接回归。
 *
 * 真机事故 2026-10-03（用户截图）：扫码成功、设备已进设备表，红框里仍是「等待手机提交…」。
 * 根因：list() 只含进行中会话，成功那一刻 complete() 就把会话删了 —— 面板能观察到的
 * 只有「条目消失」，无法区分成功 / 失败 / 过期。下面逐条钉住四种终态都必须留痕，
 * 否则面板就又只能瞎猜（或永远停在初始文案）。
 */

test('★ 终态：配对成功必须留痕（list 已空，面板只能靠它翻成「✓ 配对成功」）', async () => {
  const { keys, pairing } = await fixture();
  const { token, expiresAt } = pairing.begin({ name: '我的手机' });
  const device = deviceKeypair();
  const { challenge, deviceId } = await pairing.submit({ token, pubKey: device.pubB64, name: '我的手机' });
  const ts = Date.now();
  const sig = b64e(sign(null, Buffer.concat([Buffer.from(challenge), Buffer.from(keys.fingerprint), Buffer.from(String(ts))]), device.privateKey));
  await pairing.complete({ challenge, sig, ts });

  assert.equal(pairing.list().length, 0, '完成后会话即从 pending 移除（这正是旧面板失明的时刻）');
  const last = pairing.last();
  assert.equal(last.ok, true, '成功必须留痕');
  assert.equal(last.reason, 'done');
  assert.equal(last.deviceId, deviceId);
  assert.equal(last.name, '我的手机', '面板要显示设备名');
  // tokenMasked/tokenMasks 必须与 begin 后 list() 的格式一致 —— 面板靠它把终态认领到本次配对。
  const expectMask = `${token.slice(0, 6)}…${token.slice(-4)}`;
  assert.equal(last.tokenMasked, expectMask);
  assert.deepEqual(last.tokenMasks, [expectMask], '认领标记必须是数组，面板两者取或');
  assert.ok(Number.isFinite(last.at) && last.at > 0, '终态必须带时间戳');
  assert.ok(expiresAt > 0);
});

test('★ 终态：验签失败留痕为 rejected（不得静默，否则面板停在「等待手机提交…」）', async () => {
  const { pairing } = await fixture();
  const { token } = pairing.begin({ name: 'bad-sig' });
  const device = deviceKeypair();
  const { challenge } = await pairing.submit({ token, pubKey: device.pubB64, name: 'bad-sig' });
  await assert.rejects(() => pairing.complete({ challenge, sig: 'not-a-signature', ts: Date.now() }), /挑战验证失败/);

  const last = pairing.last();
  assert.equal(last.ok, false);
  assert.equal(last.reason, 'rejected');
  assert.ok(last.detail, '失败要给原因，面板才能给出可操作的提示');
  assert.deepEqual(last.tokenMasks, [`${token.slice(0, 6)}…${token.slice(-4)}`]);
});

test('★ 终态：二维码过期留痕为 expired（等 120 秒后不能什么都不说）', async () => {
  const { keys, pairing } = await fixture();
  assert.equal(pairing.last(), null, '没发生任何事时 last() 必须是 null（面板据此不误报）');
  pairing.begin({ name: 'still-pending' });

  // 不 sleep 120 秒：另起一个 5ms TTL 的实例来走真实过期路径（sweep 在 list 里）。
  const shortLived = createPairingService({ keys, tickets: null, devices: null, ttlMs: 5, audit: () => {} });
  const s = shortLived.begin({ name: 'ttl-short' });
  await new Promise((r) => setTimeout(r, 20));
  shortLived.list(); // 触发 sweep → 记录过期终态

  const last = shortLived.last();
  assert.equal(last.ok, false, '过期必须留痕，否则面板只能停在「等待手机提交…」');
  assert.equal(last.reason, 'expired');
  assert.equal(last.name, 'ttl-short');
  assert.deepEqual(last.tokenMasks, [`${s.token.slice(0, 6)}…${s.token.slice(-4)}`]);

  assert.equal(shortLived.list().length, 0, '过期条目已清除');
  assert.equal(pairing.last(), null, '另一个实例的过期不得影响本实例');
  assert.equal(pairing.list().length, 1, '本实例会话仍在进行中');
});

test('★ 终态：abortAll（kill switch）留痕为 aborted，且带上被清会话的认领标记', async () => {
  const { pairing } = await fixture();
  const a = pairing.begin({ name: 'killed-a' });
  const b = pairing.begin({ name: 'killed-b' });
  assert.equal(pairing.abortAll(), 2);
  const last = pairing.last();
  assert.equal(last.ok, false);
  assert.equal(last.reason, 'aborted');
  assert.equal(last.count, 2);
  // ★ 批量终局必须列出**全部**被清会话的遮罩：否则被清掉的那条会话所属面板
  //   认领不到终态，仍会停在「等待手机提交…」（kill switch 场景的同一个 bug）。
  assert.deepEqual(
    last.tokenMasks.slice().sort(),
    [`${a.token.slice(0, 6)}…${a.token.slice(-4)}`, `${b.token.slice(0, 6)}…${b.token.slice(-4)}`].sort()
  );
  // 未发起任何配对时 abortAll 不留痕（n=0）。
  const fresh = createPairingService({ keys: (await fixture()).keys, tickets: null, devices: null, ttlMs: 1000, audit: () => {} });
  assert.equal(fresh.abortAll(), 0);
  assert.equal(fresh.last(), null, '无会话被清时不得伪造终态');
});

test('★ 终态：多条会话同时过期，全部遮罩都在 tokenMasks 里', async () => {
  const { keys } = await fixture();
  const p = createPairingService({ keys, tickets: null, devices: null, ttlMs: 5, audit: () => {} });
  const a = p.begin({ name: 'exp-a' });
  const b = p.begin({ name: 'exp-b' });
  await new Promise((r) => setTimeout(r, 20));
  p.list(); // 触发 sweep
  const last = p.last();
  assert.equal(last.reason, 'expired');
  assert.deepEqual(
    last.tokenMasks.slice().sort(),
    [`${a.token.slice(0, 6)}…${a.token.slice(-4)}`, `${b.token.slice(0, 6)}…${b.token.slice(-4)}`].sort()
  );
});

test('★ 终态：先到的失败不得挡住后到的成功（乱序/重试场景）', async () => {
  const { keys, pairing } = await fixture();
  const { token } = pairing.begin({ name: 'retry' });
  const device = deviceKeypair();
  const { challenge } = await pairing.submit({ token, pubKey: device.pubB64, name: 'retry' });

  // ① 手机重发了一次 begin（同 token 二次提交）→ 记一条 'reused' 失败终态。
  //    会话**仍在 pending**（挑战已发），这不是终局。
  await assert.rejects(() => pairing.submit({ token, pubKey: device.pubB64, name: 'retry' }), PairingError);
  assert.equal(pairing.last().ok, false, '重复提交应先记失败');
  assert.equal(pairing.last().reason, 'reused');

  // ② 手机随后用第一次拿到的挑战正常签名完成 → 必须覆盖成成功。
  const ts = Date.now();
  const sig = b64e(sign(null, Buffer.concat([Buffer.from(challenge), Buffer.from(keys.fingerprint), Buffer.from(String(ts))]), device.privateKey));
  await pairing.complete({ challenge, sig, ts });

  const last = pairing.last();
  assert.equal(last.ok, true, '后到的成功必须覆盖先到的失败（否则面板误报「未完成」）');
  assert.equal(last.reason, 'done');
  assert.equal(last.name, 'retry');
});
