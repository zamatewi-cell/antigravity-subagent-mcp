import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { enrichAgyResult, sanitizeDiagnostics } from "./diagnostics.mjs";
import { stopProcessTree, stopJob, cancelJob, sendInputToJob, finishJob, isRetryablePreflightFailure } from "./process-control.mjs";
import { StreamLineParser, encodeStreamUserMessage } from "./stream-transport.mjs";
import { getTaskProgress } from "./progress.mjs";
import { persistJob, restorePersistedJobs } from "./storage.mjs";
import { startDashboardServer, openInBrowser } from "./dashboard.mjs";
import { withDirectoryLock } from "./directory-lock.mjs";

const SERVER_VERSION = "1.5.1";
const DEFAULT_MODEL = process.env.ANTIGRAVITY_DEFAULT_MODEL || "gemini-3.8-flash-high";
const DEFAULT_PERMISSION_MODE = process.env.ANTIGRAVITY_PERMISSION_MODE || "auto-approve";
const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 21_600;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
function resolveAgyCliPath() {
  if (process.env.AGY_CLI_PATH) return process.env.AGY_CLI_PATH;
  if (process.platform === "win32") {
    const candidatePaths = [
      "D:\\Antigravity\\agy\\bin\\agy.exe",
      path.join(process.env.LOCALAPPDATA || "", "Programs", "antigravity", "bin", "agy.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Antigravity", "bin", "agy.exe"),
      path.join(process.env.ProgramFiles || "", "Antigravity", "agy", "bin", "agy.exe"),
      path.join(process.env.ProgramFiles || "", "Antigravity", "bin", "agy.exe"),
    ];
    for (const p of candidatePaths) {
      if (p && fs.existsSync(p)) return p;
    }
  }
  return "agy";
}
const AGY_CLI = resolveAgyCliPath();
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIAGNOSTIC_LOG_DIR = process.env.ANTIGRAVITY_MCP_LOG_DIR || path.join(SERVER_ROOT, "logs");
fs.mkdirSync(DIAGNOSTIC_LOG_DIR, { recursive: true });
const jobs = restorePersistedJobs();

const invocationSchema = z.object({
  prompt: z.string().trim().min(1).describe(
    "交给 Gemini 的完整提示词。保留开头的系统斜杠指令，并在末尾补充绝对工作目录，例如：/teamwork-preview <完整任务>。",
  ),
  working_directory: z.string().optional().describe(
    "Gemini 工作目录的绝对路径。涉及当前仓库时必须传入当前 Codex 工作目录。",
  ),
  model: z.string().trim().min(1).optional().describe(
    `Antigravity 模型名；默认 ${DEFAULT_MODEL}。`,
  ),
  mode: z.enum(["accept-edits", "plan"]).optional().describe(
    "Antigravity 执行模式。plan 只规划；accept-edits 允许提出和执行修改。",
  ),
  effort: z.enum(["low", "medium", "high"]).optional().describe("推理强度。"),
  permission_mode: z.enum(["default", "sandbox", "auto-approve"]).default(DEFAULT_PERMISSION_MODE).describe(
    `Antigravity 权限模式；默认 ${DEFAULT_PERMISSION_MODE}（auto-approve 确保在无头 headless 模式下工具调用免人工交互确认）。`,
  ),
  agent: z.string().trim().min(1).optional().describe("可选的 Antigravity agent 名称。"),
  conversation_id: z.string().trim().min(1).optional().describe(
    "继续指定 Antigravity 会话；值来自上一次结果的 conversation_id。",
  ),
  continue_latest: z.boolean().default(false).describe("继续最近一次 Antigravity 会话。"),
  project: z.string().trim().min(1).optional().describe("可选的 Antigravity project ID 或名称。"),
  new_project: z.boolean().default(false).describe("为本次调用新建 Antigravity project。"),
  add_directories: z.array(z.string()).max(32).default([]).describe("额外加入 AGY 工作区的目录。"),
  timeout_seconds: z.number().int().min(30).max(MAX_TIMEOUT_SECONDS).default(DEFAULT_TIMEOUT_SECONDS).describe(
    "单次 AGY 运行超时，30 到 21600 秒。Teamwork 长任务应提高该值或使用后台任务工具。",
  ),
  session_mode: z.enum(["print", "stream"]).default("print").describe(
    "AGY 运行轨道模式：print 为常规单次委托执行（自动化/批量），stream 为交互式流传输长会话（支持多轮人机交互）。",
  ),
});

