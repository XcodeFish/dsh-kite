/**
 * 中继传输的单宿主所有权锁（多 DSH 实例共存场景）。
 *
 * 背景（真机事故）：同一台机器可能同时跑多个 DSH 宿主（DSH NEXT.app + DeepSeek
 * Harness.app，共用同一 profile 与数据目录）。连接器身份 = 数据目录密钥指纹，
 * 多实例必然同 id 抢座 → 中继端互相 replace（4000）→ 请求按占座窗口随机 502。
 *
 * 契约：同一数据目录只有一个宿主进程允许连接中继；抢不到锁的实例保持待机
 * （面板显示「由另一实例接管」）。锁文件 O_EXCL + pid 存活检查（持锁进程死亡
 * 后可被接管）。参考 session-messenger 的 owner.lock 先例。
 */
import { openSync, readFileSync, unlinkSync, writeSync, closeSync, existsSync } from 'node:fs';
import path from 'node:path';

const LOCK_FILE = 'relay-owner.lock';

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM'; // EPERM = 进程在但无权发信号，仍视为存活
  }
}

/**
 * 尝试取得中继所有权。返回 { owned, release, holder }：
 * - owned=true   → 本进程持有（release 解锁）；
 * - owned=false  → 另一存活进程持有（holder 为其 pid），本进程不得连接中继。
 */
export function acquireRelayOwnerLock(dataDir, logger) {
  const file = path.join(dataDir, LOCK_FILE);
  const attempt = () => {
    try {
      const fd = openSync(file, 'wx'); // O_EXCL：原子创建
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      closeSync(fd);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        logger?.warn?.(`[kite] relay owner lock unavailable (${error.code}); assuming not owned`);
        return false;
      }
      return false; // 已被持有 → 走存活检查
    }
  };

  let owned = attempt();
  if (!owned && existsSync(file)) {
    // 检查持锁进程是否存活；死亡则偷锁（一次性，避免竞态放大：偷锁失败即放弃本轮）。
    try {
      const holder = JSON.parse(readFileSync(file, 'utf8'));
      if (!pidAlive(holder?.pid)) {
        try {
          unlinkSync(file);
        } catch {
          /* 别的进程先偷了 → 放弃本轮 */
        }
        owned = attempt();
        if (owned) logger?.info?.(`[kite] 接管了已死亡实例的中继所有权（原持有 pid=${holder?.pid}）`);
      }
    } catch {
      /* 锁文件损坏 → 视为无主，偷锁一次 */
      try {
        unlinkSync(file);
        owned = attempt();
      } catch {
        /* 放弃 */
      }
    }
  }

  const holderPid = (() => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))?.pid ?? null;
    } catch {
      return null;
    }
  })();

  return {
    owned,
    holder: owned ? process.pid : holderPid,
    release() {
      if (!owned) return;
      try {
        const current = JSON.parse(readFileSync(file, 'utf8'));
        if (current?.pid === process.pid) unlinkSync(file);
      } catch {
        /* 已不在 */
      }
      owned = false;
    }
  };
}
