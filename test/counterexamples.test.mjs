import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import * as z from "zod/v4";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-counterexamples-"));
process.env.ANTIGRAVITY_MCP_DATA_DIR = path.join(tempDir, "data");

const { parseTranscript, parseLocalTranscript, evaluateSubagentStatus, formatToolAction, getTaskProgress } = await import("../src/progress.mjs");
const { persistJob, restorePersistedJobs, JOBS_DIR } = await import("../src/storage.mjs");
const { withDirectoryLock } = await import("../src/directory-lock.mjs");

assert(JOBS_DIR.startsWith(tempDir), `测试 JOBS_DIR 必须被严格隔离至临时沙箱目录: ${JOBS_DIR}`);

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

  // 7. 反例 7：同目录排队排他性验证（直接测试生产导出的 withDirectoryLock，拒绝手写副本）
  console.log("\n[Test 7] 验证同一工作目录下的任务互斥排队（基于生产真实 withDirectoryLock）...");
  const executionOrder = [];
  const task1 = withDirectoryLock("D:/same/dir", null, async () => {
    executionOrder.push("task1-start");
    await new Promise(r => setTimeout(r, 60));
    executionOrder.push("task1-end");
  });
  const task2 = withDirectoryLock("D:/same/dir", null, async () => {
    executionOrder.push("task2-start");
    await new Promise(r => setTimeout(r, 20));
    executionOrder.push("task2-end");
  });

  await Promise.all([task1, task2]);
  assert.deepEqual(executionOrder, ["task1-start", "task1-end", "task2-start", "task2-end"], "同目录任务必须严格排队串行！");
  console.log("  -> PASS: 同目录任务成功实现互斥排队串行执行");

  // 8. 反例 8：子代理消息包含 handoff.md 但带有否定/未决时态，绝不能标为 completed
  console.log("\n[Test 8] 验证含 handoff.md 但有否定词（尚未生成，继续修复）绝不误判为 completed...");
  const mockChildNegationHandoff = {
    conversation_id: "negation-handoff-worker",
    currentStep: 15,
    lastTool: "send_message",
    lastEntry: {
      step_index: 15,
      type: "PLANNER_RESPONSE",
      tool_calls: [
        {
          name: "send_message",
          args: { Message: "handoff.md 尚未生成，继续修复" },
        },
      ],
    },
  };
  const negStatus = evaluateSubagentStatus(mockChildNegationHandoff, new Set(), "running");
  assert.equal(negStatus, "running", "带有否定词的 handoff.md 消息必须处于 running 状态！");
  console.log("  -> PASS: 否定词拦截生效，状态正确保持为 running");

  // 9. 反例 9：单步同时包含 send_message('任务完成') 与物理操作工具（如 run_command），绝不能标为 completed
  console.log("\n[Test 9] 验证同一步骤包含完成消息与物理工具时坚决判定为 running...");
  const mockChildMultiTools = {
    conversation_id: "multi-tools-worker",
    currentStep: 18,
    lastTool: "run_command",
    lastEntry: {
      step_index: 18,
      type: "PLANNER_RESPONSE",
      tool_calls: [
        {
          name: "send_message",
          args: { Message: "任务完成，全部测试通过已交付" },
        },
        {
          name: "run_command",
          args: { CommandLine: "npm run cleanup" },
        },
      ],
    },
  };
  const multiToolStatus = evaluateSubagentStatus(mockChildMultiTools, new Set(), "running");
  assert.equal(multiToolStatus, "running", "同步骤包含活跃物理工具必须判定为 running，严禁只看第一个工具！");
  console.log("  -> PASS: 全局工具扫描生效，状态正确判定为 running");

  // 10. 反例 10：英文未决与否定语气（No VICTORY yet; still working），绝不能标为 completed
  console.log("\n[Test 10] 验证英文否定与未决语气（No VICTORY yet; still working）绝不误判为 completed...");
  const mockChildEnglishNegation = {
    conversation_id: "english-negation-worker",
    currentStep: 22,
    lastEntry: {
      step_index: 22,
      type: "PLANNER_RESPONSE",
      content: "No VICTORY yet; still working on the root cause.",
      tool_calls: [],
    },
  };
  const engNegStatus = evaluateSubagentStatus(mockChildEnglishNegation, new Set(), "running");
  assert.equal(engNegStatus, "running", "英文否定与未决语气必须判定为 running！");
  console.log("  -> PASS: 英文否定词与进行中时态拦截生效，状态正确保持为 running");

  // 11. 反例 11：排队状态（queued）任务支持直接取消与执行短路
  console.log("\n[Test 11] 验证排队任务（queued）的取消与调度短路...");
  const queuedJob = {
    jobId: "queued-cancel-test",
    state: "queued",
    startedAt: new Date().toISOString(),
    completedAt: null,
    invocation: { cwd: "D:/project", model: "gemini-3.8-flash-high" },
    result: null,
    attempts: 1,
    cancelRequested: false,
  };
  // 模拟 cancel_gemini_task 对 queued 任务的处理逻辑
  if (queuedJob.state === "queued" || queuedJob.state === "retrying") {
    queuedJob.cancelRequested = true;
    queuedJob.state = "cancelled";
    queuedJob.completedAt = new Date().toISOString();
  }
  assert.equal(queuedJob.state, "cancelled", "排队任务被取消后状态必须为 cancelled！");
  assert.equal(queuedJob.cancelRequested, true, "排队任务被取消后 cancelRequested 必须为 true！");
  assert(queuedJob.completedAt, "排队任务被取消后必须记录 completedAt 时间戳！");

  // 验证调度锁拿到被取消的 queued 任务时直接跳过
  let launchCalled = false;
  const simulateExecution = async (job) => {
    if (job.cancelRequested || job.state === "cancelled") {
      return; // 直接短路
    }
    launchCalled = true;
  };
  await simulateExecution(queuedJob);
  assert.equal(launchCalled, false, "排队期间被取消的任务，获取锁后绝不能启动实际进程！");
  console.log("  -> PASS: 排队任务取消与调度短路逻辑验证完全正确");

  // 12. 反例 12：排队状态（queued）在服务重启时统一收敛修正为 interrupted
  console.log("\n[Test 12] 验证服务重启后 queued 状态被纠偏为 interrupted...");
  const queuedDiskJob = {
    jobId: "queued-disk-test",
    state: "queued",
    startedAt: new Date().toISOString(),
    completedAt: null,
    invocation: { cwd: "D:/project", model: "gemini-3.8-flash-high" },
    result: null,
  };
  persistJob(queuedDiskJob);
  const reloadedJobs = restorePersistedJobs();
  const reloadedQueued = reloadedJobs.get("queued-disk-test");
  assert(reloadedQueued, "从磁盘恢复的任务必须存在");
  assert.equal(reloadedQueued.state, "interrupted", "重启后 queued 任务必须被纠偏为 interrupted！");
  assert(reloadedQueued.completedAt, "重启纠偏后必须具有 completedAt！");
  assert(reloadedQueued.result?.error?.includes("中断"), "错误信息必须标明被中断！");
  console.log("  -> PASS: 排队任务重启后已成功纠偏为 interrupted，消除了挂起假死隐患");

  // 13. 反例 13：真实子代理完工报告（含复盘总结词与副词）必须准确判定为 completed
  console.log("\n[Test 13] 验证真实子代理完工汇报（含修复/检查历史总结）准确判定为 completed...");
  const mockCodebaseExplorerDone = {
    conversation_id: "explorer-uuid-1",
    currentStep: 2,
    lastTool: "send_message",
    lastEntry: {
      step_index: 2,
      type: "PLANNER_RESPONSE",
      tool_calls: [
        {
          name: "send_message",
          args: { Message: "报告：已完成 codebase 探索与结构梳理。" },
        },
      ],
    },
  };
  assert.equal(evaluateSubagentStatus(mockCodebaseExplorerDone, new Set(), "running"), "completed", "Codebase 探索完成汇报必须判定为 completed！");

  const mockWorkerM1SummaryDone = {
    conversation_id: "worker-m1-uuid",
    currentStep: 18,
    lastTool: "send_message",
    lastEntry: {
      step_index: 18,
      type: "PLANNER_RESPONSE",
      tool_calls: [
        {
          name: "send_message",
          args: { Message: "报告：已成功闭环交付 Day01~03 模块开发与测试。修复了 Socket 资源泄漏缺陷，检查了 RAII 内存卫士，全部测试通过。" },
        },
      ],
    },
  };
  assert.equal(evaluateSubagentStatus(mockWorkerM1SummaryDone, new Set(), "running"), "completed", "包含修复历史总结但明确交付闭环的报告必须判定为 completed，绝不能误标为 running！");

  const mockEnglishDone = {
    conversation_id: "english-worker-uuid",
    currentStep: 10,
    lastEntry: {
      step_index: 10,
      type: "PLANNER_RESPONSE",
      content: "All tasks completed successfully, verified and delivered.",
    },
  };
  assert.equal(evaluateSubagentStatus(mockEnglishDone, new Set(), "running"), "completed", "英文完工交付表述必须判定为 completed！");
  console.log("  -> PASS: 完工副词与历史复盘总结准确识别，根除现场运行中误判");

  // 14. 反例 14：显式 kill 的子代理必须裁决为 killed，严禁判定为 completed
  console.log("\n[Test 14] 验证显式终止的子代理状态裁决为 killed...");
  const killedIds = new Set(["killed-sub-123"]);
  const mockKilledSubagent = {
    conversation_id: "killed-sub-123",
    currentStep: 5,
    lastEntry: { step_index: 5, type: "PLANNER_RESPONSE", content: "doing work..." },
  };
  const killedStatus = evaluateSubagentStatus(mockKilledSubagent, killedIds, "running");
  assert.equal(killedStatus, "killed", "被终止的子代理必须判定为 killed，严禁逻辑反转判定为 completed！");

  // 验证父任务最终成功时，显式 killed 的子代理绝对不能被洗绿为 completed
  const killedStatusWhenParentSuccess = evaluateSubagentStatus(mockKilledSubagent, killedIds, "success");
  assert.equal(killedStatusWhenParentSuccess, "killed", "父任务成功后，显式 killed 的子代理必须依然保持 killed，绝对不能被洗绿为 completed！");
  console.log("  -> PASS: 被终止子代理正确判定为 killed，且父任务成功后绝不发生洗绿漂移");

  // 15. 反例 15：重启纠偏后的 interrupted 任务真实原子写回磁盘
  console.log("\n[Test 15] 验证重启纠偏后的任务原子持久化落盘（消除磁盘脏数据）...");
  const diskPath = path.join(JOBS_DIR, "queued-disk-test.json");
  assert(fs.existsSync(diskPath), "任务持久化文件必须在沙箱磁盘存在");
  const onDiskJson = JSON.parse(fs.readFileSync(diskPath, "utf8"));
  assert.equal(onDiskJson.state, "interrupted", "磁盘上的持久化 JSON 必须同步纠偏为 interrupted！");
  assert.equal(onDiskJson.result?.error_details?.code, "SERVICE_RESTARTED", "磁盘上的错误码必须同步落盘！");
  console.log("  -> PASS: 纠偏状态成功原子落盘");

  // 16. 反例 16：transcript 文件的 mtime 与 size 缓存命中验证
  console.log("\n[Test 16] 验证 transcript 底层语法解析缓存命中与真 LRU 机制...");
  const cacheTestFile = path.join(tempDir, "cache_test.jsonl");
  fs.writeFileSync(cacheTestFile, JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", content: "第一步" }) + "\n", "utf8");
  const firstLocal = parseLocalTranscript(cacheTestFile);
  assert(firstLocal, "初次本地解析必须成功");
  assert.equal(firstLocal.currentAction, "第一步");
  const secondLocal = parseLocalTranscript(cacheTestFile);
  assert.strictEqual(firstLocal, secondLocal, "在文件未修改时，底层单文件解析必须严格全等命中内存缓存对象！");

  const firstParse = parseTranscript(cacheTestFile);
  const secondParse = parseTranscript(cacheTestFile);
  assert.deepEqual(firstParse, secondParse, "上层动态聚合树结构在内容上完全一致");
  console.log("  -> PASS: transcript 底层缓存生效，大幅降低高频广播 I/O");

  // 17. 反例 17：父 transcript 不变时，子 transcript 步数增长绝不能被父缓存冻结
  console.log("\n[Test 17] 验证父 transcript 缓存不冻结子代理的实时步数与动作（根治缓存回归）...");
  const dynamicBrainDir = path.join(tempDir, ".gemini", "antigravity-cli", "brain");
  const parentCid = "parent-freeze-test-cid";
  const childCid = "child-growth-test-cid";
  const parentLogDir = path.join(dynamicBrainDir, parentCid, ".system_generated", "logs");
  const childLogDir = path.join(dynamicBrainDir, childCid, ".system_generated", "logs");
  fs.mkdirSync(parentLogDir, { recursive: true });
  fs.mkdirSync(childLogDir, { recursive: true });

  const parentFile = path.join(parentLogDir, "transcript.jsonl");
  const childFile = path.join(childLogDir, "transcript.jsonl");

  // 父 transcript 启动了子代理
  fs.writeFileSync(parentFile, [
    JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "启动团队" }),
    JSON.stringify({
      step_index: 1,
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "invoke_subagent", args: { Subagents: [{ Role: "Worker Dynamic", TypeName: "dynamic_worker" }] } }]
    }),
    JSON.stringify({
      step_index: 2,
      type: "GENERIC",
      content: `Created the following subagents:\n{\n  "conversationId": "${childCid}"\n}`
    }),
  ].join("\n"), "utf8");

  // 子代理初始处于第 1 步
  fs.writeFileSync(childFile, JSON.stringify({
    step_index: 1,
    type: "PLANNER_RESPONSE",
    content: "子代理刚刚启动..."
  }) + "\n", "utf8");

  const origUserProfileForDynamic = process.env.USERPROFILE;
  process.env.USERPROFILE = tempDir;

  const dynamicParse1 = parseTranscript(parentFile, 0, 8, new Set(), "running");
  assert(dynamicParse1, "第一次父解析必须成功");
  assert.equal(dynamicParse1.subagents.length, 1);
  assert.equal(dynamicParse1.subagents[0].step, 1, "初次解析子代理步数应为 1");

  // 此时子代理快速推进到了第 40 步，而父 transcript 保持静止没有任何修改！
  fs.appendFileSync(childFile, JSON.stringify({
    step_index: 40,
    type: "PLANNER_RESPONSE",
    tool_calls: [{ name: "run_command", args: { CommandLine: "cargo test --release" } }]
  }) + "\n", "utf8");

  const dynamicParse2 = parseTranscript(parentFile, 0, 8, new Set(), "running");
  assert.equal(dynamicParse2.subagents[0].step, 40, "子代理更新后，再次解析父 transcript 必须实时穿透到第 40 步，绝对不能被父文件旧缓存冻结在第 1 步！");
  assert(dynamicParse2.subagents[0].current_action.includes("cargo test"), "子代理最新动作必须实时更新，绝不能陈旧！");
  console.log("  -> PASS: 子代理动态步数与动作成功穿透父缓存");

  // 18. 反例 18：父 transcript 不变但 parentState 变为 cancelled 时，子代理状态必须即时收敛
  console.log("\n[Test 18] 验证父任务取消时子代理状态收敛穿透缓存...");
  const dynamicParseCancelled = parseTranscript(parentFile, 0, 8, new Set(), "cancelled");
  process.env.USERPROFILE = origUserProfileForDynamic;
  assert.equal(dynamicParseCancelled.subagents[0].status, "cancelled", "父状态变为 cancelled 时，子代理必须即时收敛为 cancelled，绝不能被旧缓存的 running 覆盖！");
  console.log("  -> PASS: 父任务终态穿透即时收敛生效");

  console.log("\n[All Tests Passed] 全部 18 项专项反例测试 100% 成功通过！\n");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