function ensureDirectory(value, label) {
  const resolved = path.resolve(value);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`${label} 不存在：${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} 不是目录：${resolved}`);
  }
  return resolved;
}

function buildInvocation(input, jobId) {
  if (input.conversation_id && input.continue_latest) {
    throw new Error("conversation_id 与 continue_latest 不能同时使用。");
  }
  if (input.project && input.new_project) {
    throw new Error("project 与 new_project 不能同时使用。");
  }

  const cwd = ensureDirectory(
    input.working_directory || process.env.ANTIGRAVITY_DEFAULT_CWD || process.cwd(),
    "working_directory",
  );
  const logFile = path.join(DIAGNOSTIC_LOG_DIR, `agy-${jobId}-${randomUUID()}.log`);
  const sessionMode = input.session_mode || "print";
  const args = [
    "--model", input.model || DEFAULT_MODEL,
    "--log-file", logFile,
    "--add-dir", cwd,
  ];
  if (sessionMode === "stream") {
    args.push("--input-format", "stream-json", "--output-format", "stream-json");
  } else {
    args.push("--output-format", "json");
  }

  if (input.mode) args.push("--mode", input.mode);
  if (input.effort) args.push("--effort", input.effort);
  if (input.agent) args.push("--agent", input.agent);
  if (input.conversation_id) args.push("--conversation", input.conversation_id);
  if (input.continue_latest) args.push("--continue");
  if (input.project) args.push("--project", input.project);
  if (input.new_project) args.push("--new-project");
  for (const directory of input.add_directories) {
    args.push("--add-dir", ensureDirectory(directory, "add_directories 项"));
  }
  if (input.permission_mode === "sandbox") args.push("--sandbox");
  if (input.permission_mode === "auto-approve") args.push("--dangerously-skip-permissions");

  const timeoutSeconds = input.timeout_seconds;
  if (sessionMode === "print") {
    args.push("--print-timeout", `${timeoutSeconds}s`);
    // AGY 的 --print 会吞掉后续参数，因此必须放在最后并使用 --print=<prompt> 形式。
    // 不传 --disable-slash-commands，确保 /teamwork-preview 等系统命令会被完整展开。
    const workspaceContext = `\n\n[Codex delegation context]\nTask working directory (absolute): ${JSON.stringify(cwd)}\nResolve all task-relative paths against this directory. Pass the absolute directory to every subagent and terminal tool. Do not substitute the AGY scratch directory or manufacture missing input data. If an input cannot be read, report the failure. Follow the user's requested file-access and edit scope.\n[/Codex delegation context]`;
    args.push(`--print=${input.prompt}${workspaceContext}`);
  }

  return {
    command: AGY_CLI,
    args,
    cwd,
    model: input.model || DEFAULT_MODEL,
    timeoutSeconds,
    logFile,
    sessionMode,
  };
}

function parseAgyJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch {
        // Keep looking for the final JSON record.
      }
    }
    return null;
  }
}

