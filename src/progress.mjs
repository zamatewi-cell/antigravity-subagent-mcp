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

// 针对完工动词的显式否定修饰
const NEGATED_COMPLETION = /(?:(?:未|尚未|还没|未曾|不曾|并未|未能)(?:完全)?(?:完成|交付|完工|搞定|闭环|通过)|\bnot\s+(?:yet\s+)?(?:completed|done|finished|delivered|passed))/i;

// 明确且活跃的进行时态动作声明（正在进行中，尚未交付）
const EXPLICIT_IN_PROGRESS = /(?:正在(?:排查|修复|检查|处理|构建|调试|执行|推进|编写)|还在(?:继续|排查|修复|处理|推进)|继续(?:排查|修复|推进|调试|编写)|未决|待办中|处理中|\bstill\s*(?:working|fixing|debugging|running|processing)|\bin\s*progress|\bongoing)/i;

// 中途求助、请示、疑问
const ASKING_OR_HELP = /(?:求助|请示|询问|等待回复|确认是否|心跳汇报|\bhelp\b|\bquestion\b|\bproceed\?)/i;

// 条件、从句、假设或未来时态修饰（如：“完成后再...”、“完成之后请...”、“预计...还需...”）
const CONDITIONAL_OR_FUTURE_COMPLETION = /(?:(?:(?:待|等|当|若|如果|在)?(?:[^\n。！？]{0,8}?)(?:完成|交付|完工|搞定|通过)(?:之后|后再|后请|时再|之时)?(?:再|才|然后|请|即可|通知|汇报))|(?:(?:预计|预估|估算|大概|可能)(?:[^\n。！？]{0,20}?)(?:还需要|还需|尚需|耗时))|\b(?:if|when|after|until)\s+.*?\b(?:completed|done|finished)\b)/i;

// 局部步骤、中间进度推进声明（非最终全量交付，如：“已完成第一步，接下来执行第二步”）
const PARTIAL_STEP_PROGRESS = /(?:已(?:完成|交付|执行)(?:第[一二三四五六七八九十\d]+步|阶段[一二三四五六七八九十\d]+|部分任务|前期|初步|第一轮)(?:[，,、\s]*)(?:[^\n。！？]{0,10}?)(?:接下来|随后|继续|下一步|进行下一步|推进|开始)|\bpartially\s+completed\b|\bstep\s+\d+\s+done\b)/i;

// 依赖其他代理、等待审计/验收/裁判（如：“正在审计中”、“等待...结果”）
const PENDING_AUDIT_OR_DEPENDENCY = /(?:(?:正在|还在|等待|需等|待)(?:[^\n。！？]{0,12}?)(?:审计|复核|评审|验收|验证|裁决|确认)|\bawaiting\s+(?:audit|review|verification)\b|\baudit(?:ing)?\s+in\s+progress\b)/i;

// 转折未完工修饰（如：“已完成XX；YY还没生成”、“代码已完成，但测试还没跑”、“已完成A，还有B没写”）
const BUT_NOT_FINISHED = /(?:(?:[，,；;]|\s+)(?:但|但是|然而|不过|却|而)\s*(?:[^\n。！？]{0,30}?)(?:还没|尚未|未曾|并未|未能|没跑|没做|没测|没写|没生成|未生成|未通过|待|正在|需要|还要|继续))|(?:(?:[；;]|\s{2,})(?:[^\n。！？]{0,30}?)(?:还没|尚未|未曾|并未|未能|没跑|没做|没测|没写|没生成|未生成|未通过|待办|进行中|未完成))|(?:(?:[，,；;]|\s+)(?:还剩|还有|仍有)\s*(?:[^\n。！？]{0,20}?)(?:未|还没|没|待))|\b(?:but|however|yet|while)\s+.*?\b(?:not\s+yet|pending|haven't|hasn't|in\s*progress|still|incomplete)\b/i;

