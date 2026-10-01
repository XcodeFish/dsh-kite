import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, decodeFrame, assertFrame, FrameError, b64e, b64d, MAX_CHUNK_BYTES } from '../transport/frames.js';

test('帧编解码：合法帧往返一致', () => {
  const frame = { kind: 'http-head', deviceId: 'd1', streamId: 's1', method: 'GET', path: '/', headers: { cookie: 'x' } };
  assert.deepEqual(decodeFrame(encodeFrame(frame)), frame);
});

test('帧编解码：多余字段必须被拒（exactKeys）', () => {
  assert.throws(() => encodeFrame({ kind: 'ping', extra: 1 }), FrameError);
  assert.throws(() => decodeFrame('{"kind":"ping","extra":1}'), /unexpected field/);
});

test('帧编解码：未知 kind 是协议错误', () => {
  assert.throws(() => decodeFrame('{"kind":"nope"}'), FrameError);
  assert.throws(() => decodeFrame('{"kind":"nope"}'), /unknown frame kind/);
});

test('帧编解码：缺必填字段被拒', () => {
  assert.throws(() => encodeFrame({ kind: 'http-head', deviceId: 'd1' }), /missing required field/);
});

test('帧编解码：类型错误被拒', () => {
  assert.throws(() => encodeFrame({ kind: 'http-res-head', deviceId: 'd', streamId: 's', status: '200' }), /wrong type/);
});

test('帧编解码：坏 JSON / 超限帧', () => {
  assert.throws(() => decodeFrame('{oops'), FrameError);
  assert.throws(() => decodeFrame('x'.repeat(1024 * 1024 + 1)), /frame exceeds/);
  assert.throws(() => encodeFrame({ kind: 'http-body', deviceId: 'd', streamId: 's', chunk: 'x'.repeat(1024 * 1024), final: true }), /exceeds/);
});

test('b64url 往返与非规范输入拒绝（空串合法 = 空 body chunk）', () => {
  const raw = Buffer.from([0, 1, 2, 250, 251, 255]);
  const encoded = b64e(raw);
  assert.deepEqual(b64d(encoded, 'x'), raw);
  assert.deepEqual(b64d('', 'x'), Buffer.alloc(0), '空串合法（空 body chunk，GET 请求）');
  assert.throws(() => b64d('not*valid', 'x'), FrameError);
});

test('sealed 外层帧形态（中继只见密文字段）', () => {
  const frame = { kind: 'sealed', deviceId: 'd1', counter: 3, nonce: b64e(Buffer.alloc(12)), ciphertext: b64e(Buffer.alloc(16)) };
  assert.deepEqual(decodeFrame(encodeFrame(frame)), frame);
});

test('MAX_CHUNK_BYTES 上限为 256 KiB', () => {
  assert.equal(MAX_CHUNK_BYTES, 256 * 1024);
});