function launchAgy(input, jobId = randomUUID()) {
  const invocation = buildInvocation(input, jobId);
  const isStream = invocation.sessionMode === "stream";
  const startedAt = new Date();
  const job = {
    jobId,
    state: "running",
    startedAt: startedAt.toISOString(),
    completedAt: null,
    sessionMode: invocation.sessionMode,
    numTurns: 0,
    conversationId: input.conversation_id || null,
    invocation: {
      prompt: input.prompt,
      model: invocation.model,
      cwd: invocation.cwd,
      timeout_seconds: invocation.timeoutSeconds,
      slash_command: input.prompt.startsWith("/") ? input.prompt.split(/\s+/, 1)[0] : null,
      log_file: invocation.logFile,
      session_mode: invocation.sessionMode,
    },
    stdout: "",
    stderr: "",
    result: null,
    child: null,
    cancelRequested: false,
    timeoutHandle: null,
    attempts: 1,
    stopReason: null,
    stopPromise: null,
    terminationError: null,
    streamingText: "",
    onTurnComplete: null,
  };

  let streamParser = null;
  if (isStream) {
    streamParser = new StreamLineParser((evt) => {
      if (!evt || typeof evt !== "object") return;
      if (evt.event === "init" && evt.conversation_id) {
        job.conversationId = evt.conversation_id;
        if (!job.progress) job.progress = {};
        job.progress.conversation_id = evt.conversation_id;
        persistJob(job);
      } else if (evt.event === "step_update" && evt.step_update) {
        const su = evt.step_update;
        if (!job.progress) job.progress = {};
        if (su.step_index !== undefined) job.progress.current_step = su.step_index;
        job.progress.phase = su.state === "DONE" ? "WAITING_INPUT" : "EXECUTING";
        if (su.step_type) job.progress.current_action = `[${su.step_type}] ${su.state || ""}`;
        if (su.step_type === "agent_response" && su.text_delta) {
          job.streamingText = (job.streamingText || "") + su.text_delta;
        }
      } else if (evt.event === "result" && evt.result) {
        const res = evt.result;
        job.numTurns = res.num_turns || (job.numTurns || 0) + 1;
        job.lastTurnResult = res;
        job.result = res;
        if (res.conversation_id) job.conversationId = res.conversation_id;
        if (!job.progress) job.progress = {};
        job.progress.phase = "IDLE_AWAITING_INPUT";
        job.progress.current_action = `Turn ${job.numTurns} completed`;
        persistJob(job);
        if (typeof job.onTurnComplete === "function") {
          job.onTurnComplete(res);
        }
      }
    });
  }

  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: process.env,
    windowsHide: true,
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  job.child = child;
  jobs.set(jobId, job);
  persistJob(job);

  const append = (field, chunk) => {
    if (job.stopReason) return;
    job[field] += chunk.toString("utf8");
    if (Buffer.byteLength(job.stdout) + Buffer.byteLength(job.stderr) > MAX_CAPTURE_BYTES) {
      job.stderr += "\nMCP bridge stopped AGY because captured output exceeded 16 MiB.";
      void stopJob(job, "output_limit");
    }
  };
  child.stdout.on("data", (chunk) => {
    append("stdout", chunk);
    if (streamParser) streamParser.feed(chunk);
  });
  child.stderr.on("data", (chunk) => append("stderr", chunk));

  // 流式交互模式下，通过 stdin 发送首发 prompt
  if (isStream) {
    const workspaceContext = `\n\n[Codex delegation context]\nTask working directory (absolute): ${JSON.stringify(invocation.cwd)}\nResolve all task-relative paths against this directory. Pass the absolute directory to every subagent and terminal tool. Do not substitute the AGY scratch directory or manufacture missing input data. If an input cannot be read, report the failure. Follow the user's requested file-access and edit scope.\n[/Codex delegation context]`;
    const initialPrompt = `${input.prompt}${workspaceContext}`;
    const initialMsg = encodeStreamUserMessage(initialPrompt);
    child.stdin.write(initialMsg);
  }

  job.completion = new Promise((resolve) => {
    child.once("error", (error) => {
      if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
      job.state = "error";
      job.spawnErrorCode = error.code;
      job.preflightConfirmed = !child.pid;
      job.completedAt = new Date().toISOString();
      job.result = {
        status: "ERROR",
        response: "",
        error: sanitizeDiagnostics(`无法启动 Antigravity CLI：${error.message}`),
      };
      persistJob(job);
      resolve(job);
    });

    child.once("close", async (exitCode, signal) => {
      if (job.completedAt) return;
      if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
      if (job.stopPromise) await job.stopPromise;
      if (streamParser) streamParser.flush();
      const parsed = isStream
        ? (job.lastTurnResult || job.result)
        : parseAgyJson(job.stdout);
      let diagnosticLog = "";
      try {
        diagnosticLog = fs.readFileSync(job.invocation.log_file, "utf8");
      } catch {
        // AGY can fail before its logger creates the file.
      }
      const fallbackResult = {
        status: job.state === "timed_out" ? "TIMEOUT" : "ERROR",
        response: "",
        error: sanitizeDiagnostics(job.stderr) || `AGY 退出码 ${exitCode ?? "unknown"}，信号 ${signal ?? "none"}。`,
      };
      job.result = enrichAgyResult(parsed || fallbackResult, diagnosticLog);
      if (!job.stopReason && job.result?.status === "SUCCESS" && exitCode !== 0) {
        job.result = { ...job.result, status: "ERROR", error: `AGY 非正常退出：${exitCode ?? signal ?? "unknown"}。`,
          error_details: { layer: "antigravity_cli", code: "ABNORMAL_EXIT" } };
      }
      if (job.stopReason) {
        const states = { cancelled: ["cancelled", "CANCELLED"], timed_out: ["timed_out", "TIMEOUT"], output_limit: ["error", "ERROR"] };
        const [state, status] = states[job.stopReason];
        job.state = job.terminationError ? "error" : state;
        job.result = {
          ...job.result,
          status: job.terminationError ? "ERROR" : status,
          error: job.terminationError || { cancelled: "任务已取消。", timed_out: "任务执行超时。", output_limit: "任务输出超过 16 MiB 限制。" }[job.stopReason],
          error_details: { layer: "mcp_bridge", code: job.terminationError ? "PROCESS_TREE_TERMINATION_FAILED" : job.stopReason.toUpperCase() },
        };
      } else if (job.result?.status === "SUCCESS" && exitCode === 0) {
        job.state = "success";
      } else {
        job.state = "error";
      }
      job.completedAt = new Date().toISOString();
      persistJob(job);
      resolve(job);
    });
  });

  job.timeoutHandle = setTimeout(() => {
    if (job.state !== "running") return;
    void stopJob(job, "timed_out");
  }, (invocation.timeoutSeconds + 5) * 1000);

  return job;
}


