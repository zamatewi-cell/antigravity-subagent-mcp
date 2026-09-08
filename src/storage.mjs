import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeDiagnostics } from "./diagnostics.mjs";

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JOBS_DIR = process.env.ANTIGRAVITY_MCP_DATA_DIR
  ? path.join(process.env.ANTIGRAVITY_MCP_DATA_DIR, "jobs")
  : path.join(SERVER_ROOT, "data", "jobs");

try {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
} catch {
  // 忽略已存在异常
}

/**
 * 将任务对象持久化保存到磁盘
 * @param {object} job - 运行时 job 实例
 */
export function persistJob(job) {
  if (!job?.jobId) return;
  try {
    const filePath = path.join(JOBS_DIR, `${job.jobId}.json`);
    const snapshot = {
      jobId: job.jobId,
      state: job.state,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      conversationId: job.conversationId || null,
      invocation: job.invocation,
      result: job.result,
      attempts: job.attempts || 1,
      stopReason: job.stopReason || null,
      terminationError: job.terminationError || null,
      stderr: job.stderr ? sanitizeDiagnostics(job.stderr, 4000) : "",
    };
    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf8");
  } catch {
    // 写入异常不阻断主流程
  }
}

/**
 * 从磁盘恢复历史任务，并纠正异常中断的状态
 * @returns {Map<string, object>} - 恢复后的任务 Map
 */
export function restorePersistedJobs() {
  const jobs = new Map();
  if (!fs.existsSync(JOBS_DIR)) return jobs;

  try {
    const files = fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const fullPath = path.join(JOBS_DIR, file);
        const data = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        if (!data.jobId) continue;

        if (["running", "stopping", "retrying"].includes(data.state)) {
          data.state = "interrupted";
          data.completedAt = data.completedAt || new Date().toISOString();
          data.result = data.result || {
            status: "ERROR",
            error: "服务重新载入，该未完成的任务已被中断。",
            error_details: { layer: "mcp_bridge", code: "SERVICE_RESTARTED" },
          };
        }

        jobs.set(data.jobId, data);
      } catch {
        // 忽略单个文件损坏
      }
    }
  } catch {
    // 忽略目录扫描错误
  }

  return jobs;
}
