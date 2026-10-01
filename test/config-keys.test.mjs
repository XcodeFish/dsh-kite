import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, defaultDataDir, legacyDataDir, migrateLegacyDataDir } from '../index.js';
import { loadConnectorKeys } from '../identity/keys.js';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('配置：默认值与钳制', () => {
  const cfg = readConfig({});
  assert.equal(cfg.relayUrl, '');
  assert.equal(cfg.remoteAgentPreset, 'default');
  assert.deepEqual(cfg.allowedAgentPresets, ['default']);
  assert.equal(cfg.allowTerminal, false);
  assert.equal(cfg.allowUpload, false);
  assert.equal(cfg.pairingTtlSeconds, 120);
  assert.equal(cfg.ticketTtlHours, 12);
  const clamped = readConfig({ pairingTtlSeconds: 1, ticketTtlHours: 9999 });
  assert.equal(clamped.pairingTtlSeconds, 30, '下限钳制');
  assert.equal(clamped.ticketTtlHours, 720, '上限钳制');
});

test('配置：非 wss:// 的 relayUrl 被丢弃（防误配 http）', () => {
  assert.equal(readConfig({ relayUrl: 'http://x.example' }).relayUrl, '');
  assert.equal(readConfig({ relayUrl: 'wss://x.example' }).relayUrl, 'wss://x.example');
  assert.equal(readConfig({ relayUrl: 'wss://x.example/' }).relayUrl, 'wss://x.example');
});

test('配置：relayPublicUrl 派生（wss → https）', () => {
  assert.equal(readConfig({ relayUrl: 'wss://x.example' }).relayPublicUrl, 'https://x.example');
  assert.equal(readConfig({ relayUrl: 'ws://127.0.0.1:8787' }).relayPublicUrl, 'http://127.0.0.1:8787');
  assert.equal(readConfig({ relayUrl: 'wss://x', relayPublicUrl: 'https://custom' }).relayPublicUrl, 'https://custom');
});

test('配置：env 覆盖优先于 patch config', () => {
  const prev = process.env.DSH_KITE_RELAY_URL;
  process.env.DSH_KITE_RELAY_URL = 'wss://env.example';
  try {
    assert.equal(readConfig({ relayUrl: 'wss://patch.example' }).relayUrl, 'wss://env.example');
  } finally {
    if (prev === undefined) delete process.env.DSH_KITE_RELAY_URL;
    else process.env.DSH_KITE_RELAY_URL = prev;
  }
});

test('配置：四级优先级 env > override > patch > default（HANDOVER §5.3）', () => {
  const prevUrl = process.env.DSH_KITE_RELAY_URL;
  const prevToken = process.env.DSH_KITE_RELAY_TOKEN;
  delete process.env.DSH_KITE_RELAY_URL;
  delete process.env.DSH_KITE_RELAY_TOKEN;
  try {
    // override > patch
    const withOverride = readConfig({ relayUrl: 'wss://patch.example', relayToken: 'patch-token' }, { relayUrl: 'wss://override.example', relayToken: '', relayPublicUrl: 'https://override.example' });
    assert.equal(withOverride.relayUrl, 'wss://override.example');
    assert.equal(withOverride.relayPublicUrl, 'https://override.example');
    // override 令牌留空 = 沿用 patch 的令牌
    assert.equal(withOverride.relayToken, 'patch-token');
    assert.deepEqual(withOverride.__sources, { relayUrl: 'override', relayToken: 'patch', relayPublicUrl: 'override' });
    // 无 override 时 patch 生效
    const patchOnly = readConfig({ relayUrl: 'wss://patch.example' });
    assert.equal(patchOnly.relayUrl, 'wss://patch.example');
    assert.equal(patchOnly.__sources.relayUrl, 'patch');
    // 都没有 → 默认
    assert.equal(readConfig({}).relayUrl, '');
    assert.equal(readConfig({}).__sources.relayUrl, 'default');
    // env 最高
    process.env.DSH_KITE_RELAY_URL = 'wss://env.example';
    const withEnv = readConfig({ relayUrl: 'wss://patch.example' }, { relayUrl: 'wss://override.example' });
    assert.equal(withEnv.relayUrl, 'wss://env.example');
    assert.equal(withEnv.__sources.relayUrl, 'env');
    // override 地址为空串 → 视为无覆盖（不是「清空配置」）
    delete process.env.DSH_KITE_RELAY_URL;
    const emptyOverride = readConfig({ relayUrl: 'wss://patch.example' }, { relayUrl: '' });
    assert.equal(emptyOverride.relayUrl, 'wss://patch.example');
  } finally {
    if (prevUrl === undefined) delete process.env.DSH_KITE_RELAY_URL;
    else process.env.DSH_KITE_RELAY_URL = prevUrl;
    if (prevToken === undefined) delete process.env.DSH_KITE_RELAY_TOKEN;
    else process.env.DSH_KITE_RELAY_TOKEN = prevToken;
  }
});

