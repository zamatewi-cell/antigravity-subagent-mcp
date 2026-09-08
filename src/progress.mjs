import fs from "node:fs";
import path from "node:path";
import { sanitizeDiagnostics } from "./diagnostics.mjs";

/**
 * 从 Antigravity 的运行日志文件中嗅探 conversation_id
 * @param {string} logFile - 本地任务独立的日志文件绝对路径
 * @returns {string|null} - 匹配到的会话 UUID 或 null
 */
export function detectConversationId(logFile) {
  if (!logFile || !fs.existsSync(logFile)) return null;
  try {
    const text = fs.readFileSync(logFile, "utf8");
    const match = text.match(/(?:conversationID=["']|resuming conversation |Streaming conversation )([0-9a-fA-F-]{36})/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * 定位 Antigravity 本地转储的 transcript.jsonl 路径
 * @param {string} conversationId - 会话 UUID
 * @returns {string|null} - 存在的 transcript.jsonl 路径或 null
 */
export function locateTranscriptPath(conversationId) {
  if (!conversationId) return null;
  const userHome = process.env.USERPROFILE || process.env.HOME || "";
  const candidates = [
    path.join(userHome, ".gemini", "antigravity-cli", "brain", conversationId, ".system_generated", "logs", "transcript.jsonl"),
    path.join(userHome, ".gemini", "antigravity", "brain", conversationId, ".system_generated", "logs", "transcript.jsonl"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 解析 transcript.jsonl 文件提取实时运行状态
 * @param {string} transcriptPath - transcript.jsonl 的绝对路径
 * @returns {object|null} - 包含步数、当前动作、活跃子代理和活动历史的结构化数据
 */
export function parseTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  try {
    const content = fs.readFileSync(transcriptPath, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return null;

    let currentStep = 0;
    let currentAction = "";
    let lastTool = null;
    const subagentsMap = new Map();
    const recentActivities = [];

    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (typeof entry.step_index === "number") {
        currentStep = Math.max(currentStep, entry.step_index);
      }

      if (entry.type === "PLANNER_RESPONSE" || entry.tool_calls) {
        const textSummary = (entry.content || "").replace(/<[^>]+>/g, "").trim();
        if (textSummary) {
          const firstLine = textSummary.split(/\r?\n/)[0].slice(0, 100);
          currentAction = firstLine;
        }

        if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
          for (const tc of entry.tool_calls) {
            const toolName = tc.name || "unknown_tool";
            lastTool = toolName;
            const actionDesc = tc.toolSummary || tc.toolAction || tc.name;
            const stepNum = typeof entry.step_index === "number" ? entry.step_index : currentStep;
            const stepDesc = `Step ${stepNum}: [${toolName}] ${actionDesc}`;
            recentActivities.push(stepDesc);

            // 识别多代理团队协同创建
            if (toolName === "invoke_subagent" && tc.args?.Subagents) {
              const list = Array.isArray(tc.args.Subagents) ? tc.args.Subagents : [tc.args.Subagents];
              for (const sub of list) {
                if (sub.Role || sub.TypeName) {
                  subagentsMap.set(sub.Role || sub.TypeName, {
                    role: sub.Role || "Subagent",
                    type: sub.TypeName || "unknown",
                    status: "running",
                  });
                }
              }
            }
          }
        }
      }
    }

    const latestActivities = recentActivities.slice(-5);

    return {
      currentStep,
      currentAction: currentAction || (lastTool ? `执行工具: ${lastTool}` : "分析处理中..."),
      lastTool,
      subagents: [...subagentsMap.values()],
      recentActivities: latestActivities,
    };
  } catch {
    return null;
  }
}

/**
 * 当 transcript 尚未生成时，从任务专用 log 文件中提取基础状态
 * @param {string} logFile - 运行日志路径
 * @returns {object} - 基础阶段与摘要
 */
export function fallbackFromLog(logFile) {
  if (!logFile || !fs.existsSync(logFile)) {
    return { phase: "starting", message: "子代理进程启动中..." };
  }
  try {
    const text = fs.readFileSync(logFile, "utf8");
    const rounds = (text.match(/streamGenerateContent\?alt=sse/g) || []).length;
    const hasTeamwork = text.includes('expanded slash command "teamwork-preview"');
    const isAuthDone = text.includes("OAuth: authenticated") || text.includes("silent auth succeeded");

    if (rounds > 0) {
      return {
        phase: hasTeamwork ? "teamwork_collaborating" : "thinking",
        rounds,
        message: hasTeamwork
          ? `多智能体团队正在协同工作中（已完成 ${rounds} 轮模型推理）`
          : `模型正在深入思考与生成（已完成 ${rounds} 轮模型推理）`,
      };
    }

    if (isAuthDone) {
      return { phase: "initializing", message: "认证已完成，正在装载工作区上下文并展开指令..." };
    }

    return { phase: "starting", message: "CLI 引擎初始化中..." };
  } catch {
    return { phase: "starting", message: "任务启动中..." };
  }
}

/**
 * 获取任务的综合实时运行状态
 * @param {object} job - MCP 任务对象
 * @returns {object} - 结构化的 progress 进度对象
 */
export function getTaskProgress(job) {
  const startedAt = job.startedAt ? new Date(job.startedAt).getTime() : Date.now();
  const completedAt = job.completedAt ? new Date(job.completedAt).getTime() : Date.now();
  const elapsedSeconds = Math.max(0, Math.round((completedAt - startedAt) / 1000));

  let conversationId = job.conversationId || detectConversationId(job.invocation?.log_file);
  if (conversationId && !job.conversationId) {
    job.conversationId = conversationId;
  }

  const transcriptPath = locateTranscriptPath(conversationId);
  const transcriptInfo = transcriptPath ? parseTranscript(transcriptPath) : null;
  const fallbackInfo = fallbackFromLog(job.invocation?.log_file);

  let phase = "running";
  if (job.state === "success") {
    phase = "completed";
  } else if (job.state === "error" || job.state === "timed_out" || job.state === "cancelled") {
    phase = job.state;
  } else if (transcriptInfo?.subagents?.length > 0) {
    phase = "subagents_collaborating";
  } else if (transcriptInfo?.lastTool) {
    phase = "executing_tools";
  } else {
    phase = fallbackInfo.phase || "thinking";
  }

  const currentAction = transcriptInfo?.currentAction || fallbackInfo.message || "任务处理中...";

  return {
    conversation_id: conversationId || null,
    phase,
    elapsed_seconds: elapsedSeconds,
    current_step: transcriptInfo?.currentStep ?? (fallbackInfo.rounds ?? 0),
    current_action: sanitizeDiagnostics(currentAction, 200),
    last_tool: transcriptInfo?.lastTool || null,
    subagents: transcriptInfo?.subagents || [],
    recent_activities: (transcriptInfo?.recentActivities || []).map((act) => sanitizeDiagnostics(act, 300)),
  };
}
