import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 1. 严格沙箱隔离：在任何 ESM 模块导入前创建独立沙箱并指向临时目录
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-pagination-test-"));
process.env.ANTIGRAVITY_MCP_DATA_DIR = path.join(tempDir, "data");

// 2. 动态加载被测模块
const { startDashboardServer, formatJobDetail } = await import("../src/dashboard.mjs");
const { JOBS_DIR } = await import("../src/storage.mjs");

// 3. 严格断言测试环境沙箱隔离（AC3 强制要求）
assert(JOBS_DIR.startsWith(tempDir), `测试 JOBS_DIR 必须被严格隔离至临时沙箱目录: ${JOBS_DIR}`);

// 辅助 HTTP 请求函数
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    }).on("error", reject);
  });
}

console.log("=== 开始执行 R1 历史任务服务端分页与过滤自动化测试 (test/pagination.test.mjs) ===");

const testMemoryJobs = new Map();

// 构造 12 条不同时间、状态与 prompt 的测试任务
const baseTime = new Date("2026-09-08T10:00:00.000Z").getTime();
const states = ["running", "queued", "success", "error", "cancelled", "interrupted"];

for (let i = 1; i <= 12; i++) {
  const jobId = `mock-job-${String(i).padStart(3, "0")}`;
  const state = states[(i - 1) % states.length];
  // 时间戳递增：job-012 最晚，排序后应排在第 1 位
  const startedAt = new Date(baseTime + i * 60000).toISOString();
  let prompt = `Task ${i} prompt`;
  if (i % 2 === 0) prompt += " feature: pagination implementation";
  if (i % 3 === 0) prompt += " keyword: AGENT-DAG";

  testMemoryJobs.set(jobId, {
    jobId,
    state,
    startedAt,
    completedAt: ["success", "error", "cancelled", "interrupted"].includes(state) ? startedAt : null,
    invocation: {
      prompt,
      cwd: tempDir,
      model: "gemini-3.8-flash-high",
      slash_command: i === 1 ? "/teamwork-preview" : null,
      timeout_seconds: 300,
    },
    attempts: 1,
    result: state === "error" ? { status: "ERROR", error: "Fatal execution error" } : null,
    cancelRequested: false,
  });
}

let dashboard;
let emptyDashboard;

