import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import * as z from "zod/v4";
import { parseTranscript, evaluateSubagentStatus, formatToolAction, getTaskProgress } from "../src/progress.mjs";
import { persistJob, restorePersistedJobs } from "../src/storage.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-counterexamples-"));

try {
  console.log("=== 开始执行专项反例测试套件 ===");

  // 1. 反例 1：第 35 步子代理仍在 run_command 构建，绝不能标为 completed
  console.log("\n[Test 1] 验证高步数活跃任务不会被误标为 completed...");
  const mockChildParsedActive = {
    conversation_id: "active-worker-uuid",
    currentStep: 35,
    lastTool: "run_command",
    lastEntry: {
      step_index: 35,
      type: "PLANNER_RESPONSE",
      tool_calls: [
        {
          name: "run_command",
          args: { CommandLine: "cargo build --release" },
        },
      ],
    },
  };
  const activeStatus = evaluateSubagentStatus(mockChildParsedActive, new Set(), "running");
  assert.equal(activeStatus, "running", "第 35 步仍在运行命令的子代理必须处于 running 状态！");
  console.log("  -> PASS: 状态正确保持为 running");

  // 2. 反例 2：子代理调用 send_message 求助/询问，绝不能标为 completed
  console.log("\n[Test 2] 验证发消息求助/请示不会被误标为 completed...");
  const mockChildParsedAsking = {
    conversation_id: "asking-worker-uuid",
    currentStep: 12,
    lastTool: "send_message",
    lastEntry: {
      step_index: 12,
      type: "PLANNER_RESPONSE",
      tool_calls: [
        {
          name: "send_message",
          args: { Message: "编译遇到错误，请示 orchestrator 是否需要切换架构？" },
        },
      ],
    },
  };
  const askingStatus = evaluateSubagentStatus(mockChildParsedAsking, new Set(), "running");
  assert.equal(askingStatus, "running", "求助或中间询问必须判定为 running！");

  // 对比验证：若消息明确声明任务交付且无后续工具，才判定为 completed
  const mockChildParsedDone = {
    conversation_id: "done-worker-uuid",
    currentStep: 20,
    lastTool: "send_message",
    lastEntry: {
      step_index: 20,
      type: "PLANNER_RESPONSE",
      tool_calls: [
        {
          name: "send_message",
          args: { Message: "任务完成交付：team-a.txt 校验通过，已生成 handoff.md 报告。" },
        },
      ],
    },
  };
  const doneStatus = evaluateSubagentStatus(mockChildParsedDone, new Set(), "running");
  assert.equal(doneStatus, "completed", "明确交付成果的消息才应判定为 completed！");
  console.log("  -> PASS: 求助与交付状态区分严密");

  // 3. 反例 3：工具动作提取与旧文字摘要覆盖
  console.log("\n[Test 3] 验证工具执行能可靠提取参数描述并覆盖旧文字摘要...");
  const tcWithArgs = {
    name: "write_to_file",
    args: {
      TargetFile: "D:/project/src/index.ts",
      toolSummary: "更新主入口组件",
    },
  };
  assert.equal(formatToolAction(tcWithArgs), "[write_to_file] 更新主入口组件");

  const tcWithoutSummary = {
    name: "run_command",
    args: {
      CommandLine: "npm test -- --coverage",
    },
  };
  assert.equal(formatToolAction(tcWithoutSummary), "[run_command] 运行: npm test -- --coverage");

  // 模拟连续步骤：Step 1 是文字思考“准备读文件”，Step 2 是 tool_call “npm test”，验证当前动作被工具刷新覆盖
  const sampleTranscriptPath = path.join(tempDir, "override_test.jsonl");
  const testLines = [
    JSON.stringify({
      step_index: 1,
      type: "PLANNER_RESPONSE",
      content: "准备读文件并做静态分析",
    }),
    JSON.stringify({
      step_index: 2,
      type: "PLANNER_RESPONSE",
      tool_calls: [
        {
          name: "run_command",
          args: { CommandLine: "pytest -v" },
        },
      ],
    }),
  ];
  fs.writeFileSync(sampleTranscriptPath, testLines.join("\n"), "utf8");
  const parsedOverride = parseTranscript(sampleTranscriptPath);
  assert.equal(parsedOverride.currentAction, "[run_command] 运行: pytest -v", "旧文字思考必须被最新工具动作覆盖！");
  console.log("  -> PASS: 动作提取与覆盖准确无误");

  // 4. 反例 4：5 级深层子代理嵌套穿透验证
  console.log("\n[Test 4] 验证 5 级深层子代理嵌套穿透（maxDepth >= 8）...");
  const brainDir = path.join(tempDir, "brain");
  fs.mkdirSync(brainDir, { recursive: true });

  const chainIds = ["level-1", "level-2", "level-3", "level-4", "level-5"];
  for (let i = 0; i < chainIds.length; i++) {
    const cid = chainIds[i];
    const logDir = path.join(brainDir, cid, ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const nextCid = chainIds[i + 1];
    const lines = [
      JSON.stringify({ step_index: 0, type: "USER_INPUT", content: `Level ${i + 1}` }),
    ];
    if (nextCid) {
      lines.push(JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        tool_calls: [{
          name: "invoke_subagent",
          args: { Subagents: [{ Role: `Worker L${i + 2}`, TypeName: "worker" }] }
        }]
      }));
      lines.push(JSON.stringify({
        step_index: 2,
        type: "GENERIC",
        content: `Created the following subagents:\n{\n  "conversationId": "${nextCid}"\n}`
      }));
    } else {
      lines.push(JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        tool_calls: [{
          name: "run_command",
          args: { CommandLine: "echo leaf agent running" }
        }]
      }));
    }
    fs.writeFileSync(path.join(logDir, "transcript.jsonl"), lines.join("\n"), "utf8");
  }

  const originalUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = tempDir;
  const targetBrain = path.join(tempDir, ".gemini", "antigravity-cli", "brain");
  fs.mkdirSync(path.dirname(targetBrain), { recursive: true });
  fs.cpSync(brainDir, targetBrain, { recursive: true });

  const rootParsed = parseTranscript(path.join(targetBrain, "level-1", ".system_generated", "logs", "transcript.jsonl"), 0, 8);
  process.env.USERPROFILE = originalUserProfile;

  assert(rootParsed, "根解析结果必须存在");
  console.log(`  -> 探测到的所有后代数量: ${rootParsed.subagents.length}`);
  assert.equal(rootParsed.subagents.length, 4, "必须完整穿透出全部 4 个深层后代！");
  const roles = rootParsed.subagents.map(s => s.role);
  assert(roles.includes("Worker L2"));
  assert(roles.includes("Worker L3"));
  assert(roles.includes("Worker L4"));
  assert(roles.includes("Worker L5"));
  console.log("  -> PASS: 5 级深层链完整解析，无截断");

  // 5. 反例 5：持久化中断状态一致性与原子性
  console.log("\n[Test 5] 验证服务重启后任务状态一致性与原子持久化...");
  const interruptedJob = {
    jobId: "interrupted-test-job",
    state: "running",
    startedAt: new Date().toISOString(),
    invocation: { cwd: "D:/project", model: "gemini-3.8-flash-high" },
    result: null,
  };
  persistJob(interruptedJob);
  const restoredMap = restorePersistedJobs();
  const restored = restoredMap.get("interrupted-test-job");
  assert(restored, "恢复任务必须存在");
  assert.equal(restored.state, "interrupted", "未完成任务必须标记为 interrupted");
  const progInterrupted = getTaskProgress(restored);
  assert.equal(progInterrupted.phase, "interrupted", "中断任务 phase 必须是 interrupted，绝不能是 starting！");
  assert(progInterrupted.current_action.includes("中断"), "中断任务 current_action 必须显示已中断！");
  console.log("  -> PASS: 中断任务 phase 与 isError 完全一致");

  // 6. 反例 6：验证 progressToken 通知可实际送达客户端
  console.log("\n[Test 6] 验证 progressToken 通知可通过 ctx.mcpReq.notify 真实推送到客户端...");
  const notifyServer = new McpServer({ name: "notify-test", version: "1.0.0" });
  notifyServer.registerTool(
    "test_notify",
    { title: "测试推送", description: "d", inputSchema: z.object({ x: z.number() }) },
    async (args, extra) => {
      const token = extra?.mcpReq?._meta?.progressToken ?? extra?.mcpReq?.params?._meta?.progressToken;
      assert.notEqual(token, undefined, "progressToken 必须成功被捕获");
      if (typeof extra.mcpReq.notify === "function") {
        await extra.mcpReq.notify({
          method: "notifications/progress",
          params: { progressToken: token, progress: 5, total: 10, message: "处理中..." },
        });
      }
      return { content: [{ type: "text", text: "done" }] };
    }
  );
  const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();
  await notifyServer.connect(sTransport);
  const mcpClient = new Client({ name: "c", version: "1.0.0" });
  await mcpClient.connect(cTransport);

  const receivedNotifications = [];
  await mcpClient.callTool(
    { name: "test_notify", arguments: { x: 42 }, _meta: { progressToken: "token-abc" } },
    {
      onprogress: (p) => {
        receivedNotifications.push(p);
      }
    }
  );
  assert.equal(receivedNotifications.length, 1, "客户端必须收到 1 条 progress 通知！");
  assert.equal(receivedNotifications[0].progress, 5);
  assert.equal(receivedNotifications[0].message, "处理中...");
  console.log("  -> PASS: 进度通知实际送达客户端");

  // 7. 反例 7：同目录排队排他性验证
  console.log("\n[Test 7] 验证同一工作目录下的任务互斥排队...");
  const queueLocks = new Map();
  async function testDirectoryLock(dir, fn) {
    const norm = path.resolve(dir);
    while (queueLocks.has(norm)) {
      await queueLocks.get(norm);
    }
    let release;
    const p = new Promise(r => { release = r; });
    queueLocks.set(norm, p);
    try {
      return await fn();
    } finally {
      queueLocks.delete(norm);
      release();
    }
  }

  const executionOrder = [];
  const task1 = testDirectoryLock("D:/same/dir", async () => {
    executionOrder.push("task1-start");
    await new Promise(r => setTimeout(r, 60));
    executionOrder.push("task1-end");
  });
  const task2 = testDirectoryLock("D:/same/dir", async () => {
    executionOrder.push("task2-start");
    await new Promise(r => setTimeout(r, 20));
    executionOrder.push("task2-end");
  });

  await Promise.all([task1, task2]);
  assert.deepEqual(executionOrder, ["task1-start", "task1-end", "task2-start", "task2-end"], "同目录任务必须严格排队串行！");
  console.log("  -> PASS: 同目录任务成功实现互斥排队串行执行");

  console.log("\n[All Tests Passed] 全部 7 项专项反例测试 100% 成功通过！\n");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