function publicJob(job, includeResult = true) {
  const output = {
    job_id: job.jobId,
    state: job.state,
    started_at: job.startedAt,
    completed_at: job.completedAt,
    model: job.invocation?.model,
    working_directory: job.invocation?.cwd,
    slash_command: job.invocation?.slash_command,
    session_mode: job.sessionMode || "print",
    num_turns: job.numTurns || 0,
    conversation_id: job.conversationId || job.progress?.conversation_id || null,
    attempts: job.attempts,
    progress: getTaskProgress(job),
  };
  if (includeResult && job.result) output.result = job.result;
  if (includeResult && job.state === "error" && job.stderr) {
    output.diagnostic = sanitizeDiagnostics(job.stderr);
  }
  if (includeResult && (["error", "timed_out", "interrupted"].includes(job.state))) {
    output.diagnostic_log = job.invocation?.log_file;
  }
  return output;
}

function toolResponse(payload, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError,
  };
}

async function runWithPreflightRetry(input, signal, ctx) {
  const cwd = input.working_directory || process.env.ANTIGRAVITY_DEFAULT_CWD || process.cwd();
  return await withDirectoryLock(cwd, signal, async () => {
    const attempts = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (signal?.aborted) throw new Error("MCP 调用已取消，未启动新任务。");
      const job = launchAgy(input);
      if (job.sessionMode === "stream") {
        // 单次同步等待调用，在首轮得到结果后自动关闭 stdin 促使进程正常收敛退出
        job.onTurnComplete = () => {
          try { job.child?.stdin?.end(); } catch {}
        };
      }
      const abort = () => { void stopJob(job, "cancelled"); };
      signal?.addEventListener("abort", abort, { once: true });

      // 定期向客户端上报进度通知（支持 ctx.mcpReq.notify 与 progressToken）
      const progressTimer = setInterval(async () => {
        if (job.state !== "running" && job.state !== "stopping") {
          clearInterval(progressTimer);
          return;
        }
        try {
          const prog = getTaskProgress(job);
          const token = ctx?.mcpReq?._meta?.progressToken ?? ctx?.mcpReq?.params?._meta?.progressToken;
          if (token !== undefined) {
            if (typeof ctx?.mcpReq?.notify === "function") {
              await ctx.mcpReq.notify({
                method: "notifications/progress",
                params: {
                  progressToken: token,
                  progress: prog.current_step,
                  total: Math.max(prog.current_step + 1, 10),
                  message: `[${prog.phase}] ${prog.current_action}`,
                },
              });
            } else if (typeof ctx?.sendProgressNotification === "function") {
              await ctx.sendProgressNotification({
                progressToken: token,
                progress: prog.current_step,
                total: Math.max(prog.current_step + 1, 10),
                message: `[${prog.phase}] ${prog.current_action}`,
              });
            }
          }
        } catch {}
      }, 2000);

      try { await job.completion; }
      finally {
        clearInterval(progressTimer);
        signal?.removeEventListener("abort", abort);
      }
      attempts.push(job);
      if (!isRetryablePreflightFailure(job) || attempt === 3) {
        const result = publicJob(job);
        result.attempts = attempts.length;
        return { job, result };
      }
      const delayMs = attempt === 1 ? 1_500 : 5_000;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error("Antigravity retry loop ended unexpectedly.");
  });
}

