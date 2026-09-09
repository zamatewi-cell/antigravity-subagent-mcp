import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

console.log("=== 开始执行 真实 AGY 端到端多轮交互 E2E 测试 (test/hitl-real-agy.e2e.test.mjs) ===");

// 1. 探测本地 AGY CLI 可执行文件路径
function detectAgyCli() {
  if (process.env.AGY_CLI_PATH && fs.existsSync(process.env.AGY_CLI_PATH)) {
    return process.env.AGY_CLI_PATH;
  }
  const winCandidate = "D:\\Antigravity\\agy\\bin\\agy.exe";
  if (process.platform === "win32" && fs.existsSync(winCandidate)) {
    return winCandidate;
  }
  return "agy";
}

const agyPath = detectAgyCli();

// 2. 探查当前环境是否有可用的 agy 二进制
const isAgyAvailable = await new Promise((resolve) => {
  try {
    const probe = spawn(agyPath, ["--version"], { windowsHide: true, shell: false });
    probe.once("error", () => resolve(false));
    probe.once("close", (code) => resolve(code === 0));
  } catch {
    resolve(false);
  }
});

if (!isAgyAvailable) {
  console.log("⚠️ 当前环境未检测到可用的 Antigravity CLI (agy)，自动跳过真实 E2E 测试（CI 兼容）。");
  process.exit(0);
}

console.log(`✔ 已检测到真实 AGY CLI：${agyPath}，开始进行端到端多轮交互验证...`);

// 3. 严格使用临时沙箱隔离，杜绝污染生产目录
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-real-e2e-"));
process.env.ANTIGRAVITY_MCP_DATA_DIR = path.join(tempDir, "data", "jobs");
process.env.ANTIGRAVITY_MCP_LOG_DIR = path.join(tempDir, "logs");
fs.mkdirSync(process.env.ANTIGRAVITY_MCP_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.ANTIGRAVITY_MCP_LOG_DIR, { recursive: true });

const { StreamLineParser, encodeStreamUserMessage } = await import("../src/stream-transport.mjs");
const { sendInputToJob } = await import("../src/process-control.mjs");
const { startDashboardServer } = await import("../src/dashboard.mjs");
const { JOBS_DIR } = await import("../src/storage.mjs");

assert(JOBS_DIR.startsWith(tempDir), "测试数据目录必须被严格重定向到临时沙箱！");

function httpPost(url, bodyObj) {
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
        },
      },
      (res) => {
        let respBody = "";
        res.on("data", (chunk) => { respBody += chunk.toString("utf8"); });
        res.on("end", () => resolve({ statusCode: res.statusCode, body: respBody }));
      }
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

const timeoutTimer = setTimeout(() => {
  console.error("❌ 真实 AGY 端到端交互测试超时（60s）！");
  process.exit(1);
}, 60000);

try {
  // 启动真实子进程，进入 stream-json 交互管道
  const child = spawn(agyPath, [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--dangerously-skip-permissions",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    windowsHide: true,
  });

  const job = {
    jobId: "real-agy-job-e2e",
    state: "running",
    sessionMode: "stream",
    numTurns: 0,
    conversationId: null,
    child,
    turn1Result: null,
    turn2Result: null,
  };

  const memoryJobs = new Map();
  memoryJobs.set(job.jobId, job);

  // 启动看板服务供 HTTP 注入测试
  const dashboard = await startDashboardServer({
    memoryJobs,
    port: 3995,
    autoOpen: false,
  });

  const streamParser = new StreamLineParser(async (evt) => {
    if (evt.event === "init") {
      job.conversationId = evt.conversation_id;
      console.log(`[E2E 握手成功] 收到 init 事件，提取 conversation_id: ${job.conversationId}`);
    } else if (evt.event === "result") {
      const turnNum = evt.result?.num_turns || (job.numTurns + 1);
      job.numTurns = turnNum;
      console.log(`[E2E 轮次完成] 收到 Turn ${turnNum} 结果:`, evt.result?.response ? evt.result.response.slice(0, 80).replace(/\r?\n/g, ' ') : "");
      
      if (turnNum === 1) {
        job.turn1Result = evt.result;
        console.log(">>> [E2E] 第一轮成功收到！正在通过 Dashboard POST /api/jobs/:id/interact 注入第二轮指令...");
        
        // 通过真实 Dashboard HTTP 接口注入第二轮交互
        const interactResp = await httpPost(`${dashboard.url}/api/jobs/${job.jobId}/interact`, {
          input: "收到第一轮了！现在请回复第二轮指令，回复中必须严格包含单词 REAL_STREAM_TURN_2_OK。",
        });
        assert.equal(interactResp.statusCode, 200, "Dashboard /interact 接口必须响应 200");
        const interactData = JSON.parse(interactResp.body);
        assert.equal(interactData.success, true);
        assert.equal(interactData.sessionMode, "stream");
        assert.equal(interactData.experimental, false);
        console.log(">>> [E2E] 第二轮指令已通过 Dashboard 安全管道注入子进程 stdin！");
      } else if (turnNum === 2) {
        job.turn2Result = evt.result;
        console.log(">>> [E2E] 第二轮成功收到！正在关闭 stdin 触发子进程优雅退出...");
        child.stdin.end();
      }
    }
  });

  child.stdout.on("data", (chunk) => streamParser.feed(chunk));
  child.stderr.on("data", (chunk) => {
    // 捕获 stderr 用于排错
    const errText = chunk.toString("utf8").trim();
    if (errText) console.log(`[AGY STDERR]: ${errText}`);
  });

  // 1. 发送第一轮 Prompt 启动多轮会话
  const turn1Msg = encodeStreamUserMessage("请回复一条简短问候，回复中必须严格包含单词 REAL_STREAM_TURN_1_OK。");
  console.log(">>> [E2E] 正在下发第一轮 Prompt 启动交互流...");
  child.stdin.write(turn1Msg);

  // 等待子进程优雅退出
  const exitCode = await new Promise((resolve) => {
    child.once("close", (code) => resolve(code));
  });

  streamParser.flush();
  await dashboard.close();

  console.log(`✔ 子进程优雅退出，Exit Code: ${exitCode}`);
  assert.equal(exitCode, 0, "AGY 进程在多轮交互后必须以 0 优雅退出");
  assert.ok(job.conversationId, "必须捕获到真实 conversation_id");
  assert.equal(job.numTurns, 2, "多轮交互总轮数必须严格为 2");
  
  // 验证两轮模型输出中的核心标记
  const text1 = job.turn1Result?.response || "";
  const text2 = job.turn2Result?.response || "";
  assert(text1.includes("REAL_STREAM_TURN_1_OK"), `第一轮输出必须包含目标标记，实际输出: ${text1}`);
  assert(text2.includes("REAL_STREAM_TURN_2_OK"), `第二轮输出必须包含目标标记，实际输出: ${text2}`);

  console.log("\n[All Assertions Passed] 真实 AGY 端到端 E2E 双轮交互闭环 100% 成功！\n");
} finally {
  clearTimeout(timeoutTimer);
  fs.rmSync(tempDir, { recursive: true, force: true });
}
