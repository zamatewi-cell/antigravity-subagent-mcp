import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

// 1. 严格沙箱隔离：在任何 ESM 模块导入前创建独立沙箱并重定向数据目录
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hitl-test-"));
process.env.ANTIGRAVITY_MCP_DATA_DIR = path.join(tempDir, "data");

// 动态引入被测模块
const { startDashboardServer } = await import("../src/dashboard.mjs");
const { sendInputToJob } = await import("../src/process-control.mjs");
const { JOBS_DIR } = await import("../src/storage.mjs");

// 强制断言测试沙箱隔离（AC3 严格规约）
assert(JOBS_DIR.startsWith(tempDir), `测试 JOBS_DIR 必须严格隔离至临时沙箱目录: ${JOBS_DIR}`);

console.log("=== 开始执行 R4 Human-in-the-loop 软介入通信管道测试 (test/hitl.test.mjs) ===");

// 辅助 HTTP POST 函数
function httpPost(urlStr, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const bodyStr = typeof data === "string" ? data : JSON.stringify(data);
    const reqHeaders = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(bodyStr),
      ...headers,
    };
    const req = http.request(u, {
      method: "POST",
      headers: reqHeaders,
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// 构造模拟任务对象（带真实的内存可写流 stdin）
function createMockJob(jobId, state = "running") {
  const stdinStream = new PassThrough();
  let receivedData = "";
  stdinStream.on("data", (chunk) => {
    receivedData += chunk.toString("utf8");
  });

  return {
    job: {
      jobId,
      state,
      startedAt: new Date().toISOString(),
      completedAt: state === "running" ? null : new Date().toISOString(),
      invocation: { prompt: "人机协同测试任务", cwd: tempDir, model: "gemini-3.8-flash-high" },
      child: {
        pid: 12345,
        stdin: stdinStream,
      },
      progress: {
        phase: "thinking",
        current_step: 1,
        current_action: "等待用户输入",
      },
      cancelRequested: false,
    },
    stdinStream,
    getReceivedData: () => receivedData,
  };
}

let dashboard;
let standaloneDashboard;

try {
  const memoryJobs = new Map();
  const mockRunning = createMockJob("job-hitl-running-001", "running");
  const mockSuccess = createMockJob("job-hitl-success-002", "success");
  const mockCancelled = createMockJob("job-hitl-cancelled-003", "cancelled");

  memoryJobs.set(mockRunning.job.jobId, mockRunning.job);
  memoryJobs.set(mockSuccess.job.jobId, mockSuccess.job);
  memoryJobs.set(mockCancelled.job.jobId, mockCancelled.job);

  // 启动集成模式看板服务
  dashboard = await startDashboardServer({
    port: 3970,
    memoryJobs,
    autoOpen: false,
  });
  console.log(`  -> 测试服务已就绪: ${dashboard.url}`);

  // =========================================================================
  // Test 1: 底层 sendInputToJob 逻辑与换行符闭合验证
  // =========================================================================
  console.log("\n[Test 1] 验证底层 sendInputToJob 接口功能与换行符自动补全...");
  const res1 = sendInputToJob(mockRunning.job, "y");
  assert.equal(res1.success, true);
  assert.equal(res1.jobId, mockRunning.job.jobId);
  assert.equal(res1.bytesWritten, 2, "字符串 'y' 自动补 \\n 后字节数应为 2");
  assert.equal(mockRunning.getReceivedData(), "y\n", "stdin 必须准确接收到补全换行符的内容");

  // 再次写入已带换行符的输入，避免重复追加换行
  const res2 = sendInputToJob(mockRunning.job, "already-has-newline\n");
  assert.equal(res2.success, true);
  assert.equal(mockRunning.getReceivedData(), "y\nalready-has-newline\n");
  console.log("  -> PASS: sendInputToJob 数据安全写入与换行符补全机制正确");

  // =========================================================================
  // Test 2: HTTP POST /api/jobs/:id/interact 正常交互
  // =========================================================================
  console.log("\n[Test 2] 验证 HTTP POST /api/jobs/:id/interact 正常下发交互指令...");
  const httpResp1 = await httpPost(`${dashboard.url}/api/jobs/${mockRunning.job.jobId}/interact`, {
    input: "npm run build\n",
  });
  assert.equal(httpResp1.statusCode, 200);
  const data1 = JSON.parse(httpResp1.body);
  assert.equal(data1.success, true);
  assert.equal(data1.jobId, mockRunning.job.jobId);
  assert(data1.bytesWritten > 0);
  assert(mockRunning.getReceivedData().includes("npm run build\n"));
  console.log("  -> PASS: 正常交互指令 200 响应并成功注入子进程 stdin");

  // =========================================================================
  // Test 3: 终态任务拒绝交互（400 校验）
  // =========================================================================
  console.log("\n[Test 3] 验证终态任务（success / cancelled）拒绝软介入并返回 400...");
  const respSuccess = await httpPost(`${dashboard.url}/api/jobs/${mockSuccess.job.jobId}/interact`, {
    input: "continue",
  });
  assert.equal(respSuccess.statusCode, 400, "已完成任务必须返回 400");
  const errDataSuccess = JSON.parse(respSuccess.body);
  assert(errDataSuccess.error.includes("Job is not running or stdin is closed"));

  const respCancelled = await httpPost(`${dashboard.url}/api/jobs/${mockCancelled.job.jobId}/interact`, {
    input: "continue",
  });
  assert.equal(respCancelled.statusCode, 400, "已取消任务必须返回 400");
  console.log("  -> PASS: 终态任务安全防护生效，已阻断写入并返回 400");

  // =========================================================================
  // Test 4: 跨站恶意 Origin 防御拦截（403 阻断）
  // =========================================================================
  console.log("\n[Test 4] 验证跨站恶意 Origin 发起软介入时被严格拦截 (403 Forbidden)...");
  const respCors = await httpPost(
    `${dashboard.url}/api/jobs/${mockRunning.job.jobId}/interact`,
    { input: "malicious injected command" },
    { Origin: "https://evil-attacker-site.com" }
  );
  assert.equal(respCors.statusCode, 403, "非本地 Origin 必须直接返回 403");
  console.log("  -> PASS: 跨站 Origin 安全阻断有效，完全防御 CSRF 软介入风险");

  // =========================================================================
  // Test 5: 请求体校验（缺少 input 或类型不合法时返回 400）
  // =========================================================================
  console.log("\n[Test 5] 验证非法请求参数防御性拦截 (400 Bad Request)...");
  const respInvalidBody1 = await httpPost(`${dashboard.url}/api/jobs/${mockRunning.job.jobId}/interact`, {});
  assert.equal(respInvalidBody1.statusCode, 400, "缺少 input 必须返回 400");

  const respInvalidBody2 = await httpPost(`${dashboard.url}/api/jobs/${mockRunning.job.jobId}/interact`, {
    input: 12345, // 非字符串
  });
  assert.equal(respInvalidBody2.statusCode, 400, "input 非字符串必须返回 400");

  const respInvalidJson = await httpPost(`${dashboard.url}/api/jobs/${mockRunning.job.jobId}/interact`, "invalid-json-text");
  assert.equal(respInvalidJson.statusCode, 400, "非法 JSON 必须返回 400");
  console.log("  -> PASS: 非法请求体边界校验通过");

  // =========================================================================
  // Test 6: 独立看板模式下只读保护拦截
  // =========================================================================
  console.log("\n[Test 6] 验证独立看板模式下拒绝软介入并返回 400...");
  standaloneDashboard = await startDashboardServer({
    port: 3971,
    autoOpen: false,
    // memoryJobs 未提供，进入独立模式
  });
  const respStandalone = await httpPost(`${standaloneDashboard.url}/api/jobs/any-job-id/interact`, {
    input: "test",
  });
  assert.equal(respStandalone.statusCode, 400, "独立看板模式下必须安全拒绝并返回 400");
  console.log("  -> PASS: 独立看板只读保护拦截验证通过");

  // =========================================================================
  // Test 7: 管道损坏与 EPIPE 崩溃防护机制验证
  // =========================================================================
  console.log("\n[Test 7] 验证子进程管道销毁/EPIPE 异常时 Node 宿主不崩溃...");
  const destroyedJob = createMockJob("job-destroyed-004", "running");
  // 主动销毁流模拟底层子进程先一步退出
  destroyedJob.stdinStream.destroy();

  assert.throws(
    () => sendInputToJob(destroyedJob.job, "hello"),
    /Job is not running or stdin is closed/,
    "已销毁的 stdin 管道必须抛出受检错误而非 uncaughtException"
  );
  console.log("  -> PASS: EPIPE 与管道关闭崩溃防护机制验证通过");

  console.log("\n[All Tests Passed] R4 Human-in-the-loop 软介入通信管道单测 100% 全部通过！\n");
} finally {
  if (dashboard) await dashboard.close();
  if (standaloneDashboard) await standaloneDashboard.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
