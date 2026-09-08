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
 * 定位 Antigravity 本地转储的 transcript 路径（优先全量完整版 transcript_full.jsonl）
 * @param {string} conversationId - 会话 UUID
 * @returns {string|null} - 存在的 transcript 路径或 null
 */
export function locateTranscriptPath(conversationId) {
  if (!conversationId) return null;
  const userHome = process.env.USERPROFILE || process.env.HOME || "";
  const candidates = [
    path.join(userHome, ".gemini", "antigravity-cli", "brain", conversationId, ".system_generated", "logs", "transcript_full.jsonl"),
    path.join(userHome, ".gemini", "antigravity-cli", "brain", conversationId, ".system_generated", "logs", "transcript.jsonl"),
    path.join(userHome, ".gemini", "antigravity", "brain", conversationId, ".system_generated", "logs", "transcript_full.jsonl"),
    path.join(userHome, ".gemini", "antigravity", "brain", conversationId, ".system_generated", "logs", "transcript.jsonl"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 安全解析 JSON，解析失败返回 null
 */
function safeParseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * 健壮提取 Subagents 参数，兼容数组、对象、未转义换行字符串及正则回退
 */
function parseSubagentsArg(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") return [raw];
  if (typeof raw !== "string") return [];

  // 1. 尝试直接 parse
  const direct = safeParseJson(raw);
  if (direct) return Array.isArray(direct) ? direct : [direct];

  // 2. 修复字符串中未转义的控制字符（换行/回车/制表符）
  try {
    const sanitized = raw.replace(/[\u0000-\u001F]+/g, (match) => {
      if (match === "\n") return "\\n";
      if (match === "\r") return "\\r";
      if (match === "\t") return "\\t";
      return "";
    });
    const cleaned = JSON.parse(sanitized);
    return Array.isArray(cleaned) ? cleaned : [cleaned];
  } catch {}

  // 3. 正则回退提取 Role 和 TypeName
  const results = [];
  const roleMatches = [...raw.matchAll(/["']Role["']\s*:\s*["']([^"']+)["']/g)];
  const typeMatches = [...raw.matchAll(/["']TypeName["']\s*:\s*["']([^"']+)["']/g)];
  const count = Math.max(roleMatches.length, typeMatches.length);
  for (let i = 0; i < count; i++) {
    results.push({
      Role: roleMatches[i]?.[1] || "Subagent",
      TypeName: typeMatches[i]?.[1] || "unknown",
    });
  }
  return results;
}

/**
 * 从工具输出文本中提取所有的 conversationId UUID
 */
function extractConversationIds(text) {
  if (!text) return [];
  const matches = [...text.matchAll(/(?:conversationId["']?\s*:\s*["'])([0-9a-fA-F-]{36})/g)];
  return matches.map((m) => m[1]);
}

/**
 * 递归解析 transcript 文件，提取实时运行状态与全员子代理微观工作明细
 * @param {string} transcriptPath - transcript 文件绝对路径
 * @param {number} depth - 当前递归层级（防止无限嵌套）
 * @param {number} maxDepth - 最大递归深度
 * @param {Set<string>} visited - 已遍历文件集合
 * @returns {object|null} - 结构化状态
 */
export function parseTranscript(transcriptPath, depth = 0, maxDepth = 3, visited = new Set()) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  if (visited.has(transcriptPath)) return null;
  visited.add(transcriptPath);

  try {
    const content = fs.readFileSync(transcriptPath, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return null;

    let currentStep = 0;
    let currentAction = "";
    let lastTool = null;
    let lastThinking = "";
    const pendingSubagents = [];
    const directSubagents = [];
    const recentActivities = [];

    for (let i = 0; i < lines.length; i++) {
      const entry = safeParseJson(lines[i]);
      if (!entry) continue;

      if (typeof entry.step_index === "number") {
        currentStep = Math.max(currentStep, entry.step_index);
      }

      if (entry.thinking) {
        lastThinking = entry.thinking.trim().replace(/\r?\n/g, " ");
      }

      if (entry.type === "PLANNER_RESPONSE" || entry.tool_calls) {
        const textSummary = (entry.content || "").replace(/<[^>]+>/g, "").trim();
        if (textSummary) {
          const firstLine = textSummary.split(/\r?\n/)[0].replace(/^[#*\s]+/, "").slice(0, 100);
          if (firstLine) currentAction = firstLine;
        }

        if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
          for (const tc of entry.tool_calls) {
            const toolName = tc.name || "unknown_tool";
            lastTool = toolName;
            const actionDesc = tc.toolSummary || tc.toolAction || tc.name;
            const stepNum = typeof entry.step_index === "number" ? entry.step_index : currentStep;
            recentActivities.push(`Step ${stepNum}: [${toolName}] ${actionDesc}`);

            // 捕获子代理创建工具调用
            if (toolName === "invoke_subagent" && tc.args?.Subagents) {
              const list = parseSubagentsArg(tc.args.Subagents);
              for (const sub of list) {
                const item = {
                  role: sub.Role || sub.role || sub.TypeName || sub.type || "Subagent",
                  type: sub.TypeName || sub.type || "unknown",
                  conversation_id: null,
                  status: "running",
                };
                pendingSubagents.push(item);
                directSubagents.push(item);
              }
            }
          }
        }
      }

      // 捕获紧随其后的工具结果中返回的 conversationId
      if (entry.type === "GENERIC" && entry.content) {
        const text = entry.content;
        const convIds = extractConversationIds(text);
        if (convIds.length > 0 && pendingSubagents.length > 0) {
          for (const cid of convIds) {
            const target = pendingSubagents.shift();
            if (target) {
              target.conversation_id = cid;
            }
          }
        }
      }
    }

    if (!currentAction) {
      if (lastTool) {
        currentAction = `执行工具: ${lastTool}`;
      } else if (lastThinking) {
        currentAction = lastThinking.slice(0, 100);
      } else {
        currentAction = "分析处理中...";
      }
    }

    // 递归聚合各级子代理的真实微观工作明细
    const allDiscoveredSubagents = [];
    for (const sub of directSubagents) {
      const subInfo = {
        role: sub.role,
        type: sub.type,
        conversation_id: sub.conversation_id,
        status: sub.status,
        step: 0,
        current_action: "初始化中...",
        last_tool: null,
        recent_activities: [],
      };

      if (sub.conversation_id && depth < maxDepth) {
        const subTranscriptPath = locateTranscriptPath(sub.conversation_id);
        if (subTranscriptPath) {
          const childParsed = parseTranscript(subTranscriptPath, depth + 1, maxDepth, visited);
          if (childParsed) {
            subInfo.step = childParsed.currentStep;
            subInfo.current_action = childParsed.currentAction;
            subInfo.last_tool = childParsed.lastTool;
            // 若子代理已发送交付报告或步数充足完成，则标记为已完成
            subInfo.status = childParsed.lastTool === "send_message" || childParsed.currentStep >= 30 ? "completed" : "running";
            subInfo.recent_activities = childParsed.recentActivities.slice(-3);

            // 递归汇总更深层子代理（孙代等），扁平展示给调用方
            if (childParsed.subagents && childParsed.subagents.length > 0) {
              for (const descendant of childParsed.subagents) {
                allDiscoveredSubagents.push(descendant);
              }
            }
          }
        }
      }
      allDiscoveredSubagents.push(subInfo);
    }

    return {
      currentStep,
      currentAction,
      lastTool,
      subagents: allDiscoveredSubagents,
      recentActivities: recentActivities.slice(-5),
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
 * 获取任务的综合实时运行状态（含所有级联子代理微观动作）
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

  // 格式化并清洗所有子代理的微观动作
  const formattedSubagents = (transcriptInfo?.subagents || []).map((sub) => ({
    role: sub.role,
    type: sub.type,
    conversation_id: sub.conversation_id,
    status: job.state === "success" ? "completed" : sub.status,
    step: sub.step,
    current_action: sanitizeDiagnostics(sub.current_action, 150),
    last_tool: sub.last_tool,
    recent_activities: (sub.recent_activities || []).map((act) => sanitizeDiagnostics(act, 200)),
  }));

  return {
    conversation_id: conversationId || null,
    phase,
    elapsed_seconds: elapsedSeconds,
    current_step: transcriptInfo?.currentStep ?? (fallbackInfo.rounds ?? 0),
    current_action: sanitizeDiagnostics(currentAction, 200),
    last_tool: transcriptInfo?.lastTool || null,
    subagents: formattedSubagents,
    recent_activities: (transcriptInfo?.recentActivities || []).map((act) => sanitizeDiagnostics(act, 300)),
  };
}