// 强完工交付证据（支持副词修饰、动宾短语与英文标准交付表述）
const EXPLICIT_COMPLETION_CLAIM = /(?:已(?:全部|顺利|成功)?(?:完成|交付|完工|搞定|闭环)|(?:全部|所有|整项|整体|项目|均已|顺利|成功)(?:[^\n，。！？]{0,8}?)(?:完成|交付|完工|搞定|闭环)|已交付成果|工作已结束|全部测试通过|全部用例通过|VICTORY\s+CONFIRMED|all\s+tasks?\s+completed|successfully\s+(?:completed|delivered|finished)|(?:work|implementation)\s+(?:done|completed)|已生成\s*(?:[\w.-]+\/)*handoff\.md)/i;

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

  // 1. 若包含明确否定完工修饰、活跃进行中时态、求助倾向或转折未完工分句，一票否决
  if (NEGATED_COMPLETION.test(str) || EXPLICIT_IN_PROGRESS.test(str) || ASKING_OR_HELP.test(str) || BUT_NOT_FINISHED.test(str)) {
    return false;
  }

  // 2. 若包含条件/未来时态修饰、局部步序推进、等待审计/依赖，一票否决
  if (CONDITIONAL_OR_FUTURE_COMPLETION.test(str) || PARTIAL_STEP_PROGRESS.test(str) || PENDING_AUDIT_OR_DEPENDENCY.test(str)) {
    return false;
  }

  // 3. 必须具备不可动摇的强完工交付声明
  return EXPLICIT_COMPLETION_CLAIM.test(str);
}

/**
 * 严格裁决子代理当前生命周期状态
 * 准则：
 * 1. 显式 killed 具有不可撼动的最高优先级（即便父任务最终 success，被杀子代理依然是 killed）
 * 2. 子代理自身显式声明完成（isExplicitlyCompleted）
 * 3. 父任务非成功终态穿透（cancelled/interrupted/error/timed_out 时子代理同步收敛，不误留在 running）
 * 4. 父任务成功完成时未被终止的子代理兜底判定为 completed
 * 5. 缺乏确凿证据时严格保持 running，绝不误标已完成
 * @param {object} childParsed - 子代理 transcript 解析结果
 * @param {Set<string>} killedConversationIds - 父代理中被显式 kill 的会话 ID 集合
 * @param {string} parentState - 父任务整体状态
 * @returns {string} - "running" | "completed" | "killed" | "cancelled" | "interrupted" | "error" | "unknown"
 */
export function evaluateSubagentStatus(childParsed, killedConversationIds, parentState) {
  if (!childParsed) return "unknown";

  // 1. 显式终止具有绝对最高优先级（胜过任何父任务成功或子代理声明）
  if (killedConversationIds && childParsed.conversation_id && killedConversationIds.has(childParsed.conversation_id)) {
    return "killed";
  }

  // 2. 检查子代理最近一次的主动执行步骤（优先使用 lastPlannerEntry 回退到 lastEntry）
  const activeEntry = childParsed.lastPlannerEntry || childParsed.lastEntry;

  // 3. 检查子代理自身是否已经显式完工（不可辩驳的事实证据）
  let isChildExplicitlyDone = false;
  if (activeEntry) {
    if (Array.isArray(activeEntry.tool_calls) && activeEntry.tool_calls.length > 0) {
      const hasActiveWorkTools = activeEntry.tool_calls.some(t => t && t.name !== "send_message");
      if (!hasActiveWorkTools) {
        const messages = activeEntry.tool_calls
          .filter(t => t && t.name === "send_message")
          .map(t => String(t.args?.Message || ""))
          .join(" ");
        if (isExplicitlyCompleted(messages)) {
          isChildExplicitlyDone = true;
        }
      }
    } else if (activeEntry.type === "PLANNER_RESPONSE" && (!activeEntry.tool_calls || activeEntry.tool_calls.length === 0)) {
      const text = String(activeEntry.content || "");
      if (isExplicitlyCompleted(text)) {
        isChildExplicitlyDone = true;
      }
    }
  }

  if (isChildExplicitlyDone) {
    return "completed";
  }

  // 4. 父任务非成功终态穿透收敛：若父任务已 cancelled, interrupted, error, timed_out，
  // 未完成的子代理不能继续误留在 running，应同步收敛为相应终态
  if (["cancelled", "interrupted", "error", "timed_out"].includes(parentState)) {
    return parentState === "cancelled" ? "cancelled" : (parentState === "interrupted" ? "interrupted" : "error");
  }

  // 5. 父任务成功完成兜底：当父任务成功（success 或 completed），未被 killed 的子代理视为随父任务协同完成
  if (parentState === "success" || parentState === "completed") {
    return "completed";
  }

  // 6. 证据不足且处于运行态时严格保持 running，绝不误标已完成
  return "running";
}

// 缓存容量上限与真 LRU 淘汰工具
const MAX_CACHE_ENTRIES = 200;
function pruneCache(cacheMap) {
  if (cacheMap.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cacheMap.keys().next().value;
    if (oldestKey !== undefined) {
      cacheMap.delete(oldestKey);
    }
  }
}