try {
  // 启动主测试服务
  dashboard = await startDashboardServer({
    port: 3950,
    memoryJobs: testMemoryJobs,
    autoOpen: false,
  });
  console.log(`  -> 测试服务已就绪: ${dashboard.url}`);

  // Test 1: 向后兼容性测试 - 无任何参数时返回全量数组
  console.log("\n[Test 1] 验证向后兼容模式：无参数时返回全量数组...");
  const resp1 = await httpGet(`${dashboard.url}/api/jobs`);
  assert.equal(resp1.statusCode, 200);
  const list1 = JSON.parse(resp1.body);
  assert(Array.isArray(list1), "向后兼容模式下必须返回数组");
  assert.equal(list1.length, 12, "向后兼容模式下必须返回全部 12 条任务");
  assert.equal(list1[0].jobId, "mock-job-012", "默认必须按开始时间降序排列（最新优先）");
  console.log("  -> PASS: 无参向后兼容模式验证通过");

  // Test 2: 向后兼容性测试 - 携带无关参数
  console.log("\n[Test 2] 验证向后兼容模式：携带无关参数时不触发分页结构...");
  const resp2 = await httpGet(`${dashboard.url}/api/jobs?t=1712345678&rand=abc`);
  assert.equal(resp2.statusCode, 200);
  const list2 = JSON.parse(resp2.body);
  assert(Array.isArray(list2), "携带无关参数时依然应保持数组兼容模式");
  assert.equal(list2.length, 12);
  console.log("  -> PASS: 无关参数向后兼容验证通过");

  // Test 3: Acceptance Criteria 1 核心断言 - page=2&limit=5 精确返回第 6~10 条任务
  console.log("\n[Test 3] 验证标准分页：GET /api/jobs?page=2&limit=5 精确返回第 6~10 条任务...");
  const resp3 = await httpGet(`${dashboard.url}/api/jobs?page=2&limit=5`);
  assert.equal(resp3.statusCode, 200);
  const json3 = JSON.parse(resp3.body);
  assert(json3.pagination, "响应必须包含 pagination 结构");
  assert.equal(json3.pagination.total, 12);
  assert.equal(json3.pagination.page, 2);
  assert.equal(json3.pagination.limit, 5);
  assert.equal(json3.pagination.totalPages, 3);
  assert.equal(json3.pagination.hasMore, true);
  assert.equal(json3.data.length, 5, "第 2 页 limit=5 必须恰好返回 5 条数据");
  // 降序排序后：
  // 1: job-012, 2: job-011, 3: job-010, 4: job-009, 5: job-008
  // 6: job-007, 7: job-006, 8: job-005, 9: job-004, 10: job-003
  assert.equal(json3.data[0].jobId, "mock-job-007", "第 2 页首项必须是全量降序后的第 6 项");
  assert.equal(json3.data[4].jobId, "mock-job-003", "第 2 页末项必须是全量降序后的第 10 项");
  console.log("  -> PASS: 第 2 页分页数据与元数据完全吻合");

  // Test 4: 末页切片与 hasMore 为 false
  console.log("\n[Test 4] 验证分页末页：GET /api/jobs?page=3&limit=5 返回剩余 2 条且 hasMore=false...");
  const resp4 = await httpGet(`${dashboard.url}/api/jobs?page=3&limit=5`);
  const json4 = JSON.parse(resp4.body);
  assert.equal(json4.pagination.totalPages, 3);
  assert.equal(json4.pagination.hasMore, false);
  assert.equal(json4.data.length, 2);
  assert.equal(json4.data[0].jobId, "mock-job-002");
  assert.equal(json4.data[1].jobId, "mock-job-001");
  console.log("  -> PASS: 分页末页处理正确");

  // Test 5: Acceptance Criteria 1 - state=running 精确过滤
  console.log("\n[Test 5] 验证状态过滤：GET /api/jobs?state=running 仅返回运行态任务...");
  const resp5 = await httpGet(`${dashboard.url}/api/jobs?state=running`);
  const json5 = JSON.parse(resp5.body);
  assert(json5.data.length > 0);
  assert(json5.data.every((j) => j.state === "running"), "所有返回任务状态必须严格为 running");
  assert.equal(json5.pagination.total, 2, "12 条任务中应恰有 2 条 running");
  console.log("  -> PASS: state=running 过滤精准无误");

  // Test 6: 关键词模糊检索（大小写不敏感匹配 Prompt）
  console.log("\n[Test 6] 验证关键词模糊检索：GET /api/jobs?search=PAGINATION (大小写不敏感)...");
  const resp6 = await httpGet(`${dashboard.url}/api/jobs?search=PAGINATION`);
  const json6 = JSON.parse(resp6.body);
  assert(json6.data.length > 0);
  assert(json6.data.every((j) => j.invocation.prompt.toLowerCase().includes("pagination")), "返回结果必须匹配关键词");
  console.log("  -> PASS: 关键词模糊检索验证通过");

  // Test 7: Job ID 模糊检索
  console.log("\n[Test 7] 验证 Job ID 检索：GET /api/jobs?search=job-008...");
  const resp7 = await httpGet(`${dashboard.url}/api/jobs?search=job-008`);
  const json7 = JSON.parse(resp7.body);
  assert.equal(json7.data.length, 1);
  assert.equal(json7.data[0].jobId, "mock-job-008");
  console.log("  -> PASS: Job ID 检索验证通过");

  // Test 8: 复合查询（state + search + 分页）
  console.log("\n[Test 8] 验证组合查询：GET /api/jobs?state=error&search=prompt&page=1&limit=10...");
  const resp8 = await httpGet(`${dashboard.url}/api/jobs?state=error&search=prompt&page=1&limit=10`);
  const json8 = JSON.parse(resp8.body);
  assert(json8.data.every((j) => j.state === "error"));
  assert.equal(json8.pagination.page, 1);
  console.log("  -> PASS: 组合查询验证通过");

  // Test 9: Acceptance Criteria 1 - 边界防御：超页数返回空数组
  console.log("\n[Test 9] 验证边界防御：超页数 GET /api/jobs?page=999&limit=5...");
  const resp9 = await httpGet(`${dashboard.url}/api/jobs?page=999&limit=5`);
  assert.equal(resp9.statusCode, 200);
  const json9 = JSON.parse(resp9.body);
  assert.deepEqual(json9.data, [], "超页数时 data 必须为空数组");
  assert.equal(json9.pagination.total, 12);
  assert.equal(json9.pagination.page, 999);
  assert.equal(json9.pagination.totalPages, 3);
  assert.equal(json9.pagination.hasMore, false, "超页数时 hasMore 必须为 false");
  console.log("  -> PASS: 超页数边界防御测试通过");

  // Test 10: 边界防御：非数字与非法负数参数优雅降级
  console.log("\n[Test 10] 验证边界防御：非法参数 page=-5&limit=abc 优雅降级...");
  const resp10 = await httpGet(`${dashboard.url}/api/jobs?page=-5&limit=abc`);
  const json10 = JSON.parse(resp10.body);
  assert.equal(json10.pagination.page, 1, "非法 page=-5 必须修正为 1");
  assert.equal(json10.pagination.limit, 20, "非数字 limit=abc 必须修正为默认 20");
  console.log("  -> PASS: 非法参数防御性降级正常");

  // Test 11: 边界防御：Limit 越界上下限截断
  console.log("\n[Test 11] 验证边界防御：limit 越界截断 (limit=500 -> 100, limit=0 -> 1)...");
  const resp11a = await httpGet(`${dashboard.url}/api/jobs?limit=500`);
  assert.equal(JSON.parse(resp11a.body).pagination.limit, 100, "limit>100 必须被约束为 100");
  const resp11b = await httpGet(`${dashboard.url}/api/jobs?limit=0`);
  assert.equal(JSON.parse(resp11b.body).pagination.limit, 1, "limit<1 必须被约束为 1");
  console.log("  -> PASS: limit 范围截断验证通过");

  // Test 12: Acceptance Criteria 1 - 空列表场景
  console.log("\n[Test 12] 验证边界防御：空列表场景...");
  emptyDashboard = await startDashboardServer({
    port: 3951,
    memoryJobs: new Map(),
    autoOpen: false,
  });
  const resp12 = await httpGet(`${emptyDashboard.url}/api/jobs?page=1&limit=10`);
  const json12 = JSON.parse(resp12.body);
  assert.deepEqual(json12.data, []);
  assert.equal(json12.pagination.total, 0, "空列表 total 必须为 0");
  assert.equal(json12.pagination.totalPages, 0, "空列表 totalPages 必须为 0");
  assert.equal(json12.pagination.hasMore, false, "空列表 hasMore 必须为 false");
  console.log("  -> PASS: 空列表场景处理优雅");

  console.log("\n[All Tests Passed] R1 历史任务分页过滤单测 100% 全部通过！\n");
} finally {
  if (dashboard) await dashboard.close();
  if (emptyDashboard) await emptyDashboard.close();
  // 彻底清理临时沙箱目录
  fs.rmSync(tempDir, { recursive: true, force: true });
}