function startWithPreflightRetry(input) {
  const jobId = randomUUID();
  const cwd = input.working_directory || process.env.ANTIGRAVITY_DEFAULT_CWD || process.cwd();
  let firstJob = null;

  // 使用目录锁确保同目录异步后台任务也是串行排队运行
  const backgroundExecution = withDirectoryLock(cwd, null, async () => {
    const existing = jobs.get(jobId);
    if (existing && (existing.cancelRequested || existing.state === "cancelled")) {
      return;
    }
    firstJob = launchAgy(input, jobId);
    let currentJob = firstJob;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await currentJob.completion;
      if (!isRetryablePreflightFailure(currentJob) || attempt === 3) return;
      currentJob.state = "retrying";
      currentJob.result = null;
      currentJob.completedAt = null;
      const delayMs = attempt === 1 ? 1_500 : 5_000;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (currentJob.cancelRequested || jobs.get(jobId) !== currentJob) return;
      const retryJob = launchAgy(input, jobId);
      retryJob.attempts = attempt + 1;
      retryJob.startedAt = firstJob.startedAt;
      currentJob = retryJob;
    }
  }).catch((error) => {
    const current = jobs.get(jobId);
    if (current && !current.cancelRequested && current.state !== "cancelled") {
      current.state = "error";
      current.completedAt = new Date().toISOString();
      current.result = { status: "ERROR", error: sanitizeDiagnostics(error.message) };
    }
  });

  // 如果锁已被占用，先注册排队占位 job
  if (!firstJob) {
    firstJob = {
      jobId,
      state: "queued",
      startedAt: new Date().toISOString(),
      completedAt: null,
      invocation: { prompt: input.prompt, cwd, model: input.model || DEFAULT_MODEL },
      result: null,
      attempts: 1,
      completion: backgroundExecution,
    };
    jobs.set(jobId, firstJob);
    persistJob(firstJob);
  }

  return firstJob;
}

async function runInfoCommand(args, timeoutMs = 30_000) {
  return await new Promise((resolve) => {
    const child = spawn(AGY_CLI, args, {
      env: process.env,
      windowsHide: true,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { void stopProcessTree(child).catch((error) => {
      resolve({ ok: false, output: "", error: sanitizeDiagnostics(error.message) });
    }); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: "", error: error.message });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        output: stdout.trim(),
        error: code === 0 ? "" : sanitizeDiagnostics(stderr),
      });
    });
  });
}

const server = new McpServer({
  name: "antigravity-subagent",
  version: SERVER_VERSION,
});