// 单文件级别 transcript 语法解析结果缓存：transcriptPath -> { mtimeMs, size, parsed }
const transcriptCache = new Map();
// 任务级别 log 解析结果缓存：logFile -> { mtimeMs, size, result }
const logFallbackCache = new Map();

/**
 * 解析单个 transcript 文件本身的静态语法结构（带 mtime/size 缓存与真 LRU 淘汰）
 * 仅解析：步数、当前动作、工具调用、创建的子代理引用以及 kill 声明，绝不递归外部子文件
 * @param {string} transcriptPath - 文件路径
 * @returns {object|null}
 */
export function parseLocalTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  let stats = null;
  try {
    stats = fs.statSync(transcriptPath);
  } catch {
    return null;
  }

  const cached = transcriptCache.get(transcriptPath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    // 真 LRU 机制：命中时移至末尾
    transcriptCache.delete(transcriptPath);
    transcriptCache.set(transcriptPath, cached);
    return cached.parsed;
  }

  try {
    const content = fs.readFileSync(transcriptPath, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return null;

    let currentStep = 0;
    let currentAction = "";
    let lastTool = null;
    let lastThinking = "";
    let lastEntry = null;
    let lastPlannerEntry = null;
    const pendingSubagents = [];
    const directSubagents = [];
    const recentActivities = [];
    const killedConversationIds = new Set();

    for (let i = 0; i < lines.length; i++) {
      const entry = safeParseJson(lines[i]);
      if (!entry) continue;

      lastEntry = entry;
      if (entry.type === "PLANNER_RESPONSE" || (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0)) {
        lastPlannerEntry = entry;
      }
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

    const localResult = {
      currentStep,
      currentAction,
      lastTool,
      lastEntry,
      lastPlannerEntry,
      directSubagents,
      recentActivities,
      killedConversationIds,
    };

    if (stats) {
      pruneCache(transcriptCache);
      transcriptCache.set(transcriptPath, {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        parsed: localResult,
      });
    }

    return localResult;
  } catch {
    return null;
  }
}

/**
 * 递归组装 Agent Tree，提取实时运行状态与全员子代理微观工作明细
 * 架构解耦：底层复用 parseLocalTranscript 的单文件缓存，上层动态组装并裁决子代理状态，
 * 绝不把整棵子代理动态树缓存死，根除“子代理步数被父缓存冻结”与“父状态变化子不收敛”两大缺陷
 * @param {string} transcriptPath - transcript 文件绝对路径
 * @param {number} depth - 当前递归层级（防止无限嵌套）
 * @param {number} maxDepth - 最大递归深度（默认支持8级深度）
 * @param {Set<string>} visited - 已遍历文件集合
 * @param {string} parentState - 父任务生命周期状态
 * @returns {object|null} - 动态聚合的结构化状态
 */
export function parseTranscript(transcriptPath, depth = 0, maxDepth = 8, visited = new Set(), parentState = "running", parentId = null) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  if (visited.has(transcriptPath)) return null;
  visited.add(transcriptPath);

  const local = parseLocalTranscript(transcriptPath);
  if (!local) return null;

  // 递归聚合各级子代理的真实微观工作明细（每次依据最新的子代理文件和 parentState 动态计算）
  const allDiscoveredSubagents = [];
  for (const sub of local.directSubagents) {
    let childrenIds = [];
    let childParsed = null;

    if (sub.conversation_id && depth < maxDepth) {
      const subTranscriptPath = locateTranscriptPath(sub.conversation_id);
      if (subTranscriptPath) {
        childParsed = parseTranscript(subTranscriptPath, depth + 1, maxDepth, visited, parentState, sub.conversation_id);
        if (childParsed) {
          childParsed.conversation_id = sub.conversation_id;
          if (childParsed.directSubagents && Array.isArray(childParsed.directSubagents)) {
            childrenIds = childParsed.directSubagents
              .map((c) => c.conversation_id)
              .filter(Boolean);
          }
        }
      }
    }

    const roleLower = String(sub.role || "").toLowerCase();
    const isOrchestrator = childrenIds.length > 0 || roleLower.includes("orchestrator") || roleLower.includes("planner") || roleLower.includes("lead");
    const nodeType = isOrchestrator ? "orchestrator" : "worker";

    const subInfo = {
      role: sub.role,
      type: sub.type,
      conversation_id: sub.conversation_id,
      status: "running",
      step: 0,
      current_action: "等待调度中...",
      last_tool: null,
      recent_activities: [],
      parentId: parentId || null,
      depth: depth + 1,
      childrenIds,
      nodeType,
    };

    if (local.killedConversationIds && sub.conversation_id && local.killedConversationIds.has(sub.conversation_id)) {
      subInfo.status = "killed";
      subInfo.current_action = "已被父任务显式终止 (killed)";
    }

    if (childParsed) {
      subInfo.step = childParsed.currentStep;
      subInfo.current_action = childParsed.currentAction;
      subInfo.last_tool = childParsed.lastTool;
      subInfo.status = evaluateSubagentStatus(childParsed, local.killedConversationIds, parentState);
      subInfo.recent_activities = childParsed.recentActivities.slice(-100);

      // 递归汇总更深层子代理（孙代等），扁平展示给调用方
      if (childParsed.subagents && childParsed.subagents.length > 0) {
        for (const descendant of childParsed.subagents) {
          allDiscoveredSubagents.push(descendant);
        }
      }
    } else if (sub.conversation_id && depth >= maxDepth) {
      subInfo.current_action = "运行中（深度超出最大解析层级）";
    }

    allDiscoveredSubagents.push(subInfo);
  }

  const maxSubStep = allDiscoveredSubagents.reduce((m, s) => Math.max(m, s.step || 0), 0);
  const aggregatedStep = Math.max(local.currentStep, maxSubStep);

  return {
    currentStep: aggregatedStep,
    currentAction: local.currentAction,
    lastTool: local.lastTool,
    lastEntry: local.lastEntry,
    lastPlannerEntry: local.lastPlannerEntry,
    directSubagents: local.directSubagents,
    subagents: allDiscoveredSubagents,
    recentActivities: local.recentActivities.slice(-100),
  };
}

