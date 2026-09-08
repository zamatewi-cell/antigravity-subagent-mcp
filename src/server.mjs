import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { enrichAgyResult, sanitizeDiagnostics } from "./diagnostics.mjs";
import { stopProcessTree, isRetryablePreflightFailure } from "./process-control.mjs";
import { getTaskProgress } from "./progress.mjs";
import { persistJob, restorePersistedJobs } from "./storage.mjs";

const SERVER_VERSION = "1.1.0";
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
  const args = [
    "--model", input.model || DEFAULT_MODEL,
    "--output-format", "json",
    "--log-file", logFile,
    "--add-dir", cwd,
  ];

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
  args.push("--print-timeout", `${timeoutSeconds}s`);
  // AGY 的 --print 会吞掉后续参数，因此必须放在最后并使用 --print=<prompt> 形式。
  // 不传 --disable-slash-commands，确保 /teamwork-preview 等系统命令会被完整展开。
  const workspaceContext = `\n\n[Codex delegation context]\nTask working directory (absolute): ${JSON.stringify(cwd)}\nResolve all task-relative paths against this directory. Pass the absolute directory to every subagent and terminal tool. Do not substitute the AGY scratch directory or manufacture missing input data. If an input cannot be read, report the failure. Follow the user's requested file-access and edit scope.\n[/Codex delegation context]`;
  args.push(`--print=${input.prompt}${workspaceContext}`);

  return {
    command: AGY_CLI,
    args,
    cwd,
    model: input.model || DEFAULT_MODEL,
    timeoutSeconds,
    logFile,
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
  const startedAt = new Date();
  const job = {
    jobId,
    state: "running",
    startedAt: startedAt.toISOString(),
    completedAt: null,
    invocation: {
      model: invocation.model,
      cwd: invocation.cwd,
      timeout_seconds: invocation.timeoutSeconds,
      slash_command: input.prompt.startsWith("/") ? input.prompt.split(/\s+/, 1)[0] : null,
      log_file: invocation.logFile,
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
  };

  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: process.env,
    windowsHide: true,
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
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
  child.stdout.on("data", (chunk) => append("stdout", chunk));
  child.stderr.on("data", (chunk) => append("stderr", chunk));

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
      const parsed = parseAgyJson(job.stdout);
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

function stopJob(job, reason) {
  if (job.stopPromise) return job.stopPromise;
  job.stopReason = reason;
  job.state = "stopping";
  if (reason === "cancelled") job.cancelRequested = true;
  if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
  job.stopPromise = stopProcessTree(job.child).catch((error) => {
    job.terminationError = sanitizeDiagnostics(error.message);
    job.state = "error";
    job.result = { status: "ERROR", error: job.terminationError,
      error_details: { layer: "mcp_bridge", code: "PROCESS_TREE_TERMINATION_FAILED" } };
  });
  return job.stopPromise;
}

function publicJob(job, includeResult = true) {
  const output = {
    job_id: job.jobId,
    state: job.state === "retrying" ? "running" : job.state,
    started_at: job.startedAt,
    completed_at: job.completedAt,
    model: job.invocation.model,
    working_directory: job.invocation.cwd,
    slash_command: job.invocation.slash_command,
    attempts: job.attempts,
    progress: getTaskProgress(job),
  };
  if (includeResult && job.result) output.result = job.result;
  if (includeResult && job.state === "error" && job.stderr) {
    output.diagnostic = sanitizeDiagnostics(job.stderr);
  }
  if (includeResult && (job.state === "error" || job.state === "timed_out")) {
    output.diagnostic_log = job.invocation.log_file;
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
  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (signal?.aborted) throw new Error("MCP 调用已取消，未启动新任务。");
    const job = launchAgy(input);
    const abort = () => { void stopJob(job, "cancelled"); };
    signal?.addEventListener("abort", abort, { once: true });

    // 定期向客户端上报进度通知（若客户端支持 progressToken）
    const progressTimer = setInterval(() => {
      if (job.state !== "running" && job.state !== "stopping") {
        clearInterval(progressTimer);
        return;
      }
      try {
        const prog = getTaskProgress(job);
        const token = ctx?.mcpReq?.params?._meta?.progressToken;
        if (ctx?.sendProgressNotification && token !== undefined) {
          ctx.sendProgressNotification({
            progressToken: token,
            progress: prog.current_step,
            total: Math.max(prog.current_step + 1, 10),
            message: `[${prog.phase}] ${prog.current_action}`,
          }).catch(() => {});
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
}

function startWithPreflightRetry(input) {
  const jobId = randomUUID();
  const firstJob = launchAgy(input, jobId);
  void (async () => {
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
  })().catch((error) => {
    const current = jobs.get(jobId);
    if (current && !current.cancelRequested) {
      current.state = "error";
      current.completedAt = new Date().toISOString();
      current.result = { status: "ERROR", error: sanitizeDiagnostics(error.message) };
    }
  });
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
    return toolResponse(publicJob(job), job.state === "error" || job.state === "timed_out");
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
    if (job.state === "retrying") {
      job.cancelRequested = true;
      job.state = "cancelled";
      job.completedAt = new Date().toISOString();
      persistJob(job);
      return toolResponse(publicJob(job));
    }
    if (!["running", "stopping"].includes(job.state)) return toolResponse(publicJob(job), job.state === "error");
    await stopJob(job, "cancelled");
    persistJob(job);
    if (job.terminationError) return toolResponse(publicJob(job), true);
    await job.completion;
    persistJob(job);
    return toolResponse(publicJob(job));
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

const transport = new StdioServerTransport();
await server.connect(transport);

let shutdownPromise;
function shutdownTasks() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = Promise.allSettled([...jobs.values()].map(async (job) => {
    job.cancelRequested = true;
    if (job.state === "retrying") {
      job.state = "cancelled";
      job.completedAt = new Date().toISOString();
    } else if (["running", "stopping"].includes(job.state)) {
      await stopJob(job, "cancelled");
    }
  }));
  return shutdownPromise;
}
const onTransportClose = transport.onclose;
transport.onclose = () => { onTransportClose?.(); void shutdownTasks(); };
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void shutdownTasks().finally(() => server.close()); });
}