test('数据目录：宿主进程无 DSH_PROFILE → default/', () => {
  const prev = process.env.DSH_PROFILE;
  delete process.env.DSH_PROFILE;
  try {
    const dir = defaultDataDir({});
    assert.match(dir, /plugin-data[\\/]dsh-kite[\\/]default$/);
  } finally {
    if (prev !== undefined) process.env.DSH_PROFILE = prev;
  }
});

test('数据目录：配置显式 dataDir 优先', () => {
  assert.equal(defaultDataDir({ dataDir: '/tmp/ra-custom' }), '/tmp/ra-custom');
  assert.equal(legacyDataDir({ dataDir: '/tmp/ra-custom' }), null, '显式 dataDir 不参与更名迁移');
});

test('数据目录：旧目录 dsh-remote-access 一次性迁移（0600 保留、不覆盖新目录）', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'kite-migrate-'));
  const legacyDir = path.join(home, 'plugin-data', 'dsh-remote-access', 'default');
  await fsp.mkdir(legacyDir, { recursive: true });
  await fsp.writeFile(path.join(legacyDir, 'connector-ed25519.json'), '{"k":1}', { mode: 0o600 });
  await fsp.writeFile(path.join(legacyDir, 'devices.json'), '[]', { mode: 0o600 });
  const prevHome = process.env.DSH_HOME;
  const prevProfile = process.env.DSH_PROFILE;
  delete process.env.DSH_PROFILE;
  process.env.DSH_HOME = home;
  try {
    const target = defaultDataDir({});
    assert.match(target, /plugin-data[\\/]dsh-kite[\\/]default$/);
    assert.equal(await migrateLegacyDataDir(target, {}), true, '首次调用执行迁移');
    const stat = await fsp.stat(path.join(target, 'connector-ed25519.json'));
    assert.equal(stat.mode & 0o777, 0o600, '0600 权限原样保留');
    assert.equal(await fsp.stat(path.join(target, 'devices.json')).then(() => true, () => false), true);
    assert.equal(await fsp.stat(legacyDir).then(() => true, () => false), false, '旧目录已让位');
    assert.equal(await migrateLegacyDataDir(target, {}), false, '二次调用不再迁移');
    // 新目录已存在时绝不覆盖
    const legacy2 = legacyDataDir({});
    await fsp.mkdir(legacy2, { recursive: true });
    await fsp.writeFile(path.join(legacy2, 'x'), 'old');
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(path.join(target, 'x'), 'new');
    assert.equal(await migrateLegacyDataDir(target, {}), false, '新目录存在 → 不迁移');
    assert.equal(await fsp.readFile(path.join(target, 'x'), 'utf8'), 'new', '新目录内容未被覆盖');
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    if (prevProfile === undefined) delete process.env.DSH_PROFILE;
    else process.env.DSH_PROFILE = prevProfile;
  }
});

test('连接器密钥：首次生成 + 复载一致 + 0600', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ra-keys-'));
  const first = await loadConnectorKeys(dir);
  assert.equal(first.ed25519.publicRaw.length, 32);
  assert.equal(first.x25519.publicRaw.length, 32);
  assert.equal(first.fingerprint.length, 32);
  const second = await loadConnectorKeys(dir);
  assert.deepEqual(first.ed25519.publicRaw, second.ed25519.publicRaw, '复载同一把钥');
  assert.deepEqual(first.x25519.publicRaw, second.x25519.publicRaw);
  assert.equal(first.fingerprint, second.fingerprint);
  if (process.platform !== 'win32') {
    for (const file of ['connector-ed25519.json', 'connector-x25519.json']) {
      const stat = await fsp.stat(path.join(dir, file));
      assert.equal(stat.mode & 0o777, 0o600, `${file} 权限 ${(stat.mode & 0o777).toString(8)}`);
    }
  }
  // 票据签名工具
  const token = first.signPayload({ a: 1 });
  assert.deepEqual(first.verifyPayload(token), { a: 1 });
  const otherDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ra-keys-other-'));
  const other = await loadConnectorKeys(otherDir);
  assert.equal(other.verifyPayload(token), null, '不同实例的密钥签发不互认');
  assert.equal(first.verifyPayload(token.replace(/.$/, '0')), null, '篡改拒绝');
});

test('连接器密钥：损坏的密钥文件抛错（不静默换钥）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ra-keys2-'));
  await fsp.writeFile(path.join(dir, 'connector-ed25519.json'), 'garbage');
  await assert.rejects(() => loadConnectorKeys(dir));
});
