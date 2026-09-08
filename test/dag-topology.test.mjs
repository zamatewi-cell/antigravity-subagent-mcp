import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 1. 严格沙箱隔离：在任何 ESM 模块导入前创建独立沙箱并重定向数据目录
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dag-test-"));
process.env.ANTIGRAVITY_MCP_DATA_DIR = path.join(tempDir, "data");

// 动态引入被测模块
const { parseTranscript, getTaskProgress } = await import("../src/progress.mjs");
const { JOBS_DIR } = await import("../src/storage.mjs");

// 强制断言测试沙箱隔离（AC3 严格规约）
assert(JOBS_DIR.startsWith(tempDir), `测试 JOBS_DIR 必须严格隔离至临时沙箱目录: ${JOBS_DIR}`);

console.log("=== 开始执行 R3 原生 Agent DAG 拓扑元数据与多层级递归测试 (test/dag-topology.test.mjs) ===");

const originalUserProfile = process.env.USERPROFILE;

try {
  // 设置测试专属虚拟用户目录，供 locateTranscriptPath 检索
  process.env.USERPROFILE = tempDir;
  const targetBrain = path.join(tempDir, ".gemini", "antigravity-cli", "brain");
  fs.mkdirSync(targetBrain, { recursive: true });

  // 辅助函数：快速在虚拟 brain 中创建 transcript 文件
  function createTranscript(conversationId, entries) {
    const logDir = path.join(targetBrain, conversationId, ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const content = entries.map((e) => JSON.stringify(e)).join("\n");
    const filePath = path.join(logDir, "transcript.jsonl");
    fs.writeFileSync(filePath, content, "utf8");
    return filePath;
  }

  // =========================================================================
  // Test 1: 单层子代理拓扑元数据验证 (Root -> 2 个直属 Workers)
  // =========================================================================
  console.log("\n[Test 1] 验证单层子代理的 DAG 拓扑元数据装配 (parentId, depth=1, childrenIds, nodeType)...");
  const rootConvId1 = "root-conv-single-001";
  const workerAId = "worker-a-1111-2222-3333";
  const workerBId = "worker-b-4444-5555-6666";

  // 创建两个叶子 Worker 的 transcript
  createTranscript(workerAId, [
    { step_index: 0, type: "USER_INPUT", content: "执行代码分析" },
    { step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: "view_file", args: { AbsolutePath: "/app/index.js" } }] },
  ]);
  createTranscript(workerBId, [
    { step_index: 0, type: "USER_INPUT", content: "执行测试验证" },
    { step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }] },
  ]);

  // 创建根节点 transcript，派发这两个 Worker
  const rootPath1 = createTranscript(rootConvId1, [
    { step_index: 0, type: "USER_INPUT", content: "开始审查任务" },
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      tool_calls: [
        {
          name: "invoke_subagent",
          args: {
            Subagents: [
              { Role: "Code Reviewer", TypeName: "worker" },
              { Role: "Test Runner", TypeName: "worker" },
            ],
          },
        },
      ],
    },
    {
      step_index: 2,
      type: "GENERIC",
      content: `Created the following subagents:\n{\n  "conversationId": "${workerAId}"\n}\n{\n  "conversationId": "${workerBId}"\n}`,
    },
  ]);

  const parsed1 = parseTranscript(rootPath1, 0, 8, new Set(), "running", rootConvId1);
  assert(parsed1, "根节点 transcript 必须成功解析");
  assert.equal(parsed1.subagents.length, 2, "必须提取出 2 个直系子代理");

  const subA = parsed1.subagents.find((s) => s.conversation_id === workerAId);
  assert(subA, "必须找到 Worker A");
  assert.equal(subA.parentId, rootConvId1, "直属子代理的 parentId 必须严格指向根节点 ID");
  assert.equal(subA.depth, 1, "直属子代理的 depth 必须为 1");
  assert.deepEqual(subA.childrenIds, [], "叶子子代理的 childrenIds 必须为空数组");
  assert.equal(subA.nodeType, "worker", "叶子子代理的 nodeType 必须为 worker");
  assert.equal(subA.step, 1);
  assert.equal(subA.last_tool, "view_file");

  const subB = parsed1.subagents.find((s) => s.conversation_id === workerBId);
  assert(subB, "必须找到 Worker B");
  assert.equal(subB.parentId, rootConvId1);
  assert.equal(subB.depth, 1);
  assert.deepEqual(subB.childrenIds, []);
  assert.equal(subB.nodeType, "worker");
  assert.equal(subB.step, 1);
  assert.equal(subB.last_tool, "run_command");
  console.log("  -> PASS: 单层 DAG 拓扑字段与状态提取精确对齐");

  // =========================================================================
  // Test 2: 多层级 DAG 拓扑树递归验证 (Root -> Sub-Orchestrator -> 2 个二级 Workers)
  // =========================================================================
  console.log("\n[Test 2] 验证多层级 DAG 拓扑结构 (Root -> Sub-Orchestrator [depth 1] -> Workers [depth 2])...");
  const rootConvId2 = "root-conv-multi-002";
  const subOrchId = "sub-orch-team-lead-8888";
  const leafWorker1 = "leaf-worker-1-aaaa-bbbb";
  const leafWorker2 = "leaf-worker-2-cccc-dddd";

  // 1. 创建两个孙子级叶子节点的 transcript (depth 2)
  createTranscript(leafWorker1, [
    { step_index: 0, type: "USER_INPUT", content: "微观任务 1" },
    { step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: "write_to_file", args: { TargetFile: "foo.txt" } }] },
  ]);
  createTranscript(leafWorker2, [
    { step_index: 0, type: "USER_INPUT", content: "微观任务 2" },
    { step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: "send_message", args: { Message: "微观任务完成" } }] },
  ]);

  // 2. 创建子编排器 transcript，它自身又派发了上述两个孙子节点
  createTranscript(subOrchId, [
    { step_index: 0, type: "USER_INPUT", content: "子编排团队任务" },
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      tool_calls: [
        {
          name: "invoke_subagent",
          args: {
            Subagents: [
              { Role: "Database Specialist", TypeName: "worker" },
              { Role: "Security Auditor", TypeName: "worker" },
            ],
          },
        },
      ],
    },
    {
      step_index: 2,
      type: "GENERIC",
      content: `Created the following subagents:\n{\n  "conversationId": "${leafWorker1}"\n}\n{\n  "conversationId": "${leafWorker2}"\n}`,
    },
  ]);

  // 3. 创建顶层根节点 transcript，它派发了 subOrchId
  const rootPath2 = createTranscript(rootConvId2, [
    { step_index: 0, type: "USER_INPUT", content: "启动大团队流程" },
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      tool_calls: [
        {
          name: "invoke_subagent",
          args: {
            Subagents: [
              { Role: "Module Lead Orchestrator", TypeName: "teamwork_preview_worker" },
            ],
          },
        },
      ],
    },
    {
      step_index: 2,
      type: "GENERIC",
      content: `Created the following subagents:\n{\n  "conversationId": "${subOrchId}"\n}`,
    },
  ]);

  const parsed2 = parseTranscript(rootPath2, 0, 8, new Set(), "running", rootConvId2);
  assert(parsed2);
  // 预期汇总结果：包含 1 个一级子编排器 + 2 个二级孙子节点，共 3 个智能体节点
  assert.equal(parsed2.subagents.length, 3, "汇总的子代理总数必须为 3 个节点");

  // 验证一级子编排器
  const subOrchNode = parsed2.subagents.find((s) => s.conversation_id === subOrchId);
  assert(subOrchNode, "必须包含子编排器节点");
  assert.equal(subOrchNode.parentId, rootConvId2, "子编排器的 parentId 必须指向根 ID");
  assert.equal(subOrchNode.depth, 1, "一级子编排器的 depth 必须为 1");
  assert.equal(subOrchNode.nodeType, "orchestrator", "派生了下级子代理的节点其 nodeType 必须为 orchestrator");
  assert.equal(subOrchNode.childrenIds.length, 2, "子编排器的 childrenIds 必须包含 2 个子项");
  assert(subOrchNode.childrenIds.includes(leafWorker1));
  assert(subOrchNode.childrenIds.includes(leafWorker2));

  // 验证二级叶子 Worker 1
  const leaf1Node = parsed2.subagents.find((s) => s.conversation_id === leafWorker1);
  assert(leaf1Node, "必须包含二级子代理 1");
  assert.equal(leaf1Node.parentId, subOrchId, "二级子代理的 parentId 必须精确指向其父子编排器 conversation_id");
  assert.equal(leaf1Node.depth, 2, "二级子代理的 depth 必须为 2");
  assert.equal(leaf1Node.nodeType, "worker", "叶子节点 nodeType 为 worker");
  assert.deepEqual(leaf1Node.childrenIds, []);

  // 验证二级叶子 Worker 2
  const leaf2Node = parsed2.subagents.find((s) => s.conversation_id === leafWorker2);
  assert(leaf2Node, "必须包含二级子代理 2");
  assert.equal(leaf2Node.parentId, subOrchId, "二级子代理 2 的 parentId 同样必须指向其父子编排器");
  assert.equal(leaf2Node.depth, 2);
  assert.equal(leaf2Node.nodeType, "worker");
  assert.deepEqual(leaf2Node.childrenIds, []);
  console.log("  -> PASS: 多层级父子链关联与 depth 递增计算 100% 准确");

  // =========================================================================
  // Test 3: 边界验证 - 递归深度截断与循环防爆
  // =========================================================================
  console.log("\n[Test 3] 验证递归深度超出 maxDepth 时的优雅截断与标记...");
  const truncatedRootId = "root-trunc-003";
  const truncatedChildId = "child-trunc-003";

  createTranscript(truncatedChildId, [
    { step_index: 0, type: "USER_INPUT", content: "深层任务" },
    { step_index: 1, type: "PLANNER_RESPONSE", content: "深层执行中" },
  ]);

  const truncRootPath = createTranscript(truncatedRootId, [
    { step_index: 0, type: "USER_INPUT", content: "超深任务" },
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "invoke_subagent", args: { Subagents: [{ Role: "Too Deep Worker", TypeName: "worker" }] } }],
    },
    {
      step_index: 2,
      type: "GENERIC",
      content: `Created the following subagents:\n{\n  "conversationId": "${truncatedChildId}"\n}`,
    },
  ]);

  // 设置 maxDepth = 0，限制无法进入子代理深度
  const parsedTrunc = parseTranscript(truncRootPath, 0, 0, new Set(), "running", truncatedRootId);
  assert(parsedTrunc);
  assert.equal(parsedTrunc.subagents.length, 1);
  assert.equal(parsedTrunc.subagents[0].depth, 1);
  assert.equal(parsedTrunc.subagents[0].current_action, "运行中（深度超出最大解析层级）");
  assert.equal(parsedTrunc.subagents[0].nodeType, "worker");
  console.log("  -> PASS: 深度超限截断与动作标记保护验证通过");

  // =========================================================================
  // Test 4: getTaskProgress 集成导出完整性断言
  // =========================================================================
  console.log("\n[Test 4] 验证 getTaskProgress 导出的 Agent DAG 拓扑元数据与接口契约...");
  const fakeJob = {
    jobId: "agy-job-dag-test-9999",
    conversationId: rootConvId2,
    state: "running",
    startedAt: new Date(Date.now() - 30000).toISOString(),
    invocation: { prompt: "集成验证任务", cwd: tempDir, model: "gemini-3.8-flash-high" },
  };

  const progress = getTaskProgress(fakeJob);
  assert(progress, "必须生成结构化 progress");
  assert(Array.isArray(progress.subagents), "progress.subagents 必须为数组");
  assert.equal(progress.subagents.length, 3);

  // 严格校验每一项都完整保留 R3 规约字段
  for (const s of progress.subagents) {
    assert("parentId" in s, "每个子代理必须包含 parentId 字段");
    assert(typeof s.depth === "number", "每个子代理必须包含 number 类型的 depth 字段");
    assert(Array.isArray(s.childrenIds), "每个子代理必须包含 string[] 类型的 childrenIds 字段");
    assert(["orchestrator", "worker"].includes(s.nodeType), `nodeType 必须为 orchestrator 或 worker，实际: ${s.nodeType}`);
  }

  // 验证主编排器派发的第一个节点 parentId 等于 fakeJob.conversationId
  const rootFirstSub = progress.subagents.find((s) => s.depth === 1);
  assert.equal(rootFirstSub.parentId, fakeJob.conversationId);
  console.log("  -> PASS: getTaskProgress 导出的拓扑元数据与 PROJECT.md 契约 100% 对齐");

  console.log("\n[All Tests Passed] R3 原生 Agent DAG 拓扑测试 100% 全部通过！\n");
} finally {
  process.env.USERPROFILE = originalUserProfile;
  // 销毁并清理临时沙箱目录
  fs.rmSync(tempDir, { recursive: true, force: true });
}
