/**
 * TransportAdapter 接口（ADR-004 的拆分缝）。
 *
 * Connector 的传输面只依赖本接口：connect() / send(frame) / close()，入站帧经
 * onFrame 回调。默认实现是 relay-client.js（出站 WSS）；未来拆独立进程或换传输
 * （如 Tailscale 适配器）只需替换实现，身份/策略/代理层零改动。
 *
 * 语义（实现必须遵守）：
 * - send 之后不得假设已送达；连接断开时实现自行负责缓冲丢弃（本方案无离线队列，
 *   状态恢复走 DSH 会话投影 asOfSeq，见方案 §10.3）。
 * - onFrame 收到的帧已过 decodeFrame（exactKeys）；协议错误由实现断连重连。
 */

/**
 * @interface
 * connect(): Promise<void>          — 建立传输（可重入；实现内部做重连退避）。
 * send(frameObj): boolean           — 发一帧（已过 encodeFrame）；false = 未连接。
 * close(): void                     — 永久关闭（不再自动重连）。
 * onFrame: ((frame) => void) | null — 入站帧回调。
 * state: 'standby'|'connecting'|'open'|'retrying'|'killed'
 */

/** 事件发射器（极小实现，零依赖）。 */
export class Emitter {
  #handlers = new Map();
  on(type, fn) {
    let list = this.#handlers.get(type);
    if (!list) {
      list = new Set();
      this.#handlers.set(type, list);
    }
    list.add(fn);
    return () => list.delete(fn);
  }
  emit(type, payload) {
    const list = this.#handlers.get(type);
    if (!list) return;
    for (const fn of [...list]) {
      try {
        fn(payload);
      } catch {
        /* 回调异常不传染 */
      }
    }
  }
}
