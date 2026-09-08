import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectConversationId, parseTranscript, fallbackFromLog, getTaskProgress } from "../src/progress.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-progress-test-"));
process.env.ANTIGRAVITY_MCP_DATA_DIR = path.join(tempDir, "data");

const { persistJob, restorePersistedJobs, JOBS_DIR } = await import("../src/storage.mjs");
assert(JOBS_DIR.startsWith(tempDir), `测试 JOBS_DIR 必须被严格隔离至临时沙箱目录: ${JOBS_DIR}`);

try {
  // 1. 测试从日志嗅探 conversation_id
  const sampleLog = path.join(tempDir, "sample.log");
  const logContent = [
    "ERROR: logging before google.Init: I0908 14:31:15 1 printmode.go:173] Print mode: starting (promptLength=120, model=\"gemini-3.8-flash-high\", conversationID=\"72d5c059-674f-4719-8b2f-85a6aa4da8e6\")",
    "ERROR: logging before google.Init: I0908 14:31:16 1 http_helpers.go:296] URL: https://example.com:streamGenerateContent?alt=sse"
  ].join("\n");
  fs.writeFileSync(sampleLog, logContent, "utf8");
  const convId = detectConversationId(sampleLog);
  assert.equal(convId, "72d5c059-674f-4719-8b2f-85a6aa4da8e6");

  // 2. 测试从 transcript.jsonl 解析步骤、动作和多智能体团队
  const sampleTranscript = path.join(tempDir, "transcript.jsonl");
  const lines = [
    JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "/teamwork-preview 重构项目" }),
    JSON.stringify({
      step_index: 1,
      type: "PLANNER_RESPONSE",
      content: "开始协调多个子代理执行重构",
      tool_calls: [
        {
          name: "invoke_subagent",
          toolSummary: "启动两个子代理进行并行审查",
          args: {
            Subagents: [
              { Role: "Worker A", TypeName: "teamwork_preview_worker" },
              { Role: "Worker B", TypeName: "teamwork_preview_worker" },
            ],
          },
        },
      ],
    }),
    JSON.stringify({
      step_index: 2,
      type: "GENERIC",
      content: "Created the following subagents:\n{\n  \"conversationId\": \"11111111-2222-3333-4444-555555555555\"\n}\n{\n  \"conversationId\": \"66666666-7777-8888-9999-000000000000\"\n}",
    }),
    JSON.stringify({
      step_index: 3,
      type: "PLANNER_RESPONSE",
      content: "正在检查后端核心逻辑",
      tool_calls: [
        {
          name: "view_file",
          toolSummary: "查看主控服务代码",
          args: { AbsolutePath: "D:/project/main.go" },
        },
      ],
    }),
  ];
  fs.writeFileSync(sampleTranscript, lines.join("\n"), "utf8");

  const parsed = parseTranscript(sampleTranscript);
  assert.equal(parsed.currentStep, 3);
  assert.equal(parsed.lastTool, "view_file");
  assert.equal(parsed.subagents.length, 2);
  assert.equal(parsed.subagents[0].role, "Worker A");
  assert.equal(parsed.subagents[0].conversation_id, "11111111-2222-3333-4444-555555555555");
  assert.equal(parsed.subagents[1].role, "Worker B");
  assert.equal(parsed.subagents[1].conversation_id, "66666666-7777-8888-9999-000000000000");
  assert.equal(parsed.recentActivities.length, 2);

  // 3. 测试从日志提取回退信息
  const fallback = fallbackFromLog(sampleLog);
  assert.equal(fallback.phase, "thinking");
  assert.equal(fallback.rounds, 1);

  // 4. 测试 getTaskProgress 综合进度生成
  const fakeJob = {
    jobId: "test-job-uuid",
    state: "running",
    startedAt: new Date(Date.now() - 15000).toISOString(),
    invocation: { log_file: sampleLog },
  };
  const prog = getTaskProgress(fakeJob);
  assert.equal(prog.conversation_id, "72d5c059-674f-4719-8b2f-85a6aa4da8e6");
  assert.equal(prog.elapsed_seconds >= 14, true);

  // 5. 测试任务存储与持久化状态自动校正
  const persistJobTest = {
    jobId: "test-persist-job",
    state: "running",
    startedAt: new Date().toISOString(),
    invocation: { model: "gemini-3.8-flash-high", cwd: "D:/test" },
    result: null,
  };
  persistJob(persistJobTest);
  const restored = restorePersistedJobs();
  assert(restored.has("test-persist-job"));
  const restoredJob = restored.get("test-persist-job");
  assert.equal(restoredJob.state, "interrupted");
  assert.equal(restoredJob.result?.status, "ERROR");

  console.log("All progress and storage tests passed successfully!");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
