import path from "node:path";

export const directoryQueueLocks = new Map();

/**
 * 同一工作目录并发排队锁，防止多个 Antigravity 实例并发操作同一目录
 * @param {string} rawDir - 目录路径
 * @param {AbortSignal} [signal] - 取消信号
 * @param {() => Promise<any>} fn - 串行执行任务闭包
 * @returns {Promise<any>}
 */
export async function withDirectoryLock(rawDir, signal, fn) {
  const normDir = path.resolve(rawDir || process.env.ANTIGRAVITY_DEFAULT_CWD || process.cwd());
  while (directoryQueueLocks.has(normDir)) {
    if (signal?.aborted) throw new Error("等待同目录排队锁时操作被取消。");
    const prevLock = directoryQueueLocks.get(normDir);
    await Promise.race([
      prevLock,
      new Promise((_, reject) => {
        if (signal) {
          signal.addEventListener("abort", () => reject(new Error("等待同目录排队锁时操作被取消。")), { once: true });
        }
      }),
    ]);
  }

  let release;
  const lockPromise = new Promise((resolve) => {
    release = resolve;
  });
  directoryQueueLocks.set(normDir, lockPromise);

  try {
    return await fn();
  } finally {
    directoryQueueLocks.delete(normDir);
    release();
  }
}
