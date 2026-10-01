import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeClientFrame, ServerFrameParser, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, buildUpgradeHeaders } from '../proxy/ws-codec.js';

test('ws-codec：文本帧往返（含掩码透明性）', () => {
  const payload = Buffer.from('{"type":"client-request","rpcId":"1"}');
  const frame = encodeClientFrame({ opcode: OP_TEXT, payload });
  const parsed = new ServerFrameParser().push(frame);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].payload, payload);
  assert.equal(parsed[0].opcode, OP_TEXT);
  assert.equal(parsed[0].fin, true);
});

test('ws-codec：126/64 位长度分档', () => {
  const mid = Buffer.alloc(500, 7);
  const big = Buffer.alloc(70_000, 9);
  const parser = new ServerFrameParser();
  const parsed = parser.push(Buffer.concat([encodeClientFrame({ opcode: OP_BINARY, payload: mid }), encodeClientFrame({ opcode: OP_BINARY, payload: big })]));
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0].payload, mid);
  assert.deepEqual(parsed[1].payload, big);
});

test('ws-codec：分片到达（chunk 边界无关）', () => {
  const payload = Buffer.alloc(300, 1);
  const frame = encodeClientFrame({ opcode: OP_TEXT, payload });
  const parser = new ServerFrameParser();
  assert.deepEqual(parser.push(frame.subarray(0, 1)), []);
  assert.deepEqual(parser.push(frame.subarray(1, 3)), []);
  const out = parser.push(frame.subarray(3));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].payload, payload);
});

test('ws-codec：控制帧 opcode 保留（close/ping）', () => {
  const parser = new ServerFrameParser();
  const out = parser.push(Buffer.concat([
    encodeClientFrame({ opcode: OP_PING, payload: Buffer.from('hb') }),
    encodeClientFrame({ opcode: OP_CLOSE, payload: Buffer.from([0x03, 0xe8]) })
  ]));
  assert.deepEqual(out.map((f) => f.opcode), [OP_PING, OP_CLOSE]);
});

test('ws-codec：FIN 分片帧（fragmented）保留 fin 位', () => {
  const parser = new ServerFrameParser();
  const out = parser.push(Buffer.concat([
    encodeClientFrame({ fin: false, opcode: OP_TEXT, payload: Buffer.from('he') }),
    encodeClientFrame({ fin: true, opcode: 0, payload: Buffer.from('llo') })
  ]));
  assert.equal(out[0].fin, false);
  assert.equal(out[1].fin, true);
  assert.equal(out[1].opcode, 0);
});

test('buildUpgradeHeaders：必需升级头 + cookie 注入', () => {
  const headers = buildUpgradeHeaders('dsh-auth-x=v1');
  assert.equal(headers.Upgrade, 'websocket');
  assert.match(headers.Connection, /Upgrade/i);
  assert.equal(headers['Sec-WebSocket-Version'], '13');
  assert.equal(headers.cookie, 'dsh-auth-x=v1');
  assert.match(headers['Sec-WebSocket-Key'], /^[A-Za-z0-9+/]{22}==$/);
});

