/**
 * 极小 RFC6455 帧编解码（连接器 ↔ loopback DSH 的 WebSocket 桥用）。
 *
 * 为什么不用 Node 全局 WebSocket 连 loopback：undici 的 WebSocket 不能带 Cookie 头，
 * 而 /api/remote.mux 的升级要过 connection.admit()（fence + cookie）。因此连接器
 * 用 node:http 发起裸 upgrade（自带 Cookie），自己编解码 WS 帧：
 *   - client→server 帧必须 MASK（本模块编码时打掩码）；
 *   - server→client 帧不 mask（解析即可，支持 126/64 位长度）。
 * 只覆盖 DSH mux 用到的形态：FIN + 文本/二进制 + close；分片按原样透传。
 */
import { randomBytes } from 'node:crypto';

export const OP_CONT = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

/** 编码一个 client 帧（自动掩码）。返回 Buffer。 */
export function encodeClientFrame({ fin = true, opcode = OP_TEXT, payload = Buffer.alloc(0) }) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/** 增量解析 server→client 帧流（帧不 mask）。喂 chunk，产出 {fin,opcode,payload} 数组。 */
export class ServerFrameParser {
  #buf = Buffer.alloc(0);

  push(chunk) {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    const frames = [];
    for (;;) {
      const frame = tryParse(this.#buf);
      if (!frame) break;
      this.#buf = this.#buf.subarray(frame.consumed);
      frames.push({ fin: frame.fin, opcode: frame.opcode, payload: frame.payload });
    }
    return frames;
  }
}

function tryParse(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(64 * 1024 * 1024)) throw new Error('ws frame too large from loopback');
    len = Number(big);
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  let payload = Buffer.from(buf.subarray(offset + maskLen, offset + maskLen + len));
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
  }
  return { consumed: offset + maskLen + len, fin, opcode, payload };
}

/** 生成 upgrade 请求头（connector 自己的 key；Cookie 注入）。 */
export function buildUpgradeHeaders(cookie) {
  return {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
    'Sec-WebSocket-Version': '13',
    cookie
  };
}
