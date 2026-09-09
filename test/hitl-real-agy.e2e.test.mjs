import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

console.log("=== 开始执行 生产级 MCP 真实 AGY 端到端 E2E 完整生命周期测试 ===");

// 1. 探测本地 AGY CLI
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

console.log(`✔ 已检测到真实 AGY CLI：${agyPath}`);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-prod-e2e-"));
const dataDir = path.join(tempDir, "data", "jobs");
const logDir = path.join(tempDir, "logs");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });

// 2. 启动生产 MCP 进程并连接 Stdio 传输通道
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(rootDir, "src/server.mjs")],
  env: {
    ...process.env,
    AGY_CLI_PATH: agyPath,
    ANTIGRAVITY_MCP_DATA_DIR: dataDir,
    ANTIGRAVITY_MCP_LOG_DIR: logDir,
  },
  stderr: "pipe",
});

const client = new Client({ name: "prod-e2e-client", version: "1.5.1" });

const call = async (name, args) => {
  const response = await client.callTool({ name, arguments: args }, { timeout: 45_000 });
  return { isError: response.isError, ...JSON.parse(response.content[0].text) };
};

const timeoutTimer = setTimeout(() => {
  console.error("❌ 生产级 MCP 端到端交互测试全局超时（90s）！");
  process.exit(1);
}, 90000);

try {
  await client.connect(transport);
  console.log("✔ 已成功连接生产 MCP 服务 (stdio)");

  // 1. 通过生产 MCP 工具 start_gemini_task 启动流式交互任务
  console.log(">>> [E2E Step 1] 调用 start_gemini_task(session_mode: 'stream')...");
  const started = await call("start_gemini_task", {
    prompt: "请回复一条简短问候，回复中必须严格包含单词 PROD_E2E_TURN_1_OK。",
    session_mode: "stream",
    working_directory: tempDir,
  });

  const jobId = started.job_id;
  assert.ok(jobId, "start_gemini_task 必须返回 job_id");
  assert.equal(started.state, "running");
  assert.equal(started.session_mode, "stream");
  console.log(`✔ 任务成功启动，Job ID: ${jobId}`);

  // 2. 轮询 get_gemini_task 等待第 1 轮完成
  console.log(">>> [E2E Step 2] 等待第 1 轮回复与 conversation_id 捕获...");
  let currentJob = null;
  const deadline1 = Date.now() + 40000;
  while (Date.now() < deadline1) {
    currentJob = await call("get_gemini_task", { job_id: jobId });
    if (currentJob.num_turns >= 1 && currentJob.result?.response) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  assert.ok(currentJob, "get_gemini_task 必须返回有效任务对象");
  assert.equal(currentJob.state, "running", "第一轮完成后任务必须保持 running 态以支持多轮交互");
  assert.equal(currentJob.num_turns, 1, "第一轮计数必须为 1");
  assert.ok(currentJob.conversation_id, "必须成功捕获原生 conversation_id");
  assert(
    currentJob.result?.response?.includes("PROD_E2E_TURN_1_OK"),
    `第一轮回复必须包含目标标记，实际输出: ${currentJob.result?.response}`
  );
  console.log(`✔ 第 1 轮成功捕获！conversation_id: ${currentJob.conversation_id}`);
  console.log(`  -> 回复预览: ${currentJob.result.response.slice(0, 60).replace(/\r?\n/g, " ")}`);

  // 3. 通过生产 MCP 工具 interact_gemini_task 注入第 2 轮指令
  console.log(">>> [E2E Step 3] 调用 interact_gemini_task 注入第 2 轮输入...");
  const interacted = await call("interact_gemini_task", {
    job_id: jobId,
    input: "收到第一轮了！现在请回复第二轮指令，回复中必须严格包含单词 PROD_E2E_TURN_2_OK。",
  });
  assert.equal(interacted.status, "SUCCESS");
  assert.equal(interacted.session_mode, "stream");
  console.log("✔ 第 2 轮输入成功送入子进程 stdin");

  // 4. 轮询 get_gemini_task 等待第 2 轮完成
  console.log(">>> [E2E Step 4] 等待第 2 轮回复...");
  const deadline2 = Date.now() + 40000;
  while (Date.now() < deadline2) {
    currentJob = await call("get_gemini_task", { job_id: jobId });
    if (currentJob.num_turns >= 2 && currentJob.result?.response?.includes("PROD_E2E_TURN_2_OK")) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  assert.equal(currentJob.state, "running", "第二轮完成后任务仍处于等待收敛状态");
  assert.equal(currentJob.num_turns, 2, "第二轮计数必须为 2");
  assert(
    currentJob.result?.response?.includes("PROD_E2E_TURN_2_OK"),
    `第二轮回复必须包含目标标记，实际输出: ${currentJob.result?.response}`
  );
  console.log("✔ 第 2 轮成功捕获！");
  console.log(`  -> 回复预览: ${currentJob.result.response.slice(0, 60).replace(/\r?\n/g, " ")}`);

  // 5. 调用生产 MCP 工具 finish_gemini_task 优雅结束会话
  console.log(">>> [E2E Step 5] 调用 finish_gemini_task 触发正常关闭与 success 收敛...");
  const finished = await call("finish_gemini_task", { job_id: jobId });

  // 6. 终极业务断言：state 必须为 success，result.status 为 SUCCESS，num_turns 为 2
  assert.equal(finished.state, "success", "任务状态必须成功收敛为 success 终态");
  assert.equal(finished.result?.status, "SUCCESS", "结果状态必须为 SUCCESS");
  assert.equal(finished.num_turns, 2, "总交互轮数必须精确为 2");
  assert.ok(finished.completed_at, "必须记录完成时间 completed_at");
  console.log("✔ 任务优雅关闭并成功收敛进入 success 终态！");

  console.log("\n[All Assertions Passed] 生产级 MCP 真实 AGY 端到端 E2E 完整生命周期闭环 100% 成功！\n");
} finally {
  clearTimeout(timeoutTimer);
  try { await client.close(); } catch {}
  try {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
}