server.registerTool(
  "delegate_to_gemini",
  {
    title: "委派任务给 Gemini 子代理",
    description:
      `通过 Antigravity CLI 调用 Gemini，默认模型为 ${DEFAULT_MODEL}。` +
      "保留 prompt 并补充绝对工作目录，启用斜杠命令展开，可直接调用 /teamwork-preview <任务> 等系统命令。" +
      "调用会等待结果；预计超过数分钟的 Teamwork 任务请使用 start_gemini_task。",
    inputSchema: invocationSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async (input, ctx) => {
    try {
      const { job, result } = await runWithPreflightRetry(input, ctx.mcpReq.signal, ctx);
      return toolResponse(result, job.state !== "success");
    } catch (error) {
      return toolResponse({ status: "ERROR", error: error.message }, true);
    }
  },
);

server.registerTool(
  "start_gemini_task",
  {
    title: "后台启动 Gemini 子代理",
    description:
      "后台启动 Antigravity/Gemini 任务并立即返回 job_id，适合 /teamwork-preview 等长任务。" +
      "之后用 get_gemini_task 查询；后台任务依赖当前 MCP 服务进程保持运行。",
    inputSchema: invocationSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async (input) => {
    try {
      const job = startWithPreflightRetry(input);
      return toolResponse(publicJob(job, false));
    } catch (error) {
      return toolResponse({ status: "ERROR", error: error.message }, true);
    }
  },
);

server.registerTool(
  "get_gemini_task",
  {
    title: "查询 Gemini 子代理任务",
    description: "按 job_id 查询后台 Gemini/Teamwork 任务状态和最终结果。",
    inputSchema: z.object({ job_id: z.string().uuid() }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ job_id }) => {
    const job = jobs.get(job_id);
    if (!job) return toolResponse({ status: "ERROR", error: `未找到任务：${job_id}` }, true);
    return toolResponse(publicJob(job), ["error", "timed_out", "interrupted"].includes(job.state));
  },
);

server.registerTool(
  "cancel_gemini_task",
  {
    title: "取消 Gemini 子代理任务",
    description: "终止当前 MCP 进程中仍在运行的 Gemini/Teamwork 后台任务。",
    inputSchema: z.object({ job_id: z.string().uuid() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  async ({ job_id }) => {
    const job = jobs.get(job_id);
    if (!job) return toolResponse({ status: "ERROR", error: `未找到任务：${job_id}` }, true);
    await cancelJob(job);
    return toolResponse(publicJob(job), job.state === "error");
  },
);

server.registerTool(
  "interact_gemini_task",
  {
    title: "与运行中的 Gemini 子代理交互 (HITL)",
    description: "向正在运行的长会话子代理（尤其处于 stream 模式的任务）注入交互式指令或人工输入，支持可选在完成当轮后优雅结束会话。",
    inputSchema: z.object({
      job_id: z.string().uuid().describe("目标运行中任务的 job_id"),
      input: z.string().min(1).describe("需要向子代理输入的指令或交互内容"),
      end_session: z.boolean().default(false).describe("是否在本次交互发送后自动关闭输入流，触发任务在当前轮次完成后收敛为 success 终态"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ job_id, input, end_session }) => {
    const job = jobs.get(job_id);
    if (!job) return toolResponse({ status: "ERROR", error: `未找到任务：${job_id}` }, true);
    if (job.state !== "running") {
      return toolResponse({ status: "ERROR", error: `任务当前状态为 ${job.state}，无法接收交互输入` }, true);
    }
    if (end_session) {
      job.onTurnComplete = () => {
        try { job.child?.stdin?.end(); } catch {}
      };
    }
    try {
      const sendResult = await sendInputToJob(job, input);
      return toolResponse({
        status: "SUCCESS",
        job_id: job.jobId,
        bytes_written: sendResult.bytesWritten,
        session_mode: sendResult.sessionMode,
        num_turns: job.numTurns || 0,
        end_session: Boolean(end_session),
      });
    } catch (err) {
      return toolResponse({ status: "ERROR", error: err.message }, true);
    }
  },
);

server.registerTool(
  "finish_gemini_task",
  {
    title: "优雅结束 Gemini 子代理长会话 (HITL)",
    description: "主动结束处于 stream 模式的运行中任务，关闭 stdin 管道并等待任务优雅收敛进入 success 终态。",
    inputSchema: z.object({
      job_id: z.string().uuid().describe("目标 stream 运行中任务的 job_id"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ job_id }) => {
    const job = jobs.get(job_id);
    if (!job) return toolResponse({ status: "ERROR", error: `未找到任务：${job_id}` }, true);
    if (job.sessionMode !== "stream") {
      return toolResponse({ status: "ERROR", error: `任务 ${job_id} 为 ${job.sessionMode || "print"} 模式，仅 stream 会话任务支持 finish` }, true);
    }
    if (job.state !== "running") {
      return toolResponse(publicJob(job), job.state === "error");
    }
    try {
      await finishJob(job);
      return toolResponse(publicJob(job), job.state === "error");
    } catch (err) {
      return toolResponse({ status: "ERROR", error: err.message }, true);
    }
  },
);

server.registerTool(
  "antigravity_status",
  {
    title: "检查 Antigravity 子代理状态",
    description: `检查 AGY CLI 版本、可用模型，以及默认模型 ${DEFAULT_MODEL} 是否存在。`,
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  async () => {
    // AGY may briefly fail authentication/model setup if multiple CLI processes
    // initialize its local store concurrently, so status probes are serialized.
    const version = await runInfoCommand(["--version"]);
    const models = await runInfoCommand(["models"]);
    const agents = await runInfoCommand(["agent"]);
    const modelList = models.output.split(/\r?\n/).filter(Boolean);
    const payload = {
      status: version.ok && models.ok ? "READY" : "ERROR",
      cli_path: AGY_CLI,
      cli_version: version.output,
      default_model: DEFAULT_MODEL,
      default_model_available: modelList.some((line) => line.split(/\s+/)[0] === DEFAULT_MODEL),
      default_permission_mode: DEFAULT_PERMISSION_MODE,
      models: modelList,
      agents: agents.output.split(/\r?\n/).filter(Boolean),
      errors: [version.error, models.error, agents.error].filter(Boolean),
    };
    return toolResponse(payload, payload.status !== "READY" || !payload.default_model_available);
  },
);

let dashboardInstance = null;
async function getOrStartDashboard(autoOpen = true) {
  if (!dashboardInstance) {
    dashboardInstance = await startDashboardServer({
      memoryJobs: jobs,
      autoOpen,
    });
  } else if (autoOpen) {
    openInBrowser(dashboardInstance.url);
  }
  return dashboardInstance;
}

server.registerTool(
  "open_dashboard",
  {
    title: "打开 Antigravity 子代理实时可视化看板",
    description: "在系统默认浏览器中打开独立的可视化监控看板（Web UI），实时展示全员子代理微观工作流、动作流与物理日志。",
    inputSchema: z.object({
      auto_open: z.boolean().default(true).describe("是否自动在默认浏览器中弹出看板窗口"),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ auto_open }) => {
    try {
      const d = await getOrStartDashboard(auto_open);
      return toolResponse({
        status: "READY",
        url: d.url,
        port: d.port,
        message: `可视化看板已就绪：${d.url}`,
      });
    } catch (err) {
      return toolResponse({ status: "ERROR", error: `启动看板失败: ${err.message}` }, true);
    }
  },
);

// 若环境显式开启了自动启动看板，则随 MCP 进程并行拉起
if (process.env.ANTIGRAVITY_ENABLE_DASHBOARD === "1") {
  void getOrStartDashboard(false).catch(() => {});
}

const transport = new StdioServerTransport();
await server.connect(transport);

let shutdownPromise;
function shutdownTasks() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = Promise.allSettled([
    ...[...jobs.values()].map(async (job) => {
      if (["running", "stopping", "queued", "retrying"].includes(job.state)) {
        await cancelJob(job);
      }
    }),
    dashboardInstance ? dashboardInstance.close().catch(() => {}) : Promise.resolve(),
  ]);
  return shutdownPromise;
}
const onTransportClose = transport.onclose;
transport.onclose = () => { onTransportClose?.(); void shutdownTasks(); };
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void shutdownTasks().finally(() => server.close()); });
}
