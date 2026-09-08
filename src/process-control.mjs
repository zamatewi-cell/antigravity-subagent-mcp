import { spawn } from "node:child_process";
import path from "node:path";
import { sanitizeDiagnostics } from "./diagnostics.mjs";
import { persistJob } from "./storage.mjs";

// Only target the PID returned by our own spawn. Never kill by executable name.
export async function stopProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null || child.killed) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
    return;
  }
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
  await new Promise((resolve, reject) => {
    const killer = spawn(executable, ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true, shell: false, stdio: "ignore",
    });
    const timer = setTimeout(() => {
      killer.kill();
      reject(new Error("终止任务进程树超时，无法确认子进程已停止。"));
    }, 10_000);
    killer.once("error", (error) => { clearTimeout(timer); reject(error); });
    killer.once("close", (code) => {
      clearTimeout(timer);
      // code 0: 成功终止；code 128: 进程已不存在/已先一步退出，均视为成功
      if (code === 0 || code === 128) resolve();
      else reject(new Error(`终止任务进程树失败（taskkill ${code}），无法确认子进程已停止。`));
    });
  });
}

/**
 * 停止任务并终止其关联的整个子进程树
 * @param {object} job
 * @param {"cancelled"|"timed_out"|"output_limit"} reason
 * @returns {Promise<void>}
 */
export function stopJob(job, reason) {
  if (!job) return Promise.resolve();
  if (job.stopPromise) return job.stopPromise;
  // 保持第一终止原因胜出原则（如已记录 timed_out 或 output_limit，则不被后续改写）
  if (!job.stopReason) {
    job.stopReason = reason;
  }
  job.state = "stopping";
  if (reason === "cancelled") job.cancelRequested = true;
  if (job.timeoutHandle) {
    clearTimeout(job.timeoutHandle);
    job.timeoutHandle = null;
  }
  job.stopPromise = stopProcessTree(job.child).catch((error) => {
    job.terminationError = sanitizeDiagnostics(error.message);
    job.state = "error";
    job.result = {
      status: "ERROR",
      error: job.terminationError,
      error_details: { layer: "mcp_bridge", code: "PROCESS_TREE_TERMINATION_FAILED" },
    };
  });
  return job.stopPromise;
}

/**
 * 统一取消任务控制器（供 MCP cancel_gemini_task、Dashboard API、进程关闭钩子等统一复用）
 * 消除 Windows 弱 kill 缺陷，杜绝后续 close 处理器将取消状态漂移改写为 error
 * 同时严格遵守第一终止原因胜出原则，不抹杀既有的 timed_out / output_limit 语义
 * @param {object} job
 * @returns {Promise<object>}
 */
export async function cancelJob(job) {
  if (!job) return null;

  // 1. 排队或重试中：直接收敛为 cancelled 终态
  if (job.state === "queued" || job.state === "retrying") {
    job.cancelRequested = true;
    job.stopReason = job.stopReason || "cancelled";
    job.state = "cancelled";
    job.completedAt = new Date().toISOString();
    job.result = {
      status: "CANCELLED",
      response: "",
      error: "任务已取消。",
      error_details: { layer: "mcp_bridge", code: "CANCELLED" },
    };
    persistJob(job);
    return job;
  }

  // 2. 已经是终态：直接保存并返回
  if (!["running", "stopping"].includes(job.state)) {
    persistJob(job);
    return job;
  }

  // 3. 运行中或停止中：若已存在其它非 cancelled 终止原因（如 timed_out），优先保留
  const effectiveReason = (job.stopReason && job.stopReason !== "cancelled") ? job.stopReason : "cancelled";
  await stopJob(job, effectiveReason);
  persistJob(job);

  if (job.terminationError) {
    persistJob(job);
    return job;
  }

  // 等待进程完全关闭及 close handler 终态收敛
  if (job.completion) {
    await Promise.race([
      job.completion,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }

  // 确保状态稳定收敛：若既有原因为 timed_out 或 output_limit，保持其错误终态；否则收敛为 cancelled
  if (!job.terminationError) {
    if (job.stopReason && job.stopReason !== "cancelled") {
      if (job.state === "stopping") {
        job.state = "error";
      }
    } else if (job.state !== "cancelled") {
      job.state = "cancelled";
      if (!job.completedAt) job.completedAt = new Date().toISOString();
      if (!job.result || job.result.status !== "CANCELLED") {
        job.result = {
          status: "CANCELLED",
          response: job.result?.response || "",
          error: "任务已取消。",
          error_details: { layer: "mcp_bridge", code: "CANCELLED" },
        };
      }
    }
  }

  persistJob(job);
  return job;
}

export function isRetryablePreflightFailure(job) {
  // AGY JSON does not prove that tools have not executed. Missing/zero usage
  // is not evidence of no side effects, including on resumed conversations.
  // Retry only temporary OS spawn failures for which no child PID exists.
  return job.state === "error" && !job.cancelRequested &&
    job.preflightConfirmed === true && ["EAGAIN", "EBUSY"].includes(job.spawnErrorCode);
}

/**
 * 向运行中任务的子进程 stdin 管道安全写入交互指令（Human-in-the-loop）
 * 防护 EPIPE 崩溃，确保写入换行符闭合，并返回写入字节数
 * @param {object} job - 任务对象
 * @param {string} input - 待写入的指令或文本
 * @returns {{ success: true, jobId: string, bytesWritten: number }}
 */
export function sendInputToJob(job, input) {
  if (!job || job.state !== "running") {
    const error = new Error("Job is not running or stdin is closed");
    error.code = "JOB_NOT_RUNNING";
    throw error;
  }

  if (!job.child || !job.child.stdin || job.child.stdin.destroyed || !job.child.stdin.writable) {
    const error = new Error("Job is not running or stdin is closed");
    error.code = "STDIN_NOT_WRITABLE";
    throw error;
  }

  // 绑定 error 监听器防护 EPIPE 崩溃
  if (!job.child.stdin.__epipeProtected) {
    job.child.stdin.on("error", () => {
      // 捕获 EPIPE 等异步管道破裂错误，防止未捕获异常导致 Node 进程崩溃
    });
    job.child.stdin.__epipeProtected = true;
  }

  const raw = String(input ?? "");
  const formatted = raw.endsWith("\n") ? raw : `${raw}\n`;
  const bytesWritten = Buffer.byteLength(formatted, "utf8");

  try {
    job.child.stdin.write(formatted);
    return {
      success: true,
      jobId: job.jobId,
      bytesWritten,
    };
  } catch (err) {
    const error = new Error("Job is not running or stdin is closed");
    error.code = err.code || "WRITE_FAILED";
    throw error;
  }
}
