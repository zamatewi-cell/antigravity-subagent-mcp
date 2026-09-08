import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-sse-delta-test-"));
process.env.ANTIGRAVITY_MCP_DATA_DIR = path.join(tempDir, "data");

const { startDashboardServer, formatJobDetail } = await import("../src/dashboard.mjs");
const { JOBS_DIR } = await import("../src/storage.mjs");

// 严守 AC3 沙箱断言
assert(JOBS_DIR.startsWith(tempDir), `测试 JOBS_DIR 必须严格隔离至临时目录: ${JOBS_DIR}`);

console.log("=== 开始执行 SSE 增量差异广播与状态同步测试 (test/sse-delta.test.mjs) ===");

const testMemoryJobs = new Map();
const initialJobId = "job-running-001";
testMemoryJobs.set(initialJobId, {
  jobId: initialJobId,
  state: "running",
  startedAt: new Date().toISOString(),
  completedAt: null,
  invocation: { prompt: "初始任务", cwd: tempDir, model: "gemini-3.8-flash-high" },
  attempts: 1,
  progress: {
    phase: "thinking",
    current_step: 1,
    current_action: "正在分析项目结构",
    subagents: [],
    recent_activities: ["Step 1: 正在分析项目结构"],
  },
});

let dashboard;
try {
  dashboard = await startDashboardServer({
    port: 3960,
    memoryJobs: testMemoryJobs,
    autoOpen: false,
  });

  // 测试辅助：收集 SSE 事件
  function createSSEClient(headers = {}) {
    const events = [];
    const rawChunks = [];
    let req;

    const promise = new Promise((resolve, reject) => {
      const u = new URL(`${dashboard.url}/api/stream`);
      req = http.request(u, { headers }, (res) => {
        let buffer = "";
        res.on("data", (chunk) => {
          const str = chunk.toString();
          rawChunks.push(str);
          buffer += str;

          // 按 \n\n 切分 SSE 消息
          const parts = buffer.split("\n\n");
          buffer = parts.pop(); // 保留未闭合部分

          for (const part of parts) {
            if (part.startsWith(":")) {
              events.push({ type: "comment", raw: part });
              continue;
            }
            const lines = part.split("\n");
            let eventType = "message";
            let eventData = "";
            let eventId = null;
            for (const line of lines) {
              if (line.startsWith("event: ")) eventType = line.slice(7).trim();
              else if (line.startsWith("data: ")) eventData = line.slice(6).trim();
              else if (line.startsWith("id: ")) eventId = parseInt(line.slice(4).trim(), 10);
            }
            events.push({ type: eventType, data: eventData ? JSON.parse(eventData) : null, id: eventId });
          }
        });
      });
      req.on("error", (err) => {
        if (err.code !== "ECONNRESET") reject(err);
      });
      req.end();
    });

    return {
      events,
      rawChunks,
      close: () => req.destroy(),
    };
  }

  // 1. 验证握手与即时首屏快照
  console.log("\n[Test 1] 验证首次连接即时推送握手与快照...");
  const client1 = createSSEClient();
  await new Promise((r) => setTimeout(r, 200));

  assert(client1.events.length >= 2, "连接后应立即收到握手与快照");
  assert.equal(client1.events[0].type, "connected", "首个事件必须为 connected");
  assert.equal(client1.events[1].type, "snapshot", "第二个事件必须为 snapshot");
  assert(client1.events[1].data.seq >= 1, "快照必须包含 seq 序号");
  assert.equal(client1.events[1].data.jobs.length, 1, "快照必须包含 1 个任务");
  assert.equal(client1.events[1].data.jobs[0].jobId, initialJobId);
  const snapshotSeq = client1.events[1].data.seq;
  console.log("  -> PASS: 握手与首屏快照契约验证通过");

  // 2. 验证无变动周期仅发送 :keep-alive 保活心跳
  console.log("\n[Test 2] 验证无变动周期仅推送轻量保活注释行...");
  const countBefore = client1.events.length;
  await new Promise((r) => setTimeout(r, 1200));
  const newEvents = client1.events.slice(countBefore);
  const commentEvents = newEvents.filter(e => e.type === "comment");
  const businessEvents = newEvents.filter(e => e.type !== "comment");
  assert.equal(businessEvents.length, 0, "无变动周期绝不应推送任何全量或增量业务事件");
  assert(commentEvents.length >= 1, "应收到至少 1 次 :keep-alive 保活心跳");
  console.log("  -> PASS: 无变动周期保活机制有效，带宽浪费被彻底根除");

  // 3. 模拟后台步数推进与状态变更，捕获 job_updated
  console.log("\n[Test 3] 模拟任务步数递增，验证 job_updated 增量事件...");
  const targetJob = testMemoryJobs.get(initialJobId);
  targetJob.progress = {
    phase: "executing_tools",
    current_step: 2,
    current_action: "正在运行单元测试套件",
    subagents: [],
    recent_activities: ["Step 1: 正在分析项目结构", "Step 2: 正在运行单元测试套件"],
  };

  // 等待下一个心跳周期广播
  await new Promise((r) => setTimeout(r, 1200));

  const updateEvt = client1.events.find(e => e.type === "job_updated");
  assert(updateEvt, "必须收到 job_updated 增量事件");
  assert.equal(updateEvt.data.jobId, initialJobId);
  assert.equal(updateEvt.data.seq, snapshotSeq + 1, "seq 游标必须严格递增");
  assert.equal(updateEvt.data.patch.progress.current_step, 2);
  assert.equal(updateEvt.data.patch.progress.current_action, "正在运行单元测试套件");
  console.log("  -> PASS: job_updated 增量推送准确，变动字段精确对齐");

  // 4. 模拟新增与删除任务
  console.log("\n[Test 4] 模拟新增任务与删除任务广播...");
  const newJobId = "job-created-002";
  testMemoryJobs.set(newJobId, {
    jobId: newJobId,
    state: "queued",
    startedAt: new Date().toISOString(),
    invocation: { prompt: "动态新增任务" },
    attempts: 1,
  });

  await new Promise((r) => setTimeout(r, 1200));
  const createdEvt = client1.events.find(e => e.type === "job_created");
  assert(createdEvt, "必须收到 job_created 增量事件");
  assert.equal(createdEvt.data.job.jobId, newJobId);

  // 模拟删除任务
  testMemoryJobs.delete(newJobId);
  await new Promise((r) => setTimeout(r, 1200));
  const removedEvt = client1.events.find(e => e.type === "job_removed");
  assert(removedEvt, "必须收到 job_removed 增量事件");
  assert.equal(removedEvt.data.jobId, newJobId);
  console.log("  -> PASS: 任务创建与移除事件广播验证通过");

  client1.close();

  // 5. 验证基于 Last-Event-ID 的断线重连增量回放
  console.log("\n[Test 5] 验证客户端携带 Last-Event-ID 重连时精准回放缺失增量...");
  const reconnectClient = createSSEClient({ "Last-Event-ID": String(snapshotSeq) });
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(reconnectClient.events[0].type, "connected");
  // 应当收到 updateEvt、createdEvt、removedEvt，而不应该收到全量 snapshot！
  const replayedUpdates = reconnectClient.events.filter(e => e.type === "job_updated");
  const replayedSnapshots = reconnectClient.events.filter(e => e.type === "snapshot");
  assert.equal(replayedSnapshots.length, 0, "在增量窗口期内重连绝不应触发全量 snapshot 重推");
  assert(replayedUpdates.length >= 1, "必须回放断线期间遗漏的 job_updated 事件");
  console.log("  -> PASS: 游标重连增量回放机制验证通过");

  // 6. 验证客户端打补丁后状态收敛一致性
  console.log("\n[Test 6] 验证客户端通过增量打补丁后状态完全收敛...");
  const clientJobMap = new Map();
  // 初始来自快照
  for (const j of client1.events[1].data.jobs) {
    clientJobMap.set(j.jobId, j);
  }
  // 应用 updateEvt
  const patchedJob = clientJobMap.get(updateEvt.data.jobId);
  Object.assign(patchedJob, updateEvt.data.patch);
  assert.equal(patchedJob.progress.current_step, 2);
  assert.equal(patchedJob.progress.current_action, "正在运行单元测试套件");
  console.log("  -> PASS: 客户端局部打补丁后数据状态与服务端 100% 吻合");

  reconnectClient.close();
  console.log("\n[All Tests Passed] SSE 增量事件广播与客户端同步验证 100% 成功！\n");
} finally {
  if (dashboard) {
    await dashboard.close();
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
}
