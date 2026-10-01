/**
 * WebSocket 透传桥（方案 §8.1 proxy/upgrade.js）。
 *
 * 手机 PWA 的 /api/remote.mux 等升级链路：phone ──(relay 终结)──► carrier ws-data 帧
 * ──► 本模块 ──(裸 upgrade + Cookie)──► loopback DSH。loopback 侧帧解析用 ws-codec，
 * 手机侧帧在 relay 已聚合为完整消息（b64）。背压：loopback 暂停时缓冲上限 2 MiB。
 */
import http from 'node:http';
import { buildUpgradeHeaders, encodeClientFrame, OP_CLOSE, OP_CONT, OP_PING, OP_PONG, ServerFrameParser } from './ws-codec.js';
import { b64d, b64e } from '../transport/frames.js';

const BACKPRESSURE_BUFFER_LIMIT = 2 * 1024 * 1024;

/**
 * ★ 下行分片阈值（2026-10-01 根治：大会话历史加载失败）。
 *
 * 问题：中继在 connector→relay 那一跳传的是 **base64**，单帧体积 = ceil(payload/3)*4 + 信封(~150B)。
 * 一个 700 KiB 的 DSH 消息（大会话的 opening snapshot 就有这么大）过中继时变成 ~935 KiB，
 * 逼近中继 1 MiB 的硬上限；越过就【不是丢一帧，而是整条连接被 1009 掐断】——
 * 所有流同时死，手机端报 entry before opening cursor / skipped revision。
 * 实测：本机会话 199 步时 snapshot 已占上限的 89.2%，且随会话单调增长。
 *
 * 解法：连接器把超大帧拆成多个 ws-data 信封，靠 **WebSocket 原生分片**让浏览器重组：
 *   - 首个分片带原 opcode，其余用 OP_CONT(0)；
 *   - 只有末片继承原来的 fin，所以 DSH 自己发分片时语义不被打断；
 *   - 中继已经原样透传 fin，`ws` 的 Sender 会自动把后续发送转成 continuation 帧，
 *     浏览器原生重组 —— **中继与手机侧都不需要任何改动**。
 *
 * 取 512 KiB：过中继约 683 KiB，给上限留出 ~1/3 余量；同时不至于把小帧也拆碎。
 */
const FRAGMENT_PAYLOAD_BYTES = 512 * 1024;

/**
 * 打开一条到 loopback 的 WS 桥。
 * deps: { credential, logger, audit }
 * onReady(socket|null, error?) — socket 为 null 表示升级失败（调用方回 ws-close）。
 * 返回桥句柄 { toLoopback({fin,opcode,data}), close(code), streamId }。
 */
