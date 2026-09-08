import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cancel-test-"));
process.env.ANTIGRAVITY_MCP_DATA_DIR = path.join(tempDir, "data");

const { cancelJob } = await import("../src/process-control.mjs");
const { startDashboardServer } = await import("../src/dashboard.mjs");
const { JOBS_DIR } = await import("../src/storage.mjs");
assert(JOBS_DIR.startsWith(tempDir), `测试 JOBS_DIR 必须被严格隔离至临时沙箱目录: ${JOBS_DIR}`);

async function runTests() {
  try {
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

  const runningJob = {
    jobId: "test-cancel-running-" + Date.now(),
    state: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    child: mockChild,
    invocation: { prompt: "test running cancel", cwd: process.cwd() },
    result: null,
  };

  let closeHandlerCalled = false;
  runningJob.completion = new Promise((resolve) => {
    mockChild.once("close", (exitCode, signal) => {
      closeHandlerCalled = true;
      // 核心验证点：如果 stopReason 设置正确，绝不能走向 error！
      if (runningJob.stopReason === "cancelled" || runningJob.cancelRequested) {
        runningJob.state = "cancelled";
        runningJob.result = runningJob.result || { status: "CANCELLED" };
      } else {
        runningJob.state = "error";
        runningJob.result = { status: "ERROR", error: "未预期的退出" };
      }
      resolve(runningJob.result);
    });
  });

  // 执行 cancelJob
  const cancelPromise = cancelJob(runningJob);
  assert.equal(runningJob.stopReason, "cancelled", "cancelJob 必须第一时间标记 stopReason = cancelled");
  assert.equal(runningJob.cancelRequested, true, "cancelJob 必须标记 cancelRequested = true");

  // 模拟底层子进程因为信号或 taskkill 产生 close 事件（退出码通常非0）
  setTimeout(() => {
    mockChild.emit("close", 1, "SIGTERM");
  }, 50);

  await cancelPromise;
  await runningJob.completion;

  assert.equal(closeHandlerCalled, true, "close handler 必须被调用");
  assert.equal(runningJob.state, "cancelled", "状态必须稳定为 cancelled，绝不能被 close handler 漂移为 error！");
  assert.equal(runningJob.result.status, "CANCELLED", "结果状态必须保持 CANCELLED");
  console.log("✔ 运行中任务取消与 close 防漂移验证通过");

  console.log("--- 3. 测试与 Dashboard 集成取消（内存任务统一调度） ---");
  const dashMemoryJobs = new Map();
  const testJobInDash = {
    jobId: "dash-job-" + Date.now(),
    state: "queued",
    startedAt: new Date().toISOString(),
    completedAt: null,
    invocation: { prompt: "dash cancel integration", cwd: process.cwd() },
    result: null,
  };
  dashMemoryJobs.set(testJobInDash.jobId, testJobInDash);

  const dashboardInstance = await startDashboardServer({
    port: 13726,
    memoryJobs: dashMemoryJobs,
    autoOpen: false,
  });

  try {
    const postRes = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "localhost",
        port: 13726,
        path: `/api/jobs/${testJobInDash.jobId}/cancel`,
        method: "POST",
      }, (res) => {
        let body = "";
        res.on("data", (chunk) => body += chunk);
        res.on("end", () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
      });
      req.on("error", reject);
      req.end();
    });

    assert.equal(postRes.statusCode, 200, "取消应当成功返回 200");
    assert.equal(postRes.body.status, "SUCCESS");
    assert.equal(postRes.body.job.state, "cancelled");

    const memJobAfter = dashMemoryJobs.get(testJobInDash.jobId);
    assert.equal(memJobAfter.state, "cancelled");
    assert.equal(memJobAfter.stopReason, "cancelled", "Dashboard 取消必须通过 cancelJob 正确记录 stopReason");
    assert.equal(memJobAfter.cancelRequested, true);
    console.log("✔ Dashboard 集成 cancelJob 验证通过");
  } finally {
    await dashboardInstance.close();
  }

  console.log("--- 4. 测试独立 Dashboard（无 memoryJobs）取消安全拦截与防伪造取消 ---");
  const jobsDir = JOBS_DIR;
  const fakeStandaloneJob = {
    jobId: "standalone-running-" + Date.now(),
    state: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    invocation: { prompt: "fake standalone", cwd: process.cwd() },
    result: null,
  };
  fs.writeFileSync(path.join(jobsDir, `${fakeStandaloneJob.jobId}.json`), JSON.stringify(fakeStandaloneJob));

  const standaloneInstance = await startDashboardServer({
    port: 13727,
    memoryJobs: null, // 独立看板模式
    autoOpen: false,
  });

  try {
    const postRes = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "localhost",
        port: 13727,
        path: `/api/jobs/${fakeStandaloneJob.jobId}/cancel`,
        method: "POST",
      }, (res) => {
        let body = "";
        res.on("data", (chunk) => body += chunk);
        res.on("end", () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
      });
      req.on("error", reject);
      req.end();
    });

    assert.equal(postRes.statusCode, 409, "独立看板必须返回 409 Conflict（纯只读）！");
    assert.equal(postRes.body.code, "STANDALONE_CANCEL_FORBIDDEN");

    const diskJobAfter = JSON.parse(fs.readFileSync(path.join(jobsDir, `${fakeStandaloneJob.jobId}.json`), "utf8"));
    assert.equal(diskJobAfter.state, "running", "独立看板绝不能改写磁盘为 cancelled！");
    console.log("✔ 独立看板只读拦截与防伪造取消验证通过");
  } finally {
    await standaloneInstance.close();
    try { fs.unlinkSync(path.join(jobsDir, `${fakeStandaloneJob.jobId}.json`)); } catch {}
  }

  console.log("--- 4.1 测试独立 Dashboard 对 queued 任务同样严格拦截（杜绝跨进程假取消） ---");
  const fakeQueuedStandaloneJob = {
    jobId: "standalone-queued-" + Date.now(),
    state: "queued",
    startedAt: new Date().toISOString(),
    completedAt: null,
    invocation: { prompt: "fake queued standalone", cwd: process.cwd() },
    result: null,
  };
  fs.writeFileSync(path.join(jobsDir, `${fakeQueuedStandaloneJob.jobId}.json`), JSON.stringify(fakeQueuedStandaloneJob));

  const standaloneQueuedInstance = await startDashboardServer({
    port: 13727,
    memoryJobs: null, // 独立看板模式
    autoOpen: false,
  });

  try {
    const postQueuedRes = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "localhost",
        port: 13727,
        path: `/api/jobs/${fakeQueuedStandaloneJob.jobId}/cancel`,
        method: "POST",
      }, (res) => {
        let body = "";
        res.on("data", (chunk) => body += chunk);
        res.on("end", () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
      });
      req.on("error", reject);
      req.end();
    });

    assert.equal(postQueuedRes.statusCode, 409, "独立看板无论任务是 running 还是 queued，均必须返回 409 Conflict（纯只读）！");
    assert.equal(postQueuedRes.body.code, "STANDALONE_CANCEL_FORBIDDEN");

    const diskQueuedAfter = JSON.parse(fs.readFileSync(path.join(jobsDir, `${fakeQueuedStandaloneJob.jobId}.json`), "utf8"));
    assert.equal(diskQueuedAfter.state, "queued", "独立看板对 queued 任务也绝不能改写磁盘为 cancelled！");
    console.log("✔ 独立看板对 queued 任务的只读拦截与防篡改验证通过");
  } finally {
    await standaloneQueuedInstance.close();
    try { fs.unlinkSync(path.join(jobsDir, `${fakeQueuedStandaloneJob.jobId}.json`)); } catch {}
  }

  console.log("--- 5. 测试首发终止原因胜出保护（不抹杀 timed_out / output_limit 语义） ---");
  const timeoutJob = {
    jobId: "test-timeout-job-" + Date.now(),
    state: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    invocation: { prompt: "timeout priority test", cwd: process.cwd() },
    result: null,
  };
  // 模拟先发生超时
  timeoutJob.stopReason = "timed_out";
  timeoutJob.state = "error";
  timeoutJob.result = {
    status: "ERROR",
    error: "执行超时被终止。",
    error_details: { layer: "mcp_bridge", code: "TIMEOUT" },
  };

  // 随后并发或延迟调用 cancelJob
  await cancelJob(timeoutJob);

  assert.equal(timeoutJob.stopReason, "timed_out", "首发终止原因 timed_out 必须受到保护，不得被覆盖为 cancelled！");
  assert.equal(timeoutJob.state, "error", "超时终态必须保持 error！");
  assert.equal(timeoutJob.result.error_details.code, "TIMEOUT", "错误详情必须保留 TIMEOUT 语义！");
  console.log("✔ 首发终止原因胜出保护测试通过");

  console.log("\n 全部统一取消与生命周期防漂移测试 100% 通过！");
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

runTests().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