/**
 * 当 transcript 尚未生成时，从任务专用 log 文件中提取基础状态（带 mtimeMs 缓存，避免每秒全量读取）
 * @param {string} logFile - 运行日志路径
 * @returns {object} - 基础阶段与摘要
 */
export function fallbackFromLog(logFile) {
  if (!logFile || !fs.existsSync(logFile)) {
    return { phase: "starting", message: "子代理进程启动中..." };
  }
  try {
    const stats = fs.statSync(logFile);
    const cached = logFallbackCache.get(logFile);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      logFallbackCache.delete(logFile);
      logFallbackCache.set(logFile, cached);
      return cached.result;
    }

    const text = fs.readFileSync(logFile, "utf8");
    const rounds = (text.match(/streamGenerateContent\?alt=sse/g) || []).length;
    const hasTeamwork = text.includes('expanded slash command "teamwork-preview"');
    const isAuthDone = text.includes("OAuth: authenticated") || text.includes("silent auth succeeded");

    let result = { phase: "starting", message: "CLI 引擎初始化中..." };
    if (rounds > 0) {
      result = {
        phase: hasTeamwork ? "teamwork_collaborating" : "thinking",
        rounds,
        message: hasTeamwork
          ? `多智能体团队正在协同工作中（已完成 ${rounds} 轮模型推理）`
          : `模型正在深入思考与生成（已完成 ${rounds} 轮模型推理）`,
      };
    } else if (isAuthDone) {
      result = { phase: "initializing", message: "认证已完成，正在装载工作区上下文并展开指令..." };
    }

    pruneCache(logFallbackCache);
    logFallbackCache.set(logFile, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      result,
    });
    return result;
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

  const rootId = conversationId || job.jobId || null;
  const transcriptPath = locateTranscriptPath(conversationId);
  const transcriptInfo = transcriptPath ? parseTranscript(transcriptPath, 0, 8, new Set(), job.state, rootId) : null;
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

  // 格式化并清洗所有子代理的微观动作（尊重真实的 sub.status，绝不暴力洗绿覆盖）
  const formattedSubagents = (transcriptInfo?.subagents || []).map((sub) => ({
    role: sub.role,
    type: sub.type,
    conversation_id: sub.conversation_id,
    status: sub.status,
    step: sub.step,
    current_action: sanitizeDiagnostics(sub.current_action, 150),
    last_tool: sub.last_tool,
    recent_activities: (sub.recent_activities || []).map((act) => sanitizeDiagnostics(act, 200)),
    parentId: sub.parentId !== undefined ? sub.parentId : (rootId || null),
    depth: typeof sub.depth === "number" ? sub.depth : 1,
    childrenIds: Array.isArray(sub.childrenIds) ? sub.childrenIds : [],
    nodeType: sub.nodeType || (sub.childrenIds && sub.childrenIds.length > 0 ? "orchestrator" : "worker"),
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