export function openLoopbackBridge(deps, { streamId, path, onReady, onFrame, onClose }) {
  const { credential, logger, audit } = deps;
  let socket = null;
  let disposed = false;
  const parser = new ServerFrameParser();
  /**
   * ★ 上行唯一有序队列（2026-10-01 重写）。
   *
   * 旧实现有两条队列：`pending`（升级前）与 `writeQueue`（背压中），由此产生两个真缺陷：
   *   ① 重复写入：socket.write(chunk) 返回 false 只表示「已接受但请稍后再写」——
   *      chunk 本身已被 Node 缓冲并会写出；旧代码却又把它 push 进 writeQueue，
   *      之后 flushWriteQueue 会【再写一遍】。
   *   ② 滞留 + 乱序：升级后清空 pending 的循环遇到 false 就 break，剩下的帧永远留在
   *      数组里（drain 回调只清 writeQueue，不碰 pending）；而后续帧因为
   *      `writeQueue.length === 0` 会直接 socket.write 绕过它们 —— 后发先至。
   *
   * 合并成一条队列后，顺序由数据结构本身保证，不依赖两处回调互相记得对方。
   */
  const outbox = [];
  let draining = false; // true = 已等到 drain 之前，一律入队
  const BACKPRESSURE = BACKPRESSURE_BUFFER_LIMIT;

  function fail(error) {
    if (disposed) return;
    disposed = true;
    try {
      socket?.destroy();
    } catch {
      /* ignore */
    }
    socket = null;
    onClose?.(1001, error?.message);
  }

  credential.acquire().then(({ base, cookie }) => {
    if (disposed) return;
    const url = new URL(path, base);
    if (url.protocol !== 'http:' || !/^127\.0\.0\.1$/.test(url.hostname)) throw new Error('unexpected loopback URL');
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers: buildUpgradeHeaders(cookie)
    });
    req.on('upgrade', (res, sock, head) => {
      if (disposed) {
        sock.destroy();
        return;
      }
      socket = sock;
      sock.setNoDelay(true);
      sock.on('error', fail);
      sock.on('close', () => fail(new Error('loopback socket closed')));
      sock.on('data', (chunk) => {
        for (const frame of parser.push(chunk)) {
          if (frame.opcode === OP_CLOSE) {
            onClose?.(1000, 'loopback close');
            dispose();
            return;
          }
          // ★ 心跳必须由本层直接回应：DSH 的 mux 每 2s 发 Ping，丢失 2 次即断开
          //   （真机事故 2026-09-30：界面「一直显示重新连接」的根因 —— 之前把 Ping
          //   当普通数据转发给手机，无人回 Pong，4 秒后连接被 DSH 关闭）。
          if (frame.opcode === OP_PING) {
            try {
              sock.write(encodeClientFrame({ opcode: OP_PONG, payload: frame.payload }));
            } catch {
              /* 写失败由 error 事件接管 */
            }
            continue;
          }
          if (frame.opcode === OP_PONG) continue; // 对端心跳回应，无需上报
          emitFragmented(frame);
        }
      });
      if (head && head.length > 0) sock.emit('data', head);
      audit?.({ kind: 'ws.open', detail: { path } });
      // 升级前积压的帧在这里统一放行；flushOutbox 会在遇到内核缓冲满时挂 drain 回调
      // 并把【剩下的】继续排下去 —— 不会再出现「break 之后没人管」。
      flushOutbox();
      onReady?.(sock);
    });
    req.on('response', (res) => {
      fail(new Error(`loopback upgrade refused: HTTP ${res.statusCode}`));
      req.destroy();
    });
    req.on('error', fail);
    req.end();
  }).catch((error) => {
    logger?.warn?.(`[kite] ws bridge failed: ${error.message}`);
    fail(error);
  });

  /**
   * 把一个 loopback 帧交给上行通道，必要时按 FRAGMENT_PAYLOAD_BYTES 拆成多个信封。
   * 拆出来的分片靠 WebSocket 原生分片重组（首个带原 opcode，其余 OP_CONT，
   * 只有末片继承原来的 fin），所以中继与手机侧都无需改动。
   */
  function emitFragmented(frame) {
    const payload = frame.payload;
    if (payload.length <= FRAGMENT_PAYLOAD_BYTES) {
      onFrame?.({ fin: frame.fin, opcode: frame.opcode, data: b64e(payload) });
      return;
    }
    let offset = 0;
    let first = true;
    while (offset < payload.length) {
      const part = payload.subarray(offset, offset + FRAGMENT_PAYLOAD_BYTES);
      offset += part.length;
      const last = offset >= payload.length;
      onFrame?.({
        fin: last ? frame.fin : false,
        opcode: first ? frame.opcode : OP_CONT,
        data: b64e(part)
      });
      first = false;
    }
  }

  /**
   * 写入 loopback。★ 必须处理背压：
   * 旧实现忽略 socket.write() 的返回值，缓冲区满时数据在 Node 内部堆积 ——
   * 对 assistant-stream 这类高频小帧（大会话可达每轮数百帧）会造成延迟累积与丢帧，
   * 表现为 DSH 客户端 revision 不连续（session assistant stream skipped revision N，
   * 真机事故 2026-10-01）。这里改为有界写队列 + drain 恢复。
   */
  function sendToLoopback(chunk) {
    if (disposed) return false;
    // 快路径：升级已完成、无积压、不在等 drain → 直接写。
    if (socket && !draining && outbox.length === 0) {
      if (socket.write(chunk)) return true;
      // 返回 false ≠ 写失败：这条已被 Node 接受并会写出，只是要等 drain 再写后面的。
      // 旧实现在这里又把它入队 → 重复写入。现在只翻 draining 标志。
      draining = true;
      socket.once('drain', onDrain);
      return true;
    }
    // 慢路径：升级未完成 / 有积压 / 等 drain —— 一律入队，顺序由队列保证。
    if (pendingLength() + chunk.length > BACKPRESSURE) {
      fail(new Error(socket ? 'uplink overflow while draining' : 'uplink overflow before upgrade'));
      return false;
    }
    outbox.push(chunk);
    if (socket) flushOutbox();
    return true;
  }

  function onDrain() {
    draining = false;
    flushOutbox();
  }

  function flushOutbox() {
    if (disposed || !socket || draining) return;
    while (outbox.length > 0) {
      const buf = outbox.shift(); // 先出队：write 返回 false 时它已在 Node 缓冲里，不能再入队
      if (!socket.write(buf)) {
        draining = true;
        socket.once('drain', onDrain);
        return;
      }
    }
  }

  function pendingLength() {
    return outbox.reduce((sum, buf) => sum + buf.length, 0);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      socket?.end();
    } catch {
      /* ignore */
    }
    socket = null;
  }

  return {
    /** phone→loopback 一条消息。 */
    toLoopback({ fin, opcode, data }) {
      let payload;
      try {
        payload = b64d(data, 'data');
      } catch {
        return false;
      }
      return sendToLoopback(encodeClientFrame({ fin, opcode, payload }));
    },
    /** 本侧主动关（不等 loopback）。 */
    close() {
      if (socket) {
        try {
          socket.end(encodeClientFrame({ opcode: OP_CLOSE, payload: Buffer.from([0x03, 0xe8]) }));
        } catch {
          /* ignore */
        }
      }
      dispose();
    },
    get alive() {
      return !disposed && socket !== null;
    }
  };
}
