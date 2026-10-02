/**
 * 上行桥的缓冲与顺序回归（2026-10-01）。
 *
 * 盯死的两个真缺陷（都在 proxy/upgrade.js 的旧实现里）：
 *   ① 重复写入：socket.write(chunk) 返回 false 只表示「已接受，请稍后再写」，
 *      chunk 本身已被 Node 缓冲并会写出。旧代码却又把它 push 进 writeQueue，
 *      之后 flush 会再写一遍 → 对端收到重复帧。
 *   ② 滞留 + 乱序：升级后清空 pending 的循环遇到 false 就 break，剩下的帧永远留在
 *      数组里（drain 回调只清 writeQueue）；而后续帧因为 writeQueue 为空会直接
 *      socket.write 绕过它们 → 后发先至。
 *
 * 做法：真 http 服务端完成 upgrade，然后【故意不读】一段时间把内核缓冲打满，
 * 逼出 write() === false；之后恢复读取，逐字节比对「服务端收到的字节」
 * 与「按发送顺序编码出来的字节」。一条不等就说明有重复或乱序。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openLoopbackBridge } from '../proxy/upgrade.js';
import { OP_CLOSE, ServerFrameParser } from '../proxy/ws-codec.js';
import { b64e } from '../transport/frames.js';

const OP_BINARY = 2;

/**
 * 逐字节比对是错的：client 帧每帧用随机掩码（RFC6455 要求），字节必然不同。
 * 正确口径是【按帧解析后比 payload 序列】—— ServerFrameParser 的 tryParse 通用支持解掩码。
 */
function parseFrames(bytes) {
  return new ServerFrameParser().push(bytes).map((f) => ({ opcode: f.opcode, payload: f.payload }));
}

function assertSameStream(received, sentPayloads, label) {
  const seen = parseFrames(Buffer.concat(received));
  const data = seen.filter((f) => f.opcode === OP_BINARY);
  assert.equal(
    data.length,
    sentPayloads.length,
    `${label}：帧数不匹配（多=重复写入，少=滞留/丢弃）—— 收到 ${data.length}，应为 ${sentPayloads.length}`
  );
  for (let i = 0; i < sentPayloads.length; i += 1) {
    assert.ok(
      sentPayloads[i].equals(data[i].payload),
      `${label}：第 ${i} 帧内容或顺序不符（重复写入 / 乱序）`
    );
  }
}

/** 起一个接受 upgrade、但先暂停不读的服务端。 */
function startSlowServer({ pauseMs }) {
  const received = [];
  const sockets = new Set();
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.pause();
    setTimeout(() => {
      socket.on('data', (chunk) => received.push(chunk));
      socket.resume();
    }, pauseMs);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received, sockets, port: server.address().port }));
  });
}

/**
 * ★ 必须显式清干净：只调 server.close() 不会关闭已建立的连接，
 * 半个还活着的 socket 会钉住事件循环 —— 测试通过但进程不退出，
 * 在 node --test 下表现成「卡死」，而不是失败。（第一次写就踩了这个。）
 */
function stopServer(server, sockets) {
  for (const socket of sockets) {
    try { socket.destroy(); } catch { /* ignore */ }
  }
  try { server.closeAllConnections?.(); } catch { /* ignore */ }
  server.close();
}

test('上行桥：背压下不重复、不乱序（按帧解析比 payload 序列）', async () => {
  const { server, received, sockets, port } = await startSlowServer({ pauseMs: 900 });
  const deps = {
    credential: { acquire: async () => ({ base: `http://127.0.0.1:${port}`, cookie: 'dsh-auth-x=1' }) },
    logger: { warn: () => {} },
    audit: () => {}
  };
  const payloads = [];
  const bridge = openLoopbackBridge(deps, {
    streamId: 's1',
    pathname: '/api/remote.mux',
    search: '',
    onReady: () => {},
    onFrame: () => {},
    onClose: () => {}
  });

  // 等 upgrade 完成（onReady 由 openLoopbackBridge 内部触发，这里用轮询 alive 代替）
  await new Promise((resolve) => setTimeout(resolve, 250));

  // 1.4 MiB，分 4 KiB 一帧 —— 远超 loopback 内核缓冲，必然逼出 write() === false，
  // 同时低于 2 MiB 的积压上限，所以不会走 fail() 分支。
  const FRAMES = 350;
  const SIZE = 4096;
  for (let i = 0; i < FRAMES; i += 1) {
    const payload = Buffer.alloc(SIZE, i % 251);
    payloads.push(payload);
    bridge.toLoopback({ fin: true, opcode: OP_BINARY, data: b64e(payload) });
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));
  bridge.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
  stopServer(server, sockets);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assertSameStream(received, payloads, '背压场景');
});

test('上行桥：升级完成前的积压帧会全部放行，不会滞留', async () => {
  const { server, received, sockets, port } = await startSlowServer({ pauseMs: 0 });
  const deps = {
    credential: {
      // 刻意延迟凭据获取，制造「升级前就有帧进来」的窗口。
      acquire: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { base: `http://127.0.0.1:${port}`, cookie: 'dsh-auth-x=1' };
      }
    },
    logger: { warn: () => {} },
    audit: () => {}
  };
  const bridge = openLoopbackBridge(deps, {
    streamId: 's2',
    pathname: '/api/remote.mux',
    search: '',
    onReady: () => {},
    onFrame: () => {},
    onClose: () => {}
  });

  const payloads = [];
  for (let i = 0; i < 40; i += 1) {
    const payload = Buffer.alloc(1024, i % 251);
    payloads.push(payload);
    assert.equal(bridge.toLoopback({ fin: true, opcode: OP_BINARY, data: b64e(payload) }), true, '升级前入队应成功');
  }

  await new Promise((resolve) => setTimeout(resolve, 900));
  bridge.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
  stopServer(server, sockets);

  await new Promise((resolve) => setTimeout(resolve, 100));
  assertSameStream(received, payloads, '升级前积压场景');
});
