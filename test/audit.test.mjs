import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../policy/audit.js';
import { KillSwitch } from '../admin/panel.js';

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'ra-audit-'));
}

test('审计：追加 + tail（新→旧）', async () => {
  const dir = await tmpDir();
  const audit = new AuditLog(dir, console);
  audit.append({ kind: 'a', deviceId: 'd1' });
  audit.append({ kind: 'b', deviceId: 'd2' });
  await audit.flush();
  const tail = audit.tail(10);
  assert.equal(tail[0].kind, 'b', 'tail 是新→旧');
  assert.equal(tail[1].kind, 'a');
  const recent = await audit.recent(10);
  assert.equal(recent[0].kind, 'b');
});

test('审计：不落正文——结构只含元数据字段', async () => {
  const dir = await tmpDir();
  const audit = new AuditLog(dir, console);
  const record = audit.append({ kind: 'proxy.forward', deviceId: 'd', method: 'POST', path: '/api/session/prompt', status: 200, bytes: 12 });
  assert.equal(Object.keys(record).includes('body'), false);
  await audit.flush();
  const line = (await fsp.readFile(audit.file, 'utf8')).trim();
  assert.ok(!line.includes('prompt 正文'), '不记录正文');
  assert.match(line, /"kind":"proxy\.forward"/);
});

test('审计：坏行跳过不抛', async () => {
  const dir = await tmpDir();
  await fsp.writeFile(path.join(dir, 'audit.jsonl'), '{"kind":"ok"}\nnot-json\n');
  const audit = new AuditLog(dir, console);
  const recent = await audit.recent(10);
  assert.equal(recent.length, 1);
});

test('kill switch：持久化 + 读回', async () => {
  const dir = await tmpDir();
  const ks = new KillSwitch(dir);
  assert.equal(await ks.load(), false);
  assert.equal(await ks.set(true), true);
  assert.equal(ks.enabled, true);
  const ks2 = new KillSwitch(dir);
  assert.equal(await ks2.load(), true, '重启后保持');
  await ks2.set(false);
  assert.equal((await new KillSwitch(dir).load()), false);
});
