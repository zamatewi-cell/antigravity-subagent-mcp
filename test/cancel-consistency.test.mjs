import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { cancelJob } from "../src/process-control.mjs";
import { startDashboardServer } from "../src/dashboard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runTests() {
  console.log("--- 1. 测试排队任务统一取消 ---");
  const queuedJob = {
    jobId: "test-cancel-queued-" + Date.now(),
    state: "queued",
    startedAt: new Date().toISOString(),
    completedAt: null,
    invocation: { prompt: "test queued cancel", cwd: process.cwd() },
    result: null,
  };

  await cancelJob(queuedJob);
  assert.equal(queuedJob.state, "cancelled", "排队任务取消后状态必须为 cancelled");
  assert.equal(queuedJob.stopReason, "cancelled", "必须记录 stopReason = cancelled");
  assert.equal(queuedJob.cancelRequested, true, "必须标记 cancelRequested = true");
  assert.equal(queuedJob.result?.status, "CANCELLED", "结果状态必须为 CANCELLED");
  assert.ok(queuedJob.completedAt, "必须记录完成时间");
  console.log("✔ 排队任务统一取消测试通过");

  console.log("--- 2. 测试运行中任务取消与 close handler 防状态漂移 ---");
  const mockChild = new EventEmitter();
  mockChild.pid = 999999;
  mockChild.exitCode = null;
  mockChild.signalCode = null;
  mockChild.killed = false;

  let taskkillInvoked = false;
  const runningJob = {
    jobId: "test-cancel-running-" + Date.now(),
    state: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    child: mockChild,
    invocation: { prompt: "test running cancel", cwd: process.cwd() },
    result: null,
  };

  // 模拟 server.mjs 中的 close 处理机制
  let closeHandlerCalled = false;
  runningJob.completion = new Promise((resolve) => {
    mockChild.once("close", (exitCode, signal) => {
      closeHandlerCalled = true;
      // 核心验证点：如果 stopReason 设置正确，绝不能走向 error！
      if (runningJob.stopReason) {
        const states = { cancelled: ["cancelled", "CANCELLED"] };
        const [state, status] = states[runningJob.stopReason] || ["error", "ERROR"];
        runningJob.state = state;
        runningJob.result = { status, error: "任务已取消。" };
      } else {
        // 若缺少 stopReason，便会产生向 error 的状态漂移
        runningJob.state = "error";
        runningJob.result = { status: "ERROR", error: "非正常退出" };
      }
      runningJob.completedAt = new Date().toISOString();
      resolve(runningJob);
    });
  });

  // 触发取消
  const cancelPromise = cancelJob(runningJob);
  assert.equal(runningJob.stopReason, "cancelled", "cancelJob 必须第一时间标记 stopReason = cancelled");

  // 模拟底层子进程因为信号或 taskkill 产生 close 事件（退出码通常非0）
  setTimeout(() => {
    mockChild.emit("close", 1, "SIGTERM");
  }, 100);

  await cancelPromise;

  assert.equal(closeHandlerCalled, true, "close handler 必须被调用");
  assert.equal(runningJob.state, "cancelled", "状态必须稳定为 cancelled，绝不能被 close handler 漂移为 error！");
  assert.equal(runningJob.result.status, "CANCELLED", "结果状态必须保持 CANCELLED");
  console.log("✔ 运行中任务取消与防状态漂移测试通过");

  console.log("--- 3. 测试 Dashboard /api/jobs/:id/cancel 接口统一复用 cancelJob ---");
  const memJobs = new Map();
  const dashJob = {
    jobId: "dash-cancel-job-" + Date.now(),
    state: "queued",
    startedAt: new Date().toISOString(),
    completedAt: null,
    invocation: { prompt: "dashboard cancel test", cwd: process.cwd() },
    result: null,
  };
  memJobs.set(dashJob.jobId, dashJob);

  const dashInstance = await startDashboardServer({
    port: 13725,
    memoryJobs: memJobs,
    autoOpen: false,
  });

  try {
    const postRes = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "localhost",
        port: 13725,
        path: `/api/jobs/${dashJob.jobId}/cancel`,
        method: "POST",
      }, (res) => {
        let body = "";
        res.on("data", (chunk) => body += chunk);
        res.on("end", () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
      });
      req.on("error", reject);
      req.end();
    });

    assert.equal(postRes.statusCode, 200, "Dashboard 取消 API 必须返回 200");
    assert.equal(dashJob.state, "cancelled", "通过 Dashboard 取消后状态必须为 cancelled");
    assert.equal(dashJob.stopReason, "cancelled", "通过 Dashboard 取消后必须具备 stopReason = cancelled");
    assert.equal(dashJob.result?.status, "CANCELLED", "通过 Dashboard 取消后结果必须为 CANCELLED");
    console.log("✔ Dashboard 取消接口统一复用测试通过");
  } finally {
    await dashInstance.close();
  }

  console.log("\n 全部统一取消与生命周期防漂移测试 100% 通过！");
}

runTests().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
