/**
 * 下行分片回归（2026-10-01 根治：大会话历史加载失败）。
 *
 * 现场事实：中继在 connector→relay 那一跳传 base64，单帧体积 = ceil(payload/3)*4 + 信封。
 * 本机会话 199 步时 opening snapshot 已 701,529 B 原始 → 过中继 935,522 B，
 * 占中继 1 MiB 硬上限的 89.2%，会话再长就【整条连接被 1009 掐断】。
 *
 * 本测试盯死两件事：
 *   ① 超大 DSH 帧必须被拆成多个信封，且靠 WS 原生分片语义可无损重组
 *      （首个带原 opcode，其余 OP_CONT，只有末片继承 fin）；
 *   ② **每个信封过中继时的体积都必须远小于上限** —— 这一条才是这个 bug 的判据，
 *      只断言「拆了」而不量化体积，测试就没有能力失败。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openLoopbackBridge } from '../proxy/upgrade.js';
import { OP_CONT, OP_TEXT } from '../proxy/ws-codec.js';
import { b64d } from '../transport/frames.js';

/** 中继侧的硬上限与信封开销（与 relay/server.mjs 保持一致）。 */
const RELAY_FRAME_LIMIT = 1024 * 1024;
const ENVELOPE_OVERHEAD = 200;
const wireSize = (b64) => b64.length + ENVELOPE_OVERHEAD;

/** 编一个 server→client 帧（不掩码，RFC6455 要求服务端不掩码）。 */
function encodeServerFrame({ fin = true, opcode = OP_TEXT, payload }) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  return Buffer.concat([header, payload]);
}

/** 起一个完成 upgrade、随后把给定帧推给对端的假 loopback。 */
function startLoopbackServer(frames) {
  const sockets = new Set();
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    for (const frame of frames) socket.write(encodeServerFrame(frame));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, sockets, port: server.address().port }));
  });
}

function stopServer(server, sockets) {
  for (const socket of sockets) {
    try { socket.destroy(); } catch { /* ignore */ }
  }
  try { server.closeAllConnections?.(); } catch { /* ignore */ }
  server.close();
}

/** 跑一次桥，收集所有 onFrame 产物。 */
async function runBridge(frames) {
  const { server, sockets, port } = await startLoopbackServer(frames);
  const seen = [];
  const bridge = openLoopbackBridge(
    { credential: { acquire: async () => ({ base: `http://127.0.0.1:${port}`, cookie: 'dsh-auth-x=1' }) },
      logger: { warn: () => {} }, audit: () => {} },
    { streamId: 'frag-1', path: '/api/remote.mux', onReady: () => {}, onFrame: (m) => seen.push(m), onClose: () => {} }
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  bridge.close();
  await new Promise((resolve) => setTimeout(resolve, 150));
  stopServer(server, sockets);
  return seen;
}

test('下行分片：超大帧被拆开，且每个信封都远小于中继上限', async () => {
  const payload = Buffer.alloc(700 * 1024, 0x61); // 700 KiB，对齐真机 snapshot 的量级
  for (let i = 0; i < payload.length; i += 997) payload[i] = i % 251;
  const seen = await runBridge([{ fin: true, opcode: OP_TEXT, payload }]);

  assert.ok(seen.length > 1, `700 KiB 的帧必须被拆开，实际只产出 ${seen.length} 个信封`);

  // ① 分片语义：首个带原 opcode，其余 OP_CONT，只有末片 fin
  assert.equal(seen[0].opcode, OP_TEXT, '首个分片必须带原 opcode');
  assert.equal(seen[0].fin, false, '首个分片不能带 fin');
  for (let i = 1; i < seen.length - 1; i += 1) {
    assert.equal(seen[i].opcode, OP_CONT, `第 ${i} 个分片必须是 continuation`);
    assert.equal(seen[i].fin, false, `第 ${i} 个分片不能带 fin`);
  }
  assert.equal(seen.at(-1).opcode, OP_CONT, '末片是 continuation');
  assert.equal(seen.at(-1).fin, true, '末片必须继承原来的 fin');

  // ② 无损：解码后拼接必须与原始 payload 逐字节相同
  const rebuilt = Buffer.concat(seen.map((m) => b64d(m.data, 'data')));
  assert.equal(rebuilt.length, payload.length, '重组后长度不符');
  assert.ok(rebuilt.equals(payload), '重组后内容不符（分片切错了）');

  // ③ ★ 判据：每个信封过中继时都必须在限额内，且留有余量
  const sizes = seen.map((m) => wireSize(m.data));
  const worst = Math.max(...sizes);
  assert.ok(
    worst < RELAY_FRAME_LIMIT,
    `有信封超过中继上限：最大 ${worst} ≥ ${RELAY_FRAME_LIMIT}（分片阈值没有生效）`
  );
  assert.ok(
    worst < RELAY_FRAME_LIMIT * 0.8,
    `余量不足：最大信封 ${worst} 已达上限的 ${(worst / RELAY_FRAME_LIMIT * 100).toFixed(1)}%，应当留出足够空间`
  );
});

test('下行分片：小帧不被拆，保持原样透传', async () => {
  const payload = Buffer.from('{"type":"item","value":{"type":"snapshot"}}', 'utf8');
  const seen = await runBridge([{ fin: true, opcode: OP_TEXT, payload }]);
  assert.equal(seen.length, 1, '小帧不该被拆');
  assert.equal(seen[0].fin, true);
  assert.equal(seen[0].opcode, OP_TEXT);
  assert.ok(b64d(seen[0].data, 'data').equals(payload));
});

test('下行分片：DSH 自己发的非末分片（fin=false）不被我们改写成 fin=true', async () => {
  const payload = Buffer.alloc(100 * 1024, 0x62); // 小于阈值，不该拆
  const seen = await runBridge([{ fin: false, opcode: OP_TEXT, payload }]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].fin, false, '原本 fin=false 的帧必须原样保留，否则会打断 DSH 自己的分片语义');
});
