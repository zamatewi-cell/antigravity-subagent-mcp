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
 * 从工具输出文本中提取所有的 conversationId
 */
function extractConversationIds(text) {
  if (!text) return [];
  const matches = [...text.matchAll(/(?:conversationId["']?\s*:\s*["'])([^"'\r\n\s]+)/g)];
  return matches.map((m) => m[1]);
}

/**
 * 格式化工具动作，优先读取参数中的描述或具体参数细节，杜绝裸工具名
 * @param {object} tc - tool call 对象
 * @returns {string} - 具体的动作描述
 */
export function formatToolAction(tc) {
  if (!tc) return "执行未知操作";
  const toolName = tc.name || "unknown_tool";
  const args = tc.args || {};

  // 1. 优先提取 toolSummary 或 toolAction
  const explicitSummary = args.toolSummary || args.toolAction || tc.toolSummary || tc.toolAction;
  if (explicitSummary && typeof explicitSummary === "string" && explicitSummary.trim()) {
    return `[${toolName}] ${explicitSummary.trim().replace(/^["']|["']$/g, "")}`;
  }

  // 2. 依据具体工具参数提取具备可读性的关键细节
  if (toolName === "run_command" && args.CommandLine) {
    const cmd = String(args.CommandLine).replace(/^["']|["']$/g, "").trim();
    return `[run_command] 运行: ${cmd.slice(0, 100)}`;
  }
  if (toolName === "write_to_file" && args.TargetFile) {
    const file = path.basename(String(args.TargetFile).replace(/^["']|["']$/g, "").trim());
    return `[write_to_file] 写入: ${file}`;
  }
  if (toolName === "view_file" && args.AbsolutePath) {
    const file = path.basename(String(args.AbsolutePath).replace(/^["']|["']$/g, "").trim());
    return `[view_file] 查看: ${file}`;
  }
  if (toolName === "replace_file_content" && args.TargetFile) {
    const file = path.basename(String(args.TargetFile).replace(/^["']|["']$/g, "").trim());
    return `[replace_file_content] 修改: ${file}`;
  }
  if (toolName === "invoke_subagent") {
    return `[invoke_subagent] 派发团队子代理`;
  }
  if (toolName === "send_message") {
    const msg = String(args.Message || "").replace(/^["']|["']$/g, "").trim();
    return `[send_message] 消息: ${msg.slice(0, 60)}`;
  }
  if (toolName === "manage_subagents") {
    const act = args.Action || "manage";
    return `[manage_subagents] ${act}`;
  }

  return `[${toolName}] 执行操作`;
}

const NEGATION_OR_IN_PROGRESS = /(?:未|尚未|还没|未曾|不曾|未完全|继续|还在|仍然|正在|进行中|排查|修复|检查|待办|未决|处理中|调试中|\bno\b|\bnot\b|\byet\b|\bstill\b|\bworking\b|\bin\s*progress\b|\bincomplete\b|\bfixing\b|\bpending\b|\bunfinished\b|\bongoing\b)/i;
const ASKING_OR_HELP = /(?:求助|请示|询问|确认|是否|等待|进展|定时汇报|心跳|\bhelp\b|\bguidance\b|\bquestion\b|\bproceed\?)/i;

/**
 * 校验文本中是否具备确定性、无可争议的完工交付证据
 * 严禁单纯因提及文件名（如 handoff.md）或孤立单词而判定完成
 * @param {string} text 
 * @returns {boolean}
 */
export function isExplicitlyCompleted(text) {
  if (!text || typeof text !== "string") return false;
  const str = text.trim();
  if (!str) return false;

  // 1. 若包含任何否定、未决、进行中修饰或求助倾向，一票否决
  if (NEGATION_OR_IN_PROGRESS.test(str) || ASKING_OR_HELP.test(str)) {
    return false;
  }

  // 2. 必须具备不可动摇的强完工交付声明
  const hasExplicitCompletionClaim = /(?:(?:已|全部|已经|任务)(?:完成|交付|完工|搞定|闭环)|已交付成果|工作已结束|全部测试通过|全部用例通过|VICTORY\s+CONFIRMED|已生成\s*(?:[\w.-]+\/)*handoff\.md)/i.test(str);

  return hasExplicitCompletionClaim;
}

/**
 * 严格裁决子代理当前生命周期状态
 * 准则：宁可判定为 running 或 unknown，绝不能在缺乏不可辩驳证据的情况下虚标 completed
 * @param {object} childParsed - 子代理 transcript 解析结果
 * @param {Set<string>} killedConversationIds - 父代理中被显式 kill 的会话 ID 集合
 * @param {string} parentState - 父任务整体状态
 * @returns {string} - "running" | "completed" | "error" | "unknown"
 */
export function evaluateSubagentStatus(childParsed, killedConversationIds, parentState) {
  if (!childParsed) return "unknown";

  // 1. 父任务已成功完成，或该会话已被显式终止
  if (parentState === "success" || parentState === "completed") {
    return "completed";
  }
  if (killedConversationIds && childParsed.conversation_id && killedConversationIds.has(childParsed.conversation_id)) {
    return "completed";
  }

  // 2. 检查子代理日志最后一步
  const lastEntry = childParsed.lastEntry;
  if (!lastEntry) return "running";

  // 3. 若最后一步包含工具调用
  if (Array.isArray(lastEntry.tool_calls) && lastEntry.tool_calls.length > 0) {
    // 只要包含任何非 send_message 工具（如写文件、执行命令、读文件等物理动作），必定是活跃执行中
    const hasActiveWorkTools = lastEntry.tool_calls.some(t => t && t.name !== "send_message");
    if (hasActiveWorkTools) {
      return "running";
    }

    // 若调用的全部为 send_message，提取所有消息内容合并判断
    const messages = lastEntry.tool_calls
      .filter(t => t && t.name === "send_message")
      .map(t => String(t.args?.Message || ""))
      .join(" ");

    if (isExplicitlyCompleted(messages)) {
      return "completed";
    }

    return "running";
  }

  // 4. 最后一步为纯回复（无工具调用）且状态为 DONE
  if (lastEntry.type === "PLANNER_RESPONSE" && (!lastEntry.tool_calls || lastEntry.tool_calls.length === 0)) {
    const text = String(lastEntry.content || "");
    if (isExplicitlyCompleted(text)) {
      return "completed";
    }
  }

  // 5. 证据不足时严格保持 running，绝不误标已完成
  return "running";
}

/**
 * 递归解析 transcript 文件，提取实时运行状态与全员子代理微观工作明细
 * @param {string} transcriptPath - transcript 文件绝对路径
 * @param {number} depth - 当前递归层级（防止无限嵌套）
 * @param {number} maxDepth - 最大递归深度（默认支持8级深度）
 * @param {Set<string>} visited - 已遍历文件集合
 * @param {string} parentState - 父任务生命周期状态
 * @returns {object|null} - 结构化状态
 */
export function parseTranscript(transcriptPath, depth = 0, maxDepth = 8, visited = new Set(), parentState = "running") {
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
    let lastEntry = null;
    const pendingSubagents = [];
    const directSubagents = [];
    const recentActivities = [];
    const killedConversationIds = new Set();

    for (let i = 0; i < lines.length; i++) {
      const entry = safeParseJson(lines[i]);
      if (!entry) continue;

      lastEntry = entry;
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
            const stepNum = typeof entry.step_index === "number" ? entry.step_index : currentStep;
            const actionText = formatToolAction(tc);
            recentActivities.push(`Step ${stepNum}: ${actionText}`);

            // 发生新的工具调用时，强制覆盖旧的文本摘要，避免界面陈旧滞后
            currentAction = actionText;

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

            // 捕获终止子代理工具调用
            if (toolName === "manage_subagents") {
              const act = tc.args?.Action;
              if (act === "kill_all") {
                for (const sub of directSubagents) {
                  if (sub.conversation_id) killedConversationIds.add(sub.conversation_id);
                }
              } else if (act === "kill" && Array.isArray(tc.args?.ConversationIds)) {
                for (const cid of tc.args.ConversationIds) {
                  killedConversationIds.add(cid);
                }
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
        current_action: "等待调度中...",
        last_tool: null,
        recent_activities: [],
      };

      if (sub.conversation_id && depth < maxDepth) {
        const subTranscriptPath = locateTranscriptPath(sub.conversation_id);
        if (subTranscriptPath) {
          const childParsed = parseTranscript(subTranscriptPath, depth + 1, maxDepth, visited, parentState);
          if (childParsed) {
            childParsed.conversation_id = sub.conversation_id;
            subInfo.step = childParsed.currentStep;
            subInfo.current_action = childParsed.currentAction;
            subInfo.last_tool = childParsed.lastTool;
            subInfo.status = evaluateSubagentStatus(childParsed, killedConversationIds, parentState);
            subInfo.recent_activities = childParsed.recentActivities.slice(-100);

            // 递归汇总更深层子代理（孙代等），扁平展示给调用方
            if (childParsed.subagents && childParsed.subagents.length > 0) {
              for (const descendant of childParsed.subagents) {
                allDiscoveredSubagents.push(descendant);
              }
            }
          }
        }
      } else if (sub.conversation_id) {
        subInfo.current_action = "运行中（深度超出最大解析层级）";
      }

      allDiscoveredSubagents.push(subInfo);
    }

    const maxSubStep = allDiscoveredSubagents.reduce((m, s) => Math.max(m, s.step || 0), 0);
    const aggregatedStep = Math.max(currentStep, maxSubStep);

    return {
      currentStep: aggregatedStep,
      currentAction,
      lastTool,
      lastEntry,
      subagents: allDiscoveredSubagents,
      recentActivities: recentActivities.slice(-100),
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
  const transcriptInfo = transcriptPath ? parseTranscript(transcriptPath, 0, 8, new Set(), job.state) : null;
  const fallbackInfo = fallbackFromLog(job.invocation?.log_file);

  let phase = "running";
  if (job.state === "success") {
    phase = "completed";
  } else if (job.state === "error" || job.state === "timed_out" || job.state === "cancelled" || job.state === "interrupted") {
    phase = job.state;
  } else if (transcriptInfo?.subagents?.length > 0) {
    phase = "subagents_collaborating";
  } else if (transcriptInfo?.lastTool) {
    phase = "executing_tools";
  } else {
    phase = fallbackInfo.phase || "thinking";
  }

  let currentAction = "任务处理中...";
  if (job.state === "interrupted") {
    currentAction = "任务已中断（服务重启或异常终止）";
  } else if (transcriptInfo?.currentAction) {
    currentAction = transcriptInfo.currentAction;
  } else if (fallbackInfo.message) {
    currentAction = fallbackInfo.message;
  }

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
