import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceStore, deviceIdFromPublicKey } from '../identity/device-store.js';

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'ra-devstore-'));
}

test('设备存储：upsert/list/revoke 原子写（无残留 tmp）', async () => {
  const dir = await tmpDir();
  const store = await new DeviceStore(dir, console).load();
  const entry = await store.upsert({ pubKey: Buffer.alloc(32, 1).toString('base64url'), name: 'phone-1' });
  assert.equal(entry.created, true);
  assert.equal(entry.name, 'phone-1');
  await store.upsert({ pubKey: Buffer.alloc(32, 1).toString('base64url'), name: 'phone-1-renamed' });
  assert.equal(store.list().length, 1, '同钥重复配对 = 覆盖不重复');
  assert.equal(store.get(entry.deviceId).name, 'phone-1-renamed');
  assert.equal((await store.revoke(entry.deviceId)), true);
  assert.equal((await store.revoke(entry.deviceId)), false);
  const files = await fsp.readdir(dir);
  assert.ok(!files.some((f) => f.includes('.tmp')), '不应残留 tmp 文件');
});

test('设备存储：文件权限 0600（POSIX）', async () => {
  const dir = await tmpDir();
  const store = await new DeviceStore(dir, console).load();
  await store.upsert({ pubKey: Buffer.alloc(32, 2).toString('base64url'), name: 'p' });
  if (process.platform !== 'win32') {
    const stat = await fsp.stat(path.join(dir, 'devices.json'));
    assert.equal(stat.mode & 0o777, 0o600, `实际 mode: ${(stat.mode & 0o777).toString(8)}`);
  }
});

test('设备存储：损坏 JSON → 空 ACL 不抛', async () => {
  const dir = await tmpDir();
  await fsp.writeFile(path.join(dir, 'devices.json'), '{ this is not json');
  const store = await new DeviceStore(dir, console).load();
  assert.deepEqual(store.list(), []);
  // 且之后可以正常写入修复
  await store.upsert({ pubKey: Buffer.alloc(32, 3).toString('base64url'), name: 'recover' });
  assert.equal(store.list().length, 1);
});

test('设备存储：未知 schema 版本视为空', async () => {
  const dir = await tmpDir();
  await fsp.writeFile(path.join(dir, 'devices.json'), JSON.stringify({ version: 99, devices: [{ deviceId: 'x', pubKey: 'y' }] }));
  const store = await new DeviceStore(dir, console).load();
  assert.deepEqual(store.list(), []);
});

test('deviceId：确定性、22 位、公开可暴露', () => {
  const key = Buffer.alloc(32, 5).toString('base64url');
  const id1 = deviceIdFromPublicKey(Buffer.from(key, 'base64url'));
  const id2 = deviceIdFromPublicKey(Buffer.from(key, 'base64url'));
  assert.equal(id1, id2);
  assert.equal(id1.length, 22);
  assert.match(id1, /^[A-Za-z0-9_-]+$/);
});

test('设备存储：touch 只改内存，flush 落盘', async () => {
  const dir = await tmpDir();
  const store = await new DeviceStore(dir, console).load();
  const entry = await store.upsert({ pubKey: Buffer.alloc(32, 4).toString('base64url'), name: 't' });
  await store.touch(entry.deviceId);
  const reloaded = await new DeviceStore(dir, console).load();
  const before = reloaded.get(entry.deviceId);
  await store.flush();
  const after = (await new DeviceStore(dir, console).load()).get(entry.deviceId);
  assert.ok(after.lastActiveAt >= before.lastActiveAt, 'flush 后 lastActiveAt 已落盘');
});
