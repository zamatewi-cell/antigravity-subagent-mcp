import { spawn } from "node:child_process";
import path from "node:path";

// Only target the PID returned by our own spawn. Never kill by executable name.
export async function stopProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
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
      if (code === 0) resolve();
      else reject(new Error(`终止任务进程树失败（taskkill ${code}），无法确认子进程已停止。`));
    });
  });
}

export function isRetryablePreflightFailure(job) {
  // AGY JSON does not prove that tools have not executed. Missing/zero usage
  // is not evidence of no side effects, including on resumed conversations.
  // Retry only temporary OS spawn failures for which no child PID exists.
  return job.state === "error" && !job.cancelRequested &&
    job.preflightConfirmed === true && ["EAGAIN", "EBUSY"].includes(job.spawnErrorCode);
}
