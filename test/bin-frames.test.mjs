/**
 * 二进制承载帧编解码单测（协议 v1 'bin' caps 扩展）。
 *
 * 目的：http-body / http-res-body / ws-data 三类大载荷帧不再 b64+JSON（+33% 膨胀），
 * 改为「JSON 头 + 0x00 + 原始载荷」的 ws 二进制消息。
 * 这里钉死往返正确性、边界（小帧不切/头过大/伪造头）与收益。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeBinFrame, decodeBinFrame, isBinEligible, encodeFrame } from '../transport/frames.js';

test('bin: 大载荷帧往返一致，且线上字节显著小于 JSON 帧', () => {
  const chunk = Buffer.alloc(200 * 1024, 0x7a).toString('base64url');
  const frame = { kind: 'http-res-body', deviceId: 'dev1', streamId: 'st-9', chunk, final: false };

  assert.equal(isBinEligible(frame), true, '200KB 载荷应判定为二进制 eligible');

  const bin = encodeBinFrame(frame);
  const back = decodeBinFrame(bin);
  for (const key of ['kind', 'deviceId', 'streamId', 'final']) {
    assert.equal(back[key], frame[key], `字段 ${key} 往返应一致`);
  }
  assert.equal(back.chunk, frame.chunk, '载荷往返应逐字节一致');

  const jsonLen = Buffer.byteLength(encodeFrame(frame));
  assert.ok(bin.length < jsonLen, `二进制帧（${bin.length}B）应小于 JSON 帧（${jsonLen}B）`);
  // 头开销 = JSON 头 + 1 分隔字节；JSON 帧多出的是 b64 膨胀（×4/3）
  const overhead = bin.length - (200 * 1024);
  assert.ok(overhead < 256, `二进制帧头开销应极小（实测 ${overhead}B）`);
});

test('bin: 小帧不 eligible（JSON 更紧凑），非载荷 kind 永不 eligible', () => {
  const small = { kind: 'http-res-body', deviceId: 'd', streamId: 's', chunk: 'AAAA', final: true };
  assert.equal(isBinEligible(small), false, '小帧不该切二进制');

  const head = { kind: 'http-head', deviceId: 'd', streamId: 's', method: 'GET', path: '/' };
  assert.equal(isBinEligible(head), false, 'http-head 无载荷字段');

  const wsSmall = { kind: 'ws-data', deviceId: 'd', streamId: 's', fin: true, opcode: 1, data: 'aGk=' };
  assert.equal(isBinEligible(wsSmall), false, '小 ws-data 不该切二进制');
});

test('bin: 三类载荷 kind 全部可往返（http-body / http-res-body / ws-data）', () => {
  const payload = Buffer.alloc(64 * 1024, 0x33).toString('base64url');
  const frames = [
    { kind: 'http-body', deviceId: 'd1', streamId: 's1', chunk: payload, final: true },
    { kind: 'http-res-body', deviceId: 'd2', streamId: 's2', chunk: payload, final: false },
    { kind: 'ws-data', deviceId: 'd3', streamId: 's3', fin: true, opcode: 2, data: payload }
  ];
  for (const f of frames) {
    assert.equal(isBinEligible(f), true, `${f.kind} 应 eligible`);
    const back = decodeBinFrame(encodeBinFrame(f));
    const field = f.kind === 'ws-data' ? 'data' : 'chunk';
    assert.equal(back[field], f[field], `${f.kind} 载荷应逐字节一致`);
    assert.equal(back.streamId, f.streamId);
  }
});

test('bin: 恶意/畸形输入必须拒绝而非解析出意外帧', () => {
  const payload = Buffer.alloc(8 * 1024, 0x11).toString('base64url');
  // 伪造：头里携带载荷字段（想绕过 exactKeys 或注入双重载荷）
  const forgedHead = JSON.stringify({ kind: 'http-body', deviceId: 'd', streamId: 's', chunk: 'QQ==', final: true });
  const forged = Buffer.concat([Buffer.from(forgedHead), Buffer.from([0]), Buffer.from(payload)]);
  assert.throws(() => decodeBinFrame(forged), /must not carry/, '头里带载荷字段应被拒绝');

  // 未知 kind
  const badKind = Buffer.concat([Buffer.from(JSON.stringify({ kind: 'hello' })), Buffer.from([0]), Buffer.from('x')]);
  assert.throws(() => decodeBinFrame(badKind), /non-binary kind/, '非载荷 kind 应被拒绝');

  // 无分隔符 / 头过大
  assert.throws(() => decodeBinFrame(Buffer.from('no-separator-here')), /separator/);
  const hugeHead = Buffer.concat([Buffer.alloc(8192, 0x61), Buffer.from([0]), Buffer.from('x')]);
  assert.throws(() => decodeBinFrame(hugeHead), /separator|too large/, '超大头应被拒绝');

  // 非法 JSON 头
  const badJson = Buffer.concat([Buffer.from('{oops'), Buffer.from([0]), Buffer.from('x')]);
  assert.throws(() => decodeBinFrame(badJson), /valid JSON/);
});

test('bin: 空载荷帧仍走 JSON（isBinEligible=false），但编解码器本身支持空载荷', () => {
  // final 空帧（连接器以空 chunk + final 收尾）不该被切二进制
  const empty = { kind: 'http-res-body', deviceId: 'd', streamId: 's', chunk: '', final: true };
  assert.equal(isBinEligible(empty), false);
});
