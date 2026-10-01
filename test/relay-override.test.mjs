import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayOverrideStore } from '../admin/panel.js';

async function tmpStore() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kite-override-'));
  return { dir, store: new RelayOverrideStore(dir) };
}

test('relay-override：写入 0600、读回一致、载入一致', async () => {
  const { dir, store } = await tmpStore();
  const saved = await store.set({ relayUrl: 'wss://relay.example', relayPublicUrl: 'https://relay.example', relayToken: 'tok-123' });
  assert.equal(saved.relayUrl, 'wss://relay.example');
  assert.equal(saved.relayToken, 'tok-123');
  assert.equal(typeof saved.changedAt, 'number');
  const stat = await fsp.stat(path.join(dir, 'relay-override.json'));
  if (process.platform !== 'win32') {
    assert.equal(stat.mode & 0o777, 0o600, `权限 ${(stat.mode & 0o777).toString(8)} 应为 600`);
  }
  // 新实例从盘上载入同一份数据
  const second = new RelayOverrideStore(dir);
  const loaded = await second.load();
  assert.equal(loaded.relayUrl, 'wss://relay.example');
  assert.equal(loaded.relayToken, 'tok-123');
});

test('relay-override：文件缺失或损坏 = 无覆盖（静默回退，不引入新容错模型）', async () => {
  const { dir, store } = await tmpStore();
  assert.equal(await store.load(), null, '缺失 → null');
  assert.equal(store.get(), null);
  await fsp.writeFile(path.join(dir, 'relay-override.json'), '{{{garbage');
  const broken = new RelayOverrideStore(dir);
  assert.equal(await broken.load(), null, '损坏 JSON → null');
  await fsp.writeFile(path.join(dir, 'relay-override.json'), '"just a string"');
  const weird = new RelayOverrideStore(dir);
  assert.equal(await weird.load(), null, '非对象 → null');
});

test('relay-override：删文件即回退（无迁移、无版本历史）', async () => {
  const { dir, store } = await tmpStore();
  await store.set({ relayUrl: 'wss://relay.example', relayPublicUrl: '', relayToken: 'tok' });
  assert.equal(store.get()?.relayUrl, 'wss://relay.example');
  await store.clear();
  assert.equal(store.get(), null);
  await fsp.access(path.join(dir, 'relay-override.json')).then(
    () => assert.fail('文件应已删除'),
    () => {}
  );
  // 清空后再 load → 仍是无覆盖
  const fresh = new RelayOverrideStore(dir);
  assert.equal(await fresh.load(), null);
});

test('relay-override：损坏后重新 set 覆盖恢复（自愈路径）', async () => {
  const { dir, store } = await tmpStore();
  await fsp.writeFile(path.join(dir, 'relay-override.json'), 'garbage');
  await store.load();
  assert.equal(store.get(), null);
  await store.set({ relayUrl: 'wss://fixed.example', relayPublicUrl: '', relayToken: 't' });
  assert.equal(store.get()?.relayUrl, 'wss://fixed.example');
});
