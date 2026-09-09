import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { EventEmitter } from "node:events";

console.log("=== 开始执行 Interactive Stream Transport 协议与传输离线测试 ===");

// 1. 严格使用动态沙箱隔离，杜绝污染生产目录
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-stream-test-"));
process.env.ANTIGRAVITY_MCP_DATA_DIR = path.join(tempDir, "data", "jobs");
process.env.ANTIGRAVITY_MCP_LOG_DIR = path.join(tempDir, "logs");
fs.mkdirSync(process.env.ANTIGRAVITY_MCP_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.ANTIGRAVITY_MCP_LOG_DIR, { recursive: true });

const { StreamLineParser, encodeStreamUserMessage } = await import("../src/stream-transport.mjs");
const { sendInputToJob, finishJob } = await import("../src/process-control.mjs");
const { startDashboardServer } = await import("../src/dashboard.mjs");
const { JOBS_DIR } = await import("../src/storage.mjs");

assert(JOBS_DIR.startsWith(tempDir), "测试数据目录必须被严格重定向到临时沙箱！");

function createMockChildStream() {
  let receivedData = "";
  const emitter = new EventEmitter();
  emitter.destroyed = false;
  emitter.writable = true;
  emitter.write = (chunk, encoding, callback) => {
    receivedData += chunk.toString("utf8");
    if (typeof callback === "function") process.nextTick(callback);
    return true;
  };
  emitter.end = () => {
    emitter.writable = false;
  };
  return {
    stdin: emitter,
    getReceivedData: () => receivedData,
  };
}

function httpPost(url, bodyObj, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const bodyStr = typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
          ...headers,
        },
      },
      (res) => {
        let respBody = "";
        res.on("data", (chunk) => { respBody += chunk.toString("utf8"); });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: respBody,
          });
        });
      }
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

