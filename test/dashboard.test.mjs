import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dash-test-"));
process.env.ANTIGRAVITY_MCP_DATA_DIR = path.join(tempDir, "data");

const { startDashboardServer, formatJobDetail } = await import("../src/dashboard.mjs");
const { JOBS_DIR } = await import("../src/storage.mjs");
assert(JOBS_DIR.startsWith(tempDir), `测试 JOBS_DIR 必须被严格隔离至临时沙箱目录: ${JOBS_DIR}`);

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    }).on("error", reject);
  });
}

function httpPost(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: "POST",
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

console.log("=== 开始执行 Dashboard 看板与 SSE 流自动化测试 ===");

const testMemoryJobs = new Map();

// 构造一个模拟的 Teamwork 任务，包含 2 个子代理
const sampleJobId = "mock-dash-job-123";
const mockJob = {
  jobId: sampleJobId,
  state: "running",
  startedAt: new Date().toISOString(),
  completedAt: null,
  invocation: {
    prompt: "/teamwork-preview 构建微服务架构并完成单元测试",
    cwd: tempDir,
    model: "gemini-3.8-flash-high",
    slash_command: "/teamwork-preview",
    timeout_seconds: 600,
  },
  attempts: 1,
  result: null,
  cancelRequested: false,
};
testMemoryJobs.set(sampleJobId, mockJob);

// 构造一个排队中的任务
const queuedJobId = "mock-queued-job-456";
testMemoryJobs.set(queuedJobId, {
  jobId: queuedJobId,
  state: "queued",
  startedAt: new Date().toISOString(),
  completedAt: null,
  invocation: { prompt: "排队任务", cwd: tempDir, model: "gemini-3.8-flash-high" },
  attempts: 1,
  cancelRequested: false,
});

let dashboard;
try {
  // 1. 启动 Dashboard 测试服务（动态分配端口）
  console.log("\n[Test 1] 启动轻量 Dashboard HTTP 服务...");
  dashboard = await startDashboardServer({
    port: 3900,
    memoryJobs: testMemoryJobs,
    autoOpen: false,
  });
  assert(dashboard.port >= 3900, "端口应当分配成功");
  console.log(`  -> PASS: Dashboard 服务成功监听于 ${dashboard.url}`);

  // 2. 测试静态 HTML 主页返回
  console.log("\n[Test 2] 验证 GET / 返回现代暗黑前端界面...");
  const indexResp = await httpGet(`${dashboard.url}/`);
  assert.equal(indexResp.statusCode, 200);
  assert(indexResp.headers["content-type"].includes("text/html"));
  assert(indexResp.body.includes("Antigravity Subagent Monitor"), "HTML 中必须包含看板标题！");
  assert(indexResp.body.includes("Teamwork 子代理微观上帝视角"), "HTML 中必须包含微观视角区块！");
  console.log("  -> PASS: 静态单页交付正常，HTML 结构完整");

  // 3. 测试 /api/status 接口
  console.log("\n[Test 3] 验证 GET /api/status 服务状态接口...");
  const statusResp = await httpGet(`${dashboard.url}/api/status`);
  assert.equal(statusResp.statusCode, 200);
  const statusData = JSON.parse(statusResp.body);
  assert.equal(statusData.status, "OK");
  assert.equal(statusData.version, "1.4.0");
  assert.equal(statusData.total_jobs, 2);
  assert.equal(statusData.active_jobs, 2);
  console.log("  -> PASS: 状态接口统计准确无误");

  // 3.1 验证 CORS 收紧（禁止向外部未受信 Origin 开放通配符 *）
  console.log("\n[Test 3.1] 验证 CORS 收紧机制（禁止向外部域反射 *）...");
  const evilOriginRes = await new Promise((resolve, reject) => {
    const u = new URL(`${dashboard.url}/api/status`);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      headers: { Origin: "https://malicious-site.example.com" },
    }, (res) => {
      resolve({ headers: res.headers });
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(evilOriginRes.headers["access-control-allow-origin"], undefined, "未受信外部域绝不能获得 Access-Control-Allow-Origin 授权！");

  const localOriginRes = await new Promise((resolve, reject) => {
    const u = new URL(`${dashboard.url}/api/status`);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      headers: { Origin: "http://localhost:3000" },
    }, (res) => {
      resolve({ headers: res.headers });
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(localOriginRes.headers["access-control-allow-origin"], "http://localhost:3000", "本地合法开发域正确获得授权");
  console.log("  -> PASS: CORS 安全访问控制收紧生效");

  // 3.2 验证跨域修改请求拦截（外部 Origin 发起 POST 时必须返回 403 Forbidden）
  console.log("\n[Test 3.2] 验证恶意外部 Origin 发起 POST 修改操作时被严格阻断（403 Forbidden）...");
  const evilPostRes = await new Promise((resolve, reject) => {
    const u = new URL(`${dashboard.url}/api/jobs/${queuedJobId}/cancel`);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: "POST",
      headers: { Origin: "https://evil-attacker.example.com" },
    }, (res) => {
      resolve({ statusCode: res.statusCode });
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(evilPostRes.statusCode, 403, "携带非本地恶意 Origin 的 POST 取消操作必须被拒绝（HTTP 403）！");
  console.log("  -> PASS: 跨站恶意 POST 请求被 403 严格阻断，杜绝 CSRF 风险");

  // 4. 测试 /api/jobs 接口
  console.log("\n[Test 4] 验证 GET /api/jobs 任务列表及微观结构...");
  const jobsResp = await httpGet(`${dashboard.url}/api/jobs`);
  assert.equal(jobsResp.statusCode, 200);
  const jobsList = JSON.parse(jobsResp.body);
  assert.equal(jobsList.length, 2);
  const target = jobsList.find(j => j.jobId === sampleJobId);
  assert(target, "列表必须包含 sampleJobId");
  assert.equal(target.state, "running");
  assert(target.progress, "必须挂载 progress 结构");
  console.log("  -> PASS: 任务列表与 progress 序列化结构正确");

  // 5. 测试 /api/jobs/:id 详情接口
  console.log("\n[Test 5] 验证 GET /api/jobs/:id 独立任务详情与子代理信息...");
  const detailResp = await httpGet(`${dashboard.url}/api/jobs/${sampleJobId}`);
  assert.equal(detailResp.statusCode, 200);
  const detailData = JSON.parse(detailResp.body);
  assert.equal(detailData.jobId, sampleJobId);
  assert.equal(detailData.invocation.slash_command, "/teamwork-preview");
  console.log("  -> PASS: 任务详情接口正常");

  // 5.1 验证 logTail 输出脱敏
  console.log("\n[Test 5.1] 验证 formatJobDetail 中 logTail 经过敏感信息脱敏...");
  const sensitiveLogFile = path.join(tempDir, "sensitive.log");
  fs.writeFileSync(sensitiveLogFile, "User secret: AIzaSyD-Secret1234567890abcdef123456 in path C:\\Users\\Administrator\\.gemini\\keys", "utf8");
  const sensitiveJob = {
    jobId: "sensitive-job-789",
    state: "running",
    startedAt: new Date().toISOString(),
    invocation: { log_file: sensitiveLogFile, cwd: tempDir },
  };
  const formattedSensitive = formatJobDetail(sensitiveJob);
  assert(!formattedSensitive.logTail.includes("AIzaSyD-Secret1234567890abcdef123456"), "敏感 API Key 绝不能直接暴露在 logTail！");
  assert(formattedSensitive.logTail.includes("[redacted-key]") || formattedSensitive.logTail.includes("[redacted]"), "敏感 Key 必须被脱敏替换");
  console.log("  -> PASS: 物理日志尾部脱敏生效");

  // 6. 测试 /api/jobs/:id/cancel 取消接口
  console.log("\n[Test 6] 验证 POST /api/jobs/:id/cancel 终止排队任务...");
  const cancelResp = await httpPost(`${dashboard.url}/api/jobs/${queuedJobId}/cancel`);
  assert.equal(cancelResp.statusCode, 200);
  const cancelData = JSON.parse(cancelResp.body);
  assert.equal(cancelData.status, "SUCCESS");
  assert.equal(cancelData.job.state, "cancelled");
  const queuedJobRef = testMemoryJobs.get(queuedJobId);
  assert.equal(queuedJobRef.state, "cancelled", "内存中的任务状态必须已变为 cancelled！");
  console.log("  -> PASS: Web 端一键取消任务并同步持久化测试通过");

  // 7. 测试 /api/stream SSE 实时流
  console.log("\n[Test 7] 验证 GET /api/stream SSE 实时流广播与连接建立...");
  await new Promise((resolve, reject) => {
    const u = new URL(`${dashboard.url}/api/stream`);
    const sseReq = http.request(u, (res) => {
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["content-type"], "text/event-stream");
      let receivedConnected = false;
      res.on("data", (chunk) => {
        const text = chunk.toString();
        if (text.includes("event: connected")) {
          receivedConnected = true;
        }
        if (text.includes("event: snapshot")) {
          assert(receivedConnected, "必须先收到 connected 事件，再收到 snapshot 数据广播");
          sseReq.destroy(); // 主动断开
          resolve();
        }
      });
    });
    sseReq.on("error", (err) => {
      if (err.code === "ECONNRESET") resolve(); // 预期断开
      else reject(err);
    });
    sseReq.end();
  });
  console.log("  -> PASS: SSE 实时流推送握手与广播周期验证正常");

  console.log("\n[All Tests Passed] Dashboard 自动化测试全项 100% 通过！\n");
} finally {
  if (dashboard) {
    await dashboard.close();
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
}
