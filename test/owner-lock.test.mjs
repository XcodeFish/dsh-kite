import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireRelayOwnerLock } from '../transport/owner-lock.js';

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'ra-lock-'));
}

test('所有权锁：先到先得，后到待机', async () => {
  const dir = await tmpDir();
  const a = acquireRelayOwnerLock(dir, console);
  assert.equal(a.owned, true);
  const b = acquireRelayOwnerLock(dir, console);
  assert.equal(b.owned, false);
  assert.equal(b.holder, process.pid, 'holder 是持锁进程 pid');
  a.release();
  const c = acquireRelayOwnerLock(dir, console);
  assert.equal(c.owned, true, '释放后可重新获取');
  c.release();
});

test('所有权锁：持锁进程死亡后可被接管', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'relay-owner.lock');
  // 伪造一个已死亡进程的锁
  const { openSync, writeSync, closeSync } = await import('node:fs');
  const fd = openSync(file, 'w');
  writeSync(fd, JSON.stringify({ pid: 999999999, startedAt: Date.now() }));
  closeSync(fd);
  const taker = acquireRelayOwnerLock(dir, console);
  assert.equal(taker.owned, true, '死亡持有者 → 接管');
  taker.release();
  const again = acquireRelayOwnerLock(dir, console);
  assert.equal(again.owned, true);
  again.release();
});

test('所有权锁：损坏锁文件可被接管；release 幂等且不删他人锁', async () => {
  const dir = await tmpDir();
  await fsp.writeFile(path.join(dir, 'relay-owner.lock'), 'not json');
  const a = acquireRelayOwnerLock(dir, console);
  assert.equal(a.owned, true, '损坏锁 → 偷锁成功');
  a.release();
  a.release(); // 幂等
  const b = acquireRelayOwnerLock(dir, console);
  assert.equal(b.owned, true);
  a.release(); // 旧持有者再 release 不应删掉 b 的锁
  const c = acquireRelayOwnerLock(dir, console);
  assert.equal(c.owned, false, 'b 仍持有（a 的重复 release 不误删）');
  b.release();
});