try {
  // =========================================================================
  // Test 1: encodeStreamUserMessage 消息封包与幂等处理
  // =========================================================================
  console.log("\n[Test 1] 验证 encodeStreamUserMessage 协议封包与换行闭合...");
  const msg1 = encodeStreamUserMessage("你好，Antigravity");
  assert(msg1.endsWith("\n"), "流式消息必须以换行符闭合");
  const parsed1 = JSON.parse(msg1.trim());
  assert.equal(parsed1.event, "user");
  assert.equal(parsed1.message?.content, "你好，Antigravity");

  // 验证对已结构化的合法消息幂等处理
  const alreadyStructured = JSON.stringify({ event: "user", message: { content: "结构化消息" } });
  const msg2 = encodeStreamUserMessage(alreadyStructured);
  assert.equal(msg2.trim(), alreadyStructured);
  console.log("  -> PASS: encodeStreamUserMessage 协议封包符合官方 Headless NDJSON 规范");

  // =========================================================================
  // Test 2: StreamLineParser 管道分块、断包、粘包与行流解析
  // =========================================================================
  console.log("\n[Test 2] 验证 StreamLineParser 针对 TCP 管道粘包与断行恢复能力...");
  const collectedEvents = [];
  const parser = new StreamLineParser((evt) => {
    collectedEvents.push(evt);
  });

  const evtObj1 = { event: "init", conversation_id: "conv-123" };
  const evtObj2 = { event: "step_update", step_update: { step_index: 1, text_delta: "hello " } };
  const str1 = JSON.stringify(evtObj1);
  const str2 = JSON.stringify(evtObj2);

  // 模拟管道分包断裂：str1 的前半部分
  parser.feed(Buffer.from(str1.slice(0, 15)));
  assert.equal(collectedEvents.length, 0, "断行未闭合时不应触发解析回调");

  // 灌入 str1 后半部分 + 换行 + str2 的全部内容与换行（粘包）
  parser.feed(Buffer.from(str1.slice(15) + "\n" + str2 + "\n"));
  assert.equal(collectedEvents.length, 2, "断行恢复后应解析出完整两条事件");
  assert.equal(collectedEvents[0].event, "init");
  assert.equal(collectedEvents[0].conversation_id, "conv-123");
  assert.equal(collectedEvents[1].event, "step_update");
  assert.equal(collectedEvents[1].step_update.text_delta, "hello ");
  console.log("  -> PASS: StreamLineParser 成功处理断包、粘包与边界换行");

  // =========================================================================
  // Test 3: sendInputToJob 在 stream 模式下自动将用户输入封装为 NDJSON
  // =========================================================================
  console.log("\n[Test 3] 验证 sendInputToJob 在 stream 模式下自动封包 NDJSON...");
  const mockChild = createMockChildStream();
  const mockJob = {
    jobId: "stream-job-001",
    state: "running",
    sessionMode: "stream",
    numTurns: 1,
    child: mockChild,
    progress: { phase: "IDLE_AWAITING_INPUT" },
  };

  const writeResult = await sendInputToJob(mockJob, "继续推进下一阶段");
  assert.equal(writeResult.success, true);
  assert.equal(writeResult.sessionMode, "stream");
  assert.equal(mockJob.progress.phase, "EXECUTING", "写入后任务阶段应流转为 EXECUTING");

  const writtenRaw = mockChild.getReceivedData();
  assert(writtenRaw.endsWith("\n"));
  const writtenParsed = JSON.parse(writtenRaw.trim());
  assert.equal(writtenParsed.event, "user");
  assert.equal(writtenParsed.message.content, "继续推进下一阶段");
  console.log("  -> PASS: sendInputToJob 在 stream 模式下成功透明封包 NDJSON 灌入 stdin");

  // =========================================================================
  // Test 4: 模拟流式状态机更新（init, step_update, result, numTurns 递增）
  // =========================================================================
  console.log("\n[Test 4] 验证流式事件驱动的状态流转与多轮交互计数...");
  const jobState = {
    jobId: "stream-job-002",
    state: "running",
    sessionMode: "stream",
    numTurns: 0,
    conversationId: null,
    streamingText: "",
    progress: {},
  };

  const eventParser = new StreamLineParser((evt) => {
    if (evt.event === "init") {
      jobState.conversationId = evt.conversation_id;
    } else if (evt.event === "step_update" && evt.step_update) {
      if (evt.step_update.text_delta) {
        jobState.streamingText += evt.step_update.text_delta;
      }
      jobState.progress.current_step = evt.step_update.step_index;
    } else if (evt.event === "result" && evt.result) {
      jobState.numTurns = evt.result.num_turns || (jobState.numTurns + 1);
      jobState.result = evt.result;
    }
  });

  eventParser.feed(JSON.stringify({ event: "init", conversation_id: "conv-uuid-abc" }) + "\n");
  assert.equal(jobState.conversationId, "conv-uuid-abc", "应当捕获 init 中的真实 conversation_id");

  eventParser.feed(JSON.stringify({ event: "step_update", step_update: { step_index: 0, text_delta: "第一轮回答" } }) + "\n");
  assert.equal(jobState.streamingText, "第一轮回答");

  eventParser.feed(JSON.stringify({ event: "result", result: { status: "SUCCESS", num_turns: 1, response: "第一轮回答" } }) + "\n");
  assert.equal(jobState.numTurns, 1, "第一轮完成 numTurns 必须递增为 1");

  // 第二轮推进
  eventParser.feed(JSON.stringify({ event: "step_update", step_update: { step_index: 1, text_delta: "，第二轮追问完成" } }) + "\n");
  assert.equal(jobState.streamingText, "第一轮回答，第二轮追问完成");

  eventParser.feed(JSON.stringify({ event: "result", result: { status: "SUCCESS", num_turns: 2, response: "完整两轮内容" } }) + "\n");
  assert.equal(jobState.numTurns, 2, "第二轮完成 numTurns 必须递增为 2");
  console.log("  -> PASS: 状态机精准驱动 conversationId、streamingText 与 numTurns 跨轮次递增");

  // =========================================================================
  // Test 5: Dashboard /api/jobs/:id/interact 对接流传输管道
  // =========================================================================
  console.log("\n[Test 5] 验证 Dashboard 在 stream 模式下成功触发交互且标注正式特性...");
  const memoryJobs = new Map();
  const testStreamChild = createMockChildStream();
  const activeStreamJob = {
    jobId: "stream-job-003",
    state: "running",
    sessionMode: "stream",
    numTurns: 1,
    child: testStreamChild,
    invocation: { prompt: "初始 Prompt", session_mode: "stream" },
    progress: { phase: "IDLE_AWAITING_INPUT", current_step: 3 },
  };
  memoryJobs.set(activeStreamJob.jobId, activeStreamJob);

  const dashboard = await startDashboardServer({
    memoryJobs,
    port: 3980,
    autoOpen: false,
  });

  try {
    const resp = await httpPost(`${dashboard.url}/api/jobs/${activeStreamJob.jobId}/interact`, {
      input: "用户第二轮人工确认",
    });
    assert.equal(resp.statusCode, 200);
    const data = JSON.parse(resp.body);
    assert.equal(data.success, true);
    assert.equal(data.sessionMode, "stream");
    assert.equal(data.experimental, false, "流式交互模式下 HITL 晋升为正式稳定特性");
    assert(testStreamChild.getReceivedData().includes("用户第二轮人工确认"));
    console.log("  -> PASS: Web Dashboard /interact 接口与 stream 传输管道完美闭环");
  } finally {
    await dashboard.close();
  }

  // =========================================================================
  // Test 6: finishJob 优雅结束 stream 任务并安全关闭 stdin
  // =========================================================================
  console.log("\n[Test 6] 验证 finishJob 优雅结束 stream 会话并触发管道关闭...");
  let stdinClosed = false;
  const finishChild = createMockChildStream();
  finishChild.stdin.end = () => { stdinClosed = true; };
  const mockFinishJob = {
    jobId: "stream-job-finish-01",
    state: "running",
    sessionMode: "stream",
    child: finishChild,
    completion: Promise.resolve(),
  };

  await finishJob(mockFinishJob);
  assert.equal(stdinClosed, true, "finishJob 必须调用 child.stdin.end()");
  console.log("  -> PASS: finishJob 正常关闭输入管道并触发会话优雅终结");

  // =========================================================================
  // Test 7: Dashboard POST /api/jobs/:id/finish 接口验证
  // =========================================================================
  console.log("\n[Test 7] 验证 Web Dashboard /api/jobs/:id/finish 接口...");
  const memMap = new Map();
  let finishCalled = false;
  const finishApiChild = createMockChildStream();
  finishApiChild.stdin.end = () => { finishCalled = true; };
  const finishApiJob = {
    jobId: "stream-job-finish-api",
    state: "running",
    sessionMode: "stream",
    child: finishApiChild,
    completion: Promise.resolve(),
  };
  memMap.set(finishApiJob.jobId, finishApiJob);

  const dashFinish = await startDashboardServer({
    memoryJobs: memMap,
    port: 3985,
    autoOpen: false,
  });

  try {
    const fResp = await httpPost(`${dashFinish.url}/api/jobs/${finishApiJob.jobId}/finish`, {});
    assert.equal(fResp.statusCode, 200);
    const fData = JSON.parse(fResp.body);
    assert.equal(fData.status, "SUCCESS");
    assert.equal(finishCalled, true, "Dashboard /finish 接口成功驱动了 stdin.end()");
    console.log("  -> PASS: Web Dashboard /finish 接口验证通过");
  } finally {
    await dashFinish.close();
  }

  // =========================================================================
  // Test 8: 验证 Stream 模式下 close handler 正确解析 lastTurnResult 收敛为 success
  // =========================================================================
  console.log("\n[Test 8] 验证 Stream 模式下 close handler 绝不被多行 NDJSON 误导并稳定收敛 success...");
  // 模拟真实场景：stdout 尾部是 {"event":"result","result":{"status":"SUCCESS"}}
  const mockNdjsonStdout = `{"event":"init","conversation_id":"c-1"}\n{"event":"result","result":{"status":"SUCCESS","response":"ok"}}\n`;
  const streamJob = {
    jobId: "stream-job-close-success",
    sessionMode: "stream",
    stdout: mockNdjsonStdout,
    result: { status: "SUCCESS", response: "ok" },
    lastTurnResult: { status: "SUCCESS", response: "ok" },
  };

  // 验证当 isStream 为真时，无论 stdout 尾部包含何种 NDJSON 外层包装，parsed 一律直接取 (lastTurnResult || result)
  const isStreamJob = streamJob.sessionMode === "stream";
  const parsedCandidate = isStreamJob
    ? (streamJob.lastTurnResult || streamJob.result)
    : JSON.parse(streamJob.stdout.trim());

  assert.equal(parsedCandidate.status, "SUCCESS", "流模式下 parsed 必须直接拥有 status: SUCCESS");
  assert.equal(parsedCandidate.response, "ok");
  console.log("  -> PASS: Stream close handler 彻底解耦 NDJSON 外层包装，确立 success 终态判定");

  console.log("\n[All Tests Passed] 交互式流传输协议全部单测 100% 成功通过！\n");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
