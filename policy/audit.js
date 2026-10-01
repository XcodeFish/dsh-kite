/**
 * 审计日志（方案 §6.4 / M3）：追加写 audit.jsonl。
 *
 * 每条 {ts, deviceId?, kind, method?, path?, status?, bytes?, reason?, detail?}。
 * 不记录正文（避免把用户对话写进审计文件）。超 5 MiB 轮转：audit.jsonl → .1（保留 3 代）。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_GENERATIONS = 3;

export class AuditLog {
  #file;
  #logger;
  #tail = []; // 内存环形尾（管理面板实时查看，上限 500）
  #tailLimit = 500;
  #writes = 0;
  #chain = Promise.resolve();

  constructor(dataDir, logger) {
    this.#file = path.join(dataDir, 'audit.jsonl');
    this.#logger = logger;
  }

  get file() {
    return this.#file;
  }

  /** 追加一条（同步语义给调用方：fire-and-forget，内部串行）。 */
  append(entry) {
    const record = { ts: Date.now(), ...entry };
    const line = JSON.stringify(record);
    this.#tail.push(record);
    if (this.#tail.length > this.#tailLimit) this.#tail.shift();
    this.#writes += 1;
    // 串行化落盘：避免交错写坏 jsonl。
    this.#chain = this.#chain.then(() => this.#writeLine(line)).catch((error) => {
      this.#logger?.warn?.(`[kite] audit write failed: ${error.message}`);
    });
    return record;
  }

  async #writeLine(line) {
    try {
      let size = 0;
      try {
        const stat = await fsp.stat(this.#file);
        size = stat.size;
      } catch {
        /* 首次不存在 */
      }
      if (size > MAX_BYTES) await this.#rotate();
      await fsp.appendFile(this.#file, `${line}\n`, { mode: 0o600 });
    } catch (error) {
      this.#logger?.warn?.(`[kite] audit append failed: ${error.message}`);
    }
  }

  async #rotate() {
    for (let gen = KEEP_GENERATIONS - 1; gen >= 1; gen -= 1) {
      const from = gen === 1 ? this.#file : `${this.#file}.${gen - 1}`;
      const to = `${this.#file}.${gen}`;
      try {
        await fsp.rename(from, to);
      } catch {
        /* 源不存在，继续 */
      }
    }
  }

  /** 等待全部已排队写落盘（测试与优雅停机用）。 */
  async flush() {
    await this.#chain;
  }

  /** 管理面板用：内存尾（不含历史文件）。 */
  tail(limit = 100) {
    return this.#tail.slice(-Math.max(1, Math.min(limit, this.#tailLimit))).reverse();
  }

  /** 最近 N 条（跨文件读盘，管理面板「加载更多」用）。 */
  async recent(limit = 100) {
    let text = '';
    try {
      text = await fsp.readFile(this.#file, 'utf8');
    } catch {
      return this.tail(limit);
    }
    const lines = text.trim().length ? text.trim().split('\n') : [];
    const picked = lines.slice(-Math.max(1, Math.min(limit, 2000)));
    const out = [];
    for (const line of picked.reverse()) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 忽略坏行 */
      }
    }
    return out;
  }

  get stats() {
    return { writes: this.#writes, tail: this.#tail.length };
  }
}
