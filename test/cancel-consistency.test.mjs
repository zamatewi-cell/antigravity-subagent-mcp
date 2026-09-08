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

  console.log("--- 4. 测试独立 Dashboard（无 child 句柄）拦截假取消 ---");
  // 模拟 Standalone 模式：无 memoryJobs，磁盘中存在一个正在运行的任务
  const fakeStandaloneJob = {
    jobId: "test-standalone-running-" + Date.now(),
    state: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    invocation: { prompt: "standalone fake cancel test", cwd: process.cwd() },
    result: null,
  };
  const jobsDir = path.resolve(__dirname, "..", "data", "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, `${fakeStandaloneJob.jobId}.json`), JSON.stringify(fakeStandaloneJob, null, 2), "utf8");

  // 启动一个没有 memoryJobs 注入的独立看板服务实例
  const standaloneInstance = await startDashboardServer({
    port: 13726,
    autoOpen: false,
  });

  try {
    const postStandaloneRes = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "localhost",
        port: 13726,
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

    assert.equal(postStandaloneRes.statusCode, 409, "独立看板无 child 句柄取消运行中任务必须返回 409 Conflict！");
    assert.equal(postStandaloneRes.body.code, "STANDALONE_CANCEL_FORBIDDEN", "错误码必须为 STANDALONE_CANCEL_FORBIDDEN");

    // 检查磁盘 JSON 是否被破坏
    const diskContentAfter = JSON.parse(fs.readFileSync(path.join(jobsDir, `${fakeStandaloneJob.jobId}.json`), "utf8"));
    assert.equal(diskContentAfter.state, "running", "独立看板拒绝取消后，磁盘任务状态绝不能被假改为 cancelled！");
    console.log("✔ 独立看板假取消拦截与防篡改验证通过（HTTP 409 + 磁盘状态保护）");
  } finally {
    await standaloneInstance.close();
    try { fs.unlinkSync(path.join(jobsDir, `${fakeStandaloneJob.jobId}.json`)); } catch {}
  }

  console.log("--- 4.1 测试独立 Dashboard 拦截排队中任务（queued）的假取消 ---");
  const fakeQueuedStandaloneJob = {
    jobId: "test-standalone-queued-" + Date.now(),
    state: "queued",
    startedAt: new Date().toISOString(),
    completedAt: null,
    invocation: { prompt: "standalone queued fake cancel test", cwd: process.cwd() },
    result: null,
  };
  fs.writeFileSync(path.join(jobsDir, `${fakeQueuedStandaloneJob.jobId}.json`), JSON.stringify(fakeQueuedStandaloneJob, null, 2), "utf8");

  const standaloneQueuedInstance = await startDashboardServer({
    port: 13727,
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
}

runTests().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
