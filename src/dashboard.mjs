import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { restorePersistedJobs, persistJob, loadPersistedJobsRaw, JOBS_DIR } from "./storage.mjs";
import { getTaskProgress } from "./progress.mjs";
import { cancelJob, sendInputToJob } from "./process-control.mjs";
import { sanitizeDiagnostics } from "./diagnostics.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_ROOT = path.resolve(__dirname, "web");
const HTML_FILE = path.join(WEB_ROOT, "index.html");

const DEFAULT_PORT = Number(process.env.ANTIGRAVITY_DASHBOARD_PORT) || 3721;
const DASHBOARD_VERSION = "1.4.0";

// 物理日志读取尾部内存缓存：logFile -> { mtimeMs, size, tail }，避免每秒重复打开同步读取
const logTailCache = new Map();

/**
 * 格式化输出提供给前端看板的任务视图对象
 * @param {object} job 
 * @returns {object}
 */
export function formatJobDetail(job) {
  if (!job) return null;

  // 终态任务直接复用固化进度缓存，杜绝重复 I/O
  const isTerminal = ["completed", "success", "error", "cancelled", "interrupted"].includes(job.state);
  let progress = isTerminal && job._cachedProgress ? job._cachedProgress : null;
  if (!progress) {
    if (job.progress && typeof job.progress === "object" && job.progress.phase) {
      progress = job.progress;
    } else {
      progress = getTaskProgress(job);
      if (isTerminal) {
        job._cachedProgress = progress;
      }
    }
  }

  // 尝试读取物理日志尾部（若有），带 mtime/size 缓存并经过全量脱敏
  let logTail = "";
  const logFile = job.invocation?.log_file;
  if (logFile && fs.existsSync(logFile)) {
    try {
      const stats = fs.statSync(logFile);
      const cached = logTailCache.get(logFile);
      if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
        logTailCache.delete(logFile);
        logTailCache.set(logFile, cached);
        logTail = cached.tail;
      } else {
        const readBytes = Math.min(stats.size, 16 * 1024);
        const buffer = Buffer.alloc(readBytes);
        const fd = fs.openSync(logFile, "r");
        fs.readSync(fd, buffer, 0, readBytes, Math.max(0, stats.size - readBytes));
        fs.closeSync(fd);
        logTail = sanitizeDiagnostics(buffer.toString("utf8"), 16 * 1024);
        logTailCache.set(logFile, { mtimeMs: stats.mtimeMs, size: stats.size, tail: logTail });
        if (logTailCache.size > 100) {
          const oldestKey = logTailCache.keys().next().value;
          logTailCache.delete(oldestKey);
        }
      }
    } catch {
      logTail = "";
    }
  }

  return {
    jobId: job.jobId,
    state: job.state,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    invocation: {
      prompt: job.invocation?.prompt || job.invocation?.slash_command || (job.result?.response ? job.result.response.slice(0, 120).replace(/\r?\n/g, ' ') : "") || "",
      cwd: job.invocation?.cwd || "",
      model: job.invocation?.model || "",
      slash_command: job.invocation?.slash_command || null,
      timeout_seconds: job.invocation?.timeout_seconds || 300,
      log_file: job.invocation?.log_file || null,
    },
    attempts: job.attempts || 1,
    result: job.result || null,
    progress: {
      phase: progress?.phase || "UNKNOWN",
      current_step: progress?.current_step || 0,
      current_action: progress?.current_action || "",
      last_tool: progress?.last_tool || null,
      conversation_id: progress?.conversation_id || null,
      subagents: progress?.subagents || [],
      recent_activities: progress?.recent_activities || [],
    },
    logTail,
  };
}

/**
 * 在系统默认浏览器中打开指定链接（跨平台兼容）
 * @param {string} targetUrl 
 */
export function openInBrowser(targetUrl) {
  const platform = process.platform;
  let cmd = "";
  if (platform === "win32") {
    cmd = `start "" "${targetUrl}"`;
  } else if (platform === "darwin") {
    cmd = `open "${targetUrl}"`;
  } else {
    cmd = `xdg-open "${targetUrl}"`;
  }
  exec(cmd, () => {});
}

/**
 * 启动可视化看板 HTTP & SSE 服务
 * @param {object} options
 * @param {Map<string, object>} [options.memoryJobs] - 可选的内存任务 Map（与主 MCP 共享）
 * @param {number} [options.port] - 期望端口
 * @param {boolean} [options.autoOpen] - 是否自动在浏览器打开
 * @returns {Promise<{ server: http.Server, port: number, url: string, close: () => Promise<void> }>}
 */
export function startDashboardServer(options = {}) {
  const desiredPort = options.port || DEFAULT_PORT;
  const memoryJobs = options.memoryJobs || null;
  const sseClients = new Set();
  let currentSeq = 1;
  const lastJobFingerprints = new Map();
  const eventHistory = [];
  const EVENT_HISTORY_MAX = 200;

  function getJobFingerprint(job) {
    if (!job) return "";
    const isTerminal = ["completed", "success", "error", "cancelled", "interrupted"].includes(job.state);
    const progress = (isTerminal && job._cachedProgress)
      ? job._cachedProgress
      : (job.progress && typeof job.progress === "object" && job.progress.phase
          ? job.progress
          : getTaskProgress(job));

    // 稳定化子代理微观指纹（精准捕获 ID、状态流转、步数推进、动作切换、工具调用、拓扑链）
    const subagentsFingerprint = (progress?.subagents || [])
      .map(s => {
        const id = s.conversation_id || s.id || "";
        const children = Array.isArray(s.childrenIds) ? s.childrenIds.slice().sort().join(",") : "";
        return `${id}:${s.status || ""}:${s.step || 0}:${s.current_action || ""}:${s.last_tool || ""}:${s.parentId || ""}:[${children}]`;
      })
      .sort()
      .join(";");

    const actsCount = progress?.recent_activities?.length || 0;
    const lastAct = actsCount > 0 ? progress.recent_activities[actsCount - 1] : "";

    return `${job.state}|${job.completedAt || ""}|${progress?.current_step || 0}|${progress?.phase || ""}|${progress?.current_action || ""}|${progress?.last_tool || ""}|${subagentsFingerprint}|${actsCount}:${lastAct}|${job.attempts || 1}|${job.cancelRequested ? 1 : 0}`;
  }

  // 初始化指纹表
  try {
    const initJobs = getAllJobs();
    for (const j of initJobs) {
      lastJobFingerprints.set(j.jobId, getJobFingerprint(j));
    }
  } catch {}

  function safeSendEvent(client, eventType, dataObj, id) {
    try {
      if (client.writableEnded || client.destroyed) {
        sseClients.delete(client);
        return false;
      }
      let msg = "";
      if (id !== undefined) {
        msg += `id: ${id}\n`;
      }
      msg += `event: ${eventType}\ndata: ${JSON.stringify(dataObj)}\n\n`;
      client.write(msg);
      return true;
    } catch {
      sseClients.delete(client);
      return false;
    }
  }

  function safeSendRaw(client, rawStr) {
    try {
      if (client.writableEnded || client.destroyed) {
        sseClients.delete(client);
        return false;
      }
      client.write(rawStr);
      return true;
    } catch {
      sseClients.delete(client);
      return false;
    }
  }

  function getAllJobs() {
    if (memoryJobs) {
      return Array.from(memoryJobs.values());
    }
    const diskJobs = loadPersistedJobsRaw();
    return Array.from(diskJobs.values());
  }

  function getJobById(id) {
    if (memoryJobs && memoryJobs.has(id)) {
      return memoryJobs.get(id);
    }
    const diskJobs = loadPersistedJobsRaw();
    return diskJobs.get(id) || null;
  }

  const server = http.createServer(async (req, res) => {
    // 检查 Host 头，防止 DNS Rebinding 攻击（只允许 localhost / 127.0.0.1 及其带端口的形式）
    const host = req.headers.host || "";
    if (host && !/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Bad Request: Invalid Host header" }));
      return;
    }

    // 跨域支持与预检（收紧来源，仅允许本地 localhost/127.0.0.1 或同源请求）
    const origin = req.headers.origin;
    const isLocalOrigin = !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

    if (origin && isLocalOrigin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }

    if (req.method === "OPTIONS") {
      if (!isLocalOrigin) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Forbidden: Cross-origin request not allowed" }));
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // 对产生副作用的请求（如 POST），若带非本地 Origin，必须直接拒绝 403
    if (req.method === "POST" && !isLocalOrigin) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Forbidden: Cross-origin POST request rejected" }));
      return;
    }

    const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = reqUrl.pathname;

    // 1. 静态主页路由
    if (pathname === "/" || pathname === "/index.html") {
      if (fs.existsSync(HTML_FILE)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        fs.createReadStream(HTML_FILE).pipe(res);
      } else {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<!DOCTYPE html><html><body><h1>Antigravity Subagent Dashboard</h1><p>Web UI file not found.</p></body></html>");
      }
      return;
    }

    // 2. 服务端状态 API
    if (pathname === "/api/status") {
      const all = getAllJobs();
      const activeCount = all.filter(j => ["running", "queued", "stopping", "retrying"].includes(j.state)).length;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        status: "OK",
        version: DASHBOARD_VERSION,
        active_jobs: activeCount,
        total_jobs: all.length,
        sse_connections: sseClients.size,
      }));
      return;
    }

    // 3. 任务列表 API（支持服务端分页、多维过滤、模糊搜索与向下兼容）
    if (pathname === "/api/jobs") {
      const searchParams = reqUrl.searchParams;
      const pageParam = searchParams.get("page");
      const limitParam = searchParams.get("limit");
      const stateParam = searchParams.get("state");
      const searchParam = searchParams.get("search");

      // 判定是否进入标准分页过滤模式；若未指定任何相关参数，则保持向后兼容全量数组
      const isPaginated = pageParam !== null || limitParam !== null || stateParam !== null || searchParam !== null;

      // 获取全部原始任务（复用已有的 mtime LRU 缓存）
      let jobs = getAllJobs();

      // 步骤 1: 内存过滤 - 状态精确匹配 (running, queued, success, error, cancelled, interrupted 等)
      if (stateParam !== null && stateParam.trim() !== "") {
        const targetState = stateParam.trim();
        jobs = jobs.filter((j) => j.state === targetState);
      }

      // 步骤 2: 内存过滤 - 关键词模糊检索 (大小写不敏感，覆盖 Job ID、Prompt、SlashCommand 及 Response 摘要)
      if (searchParam !== null && searchParam.trim() !== "") {
        const term = searchParam.trim().toLowerCase();
        jobs = jobs.filter((j) => {
          const id = String(j.jobId || "").toLowerCase();
          const prompt = String(
            j.invocation?.prompt ||
            j.invocation?.slash_command ||
            (j.result?.response ? j.result.response.slice(0, 120) : "") ||
            ""
          ).toLowerCase();
          return id.includes(term) || prompt.includes(term);
        });
      }

      // 步骤 3: 内存时间降序排序 (最新优先，防 NaN / null 漂移)
      jobs.sort((a, b) => {
        const timeA = a.startedAt ? new Date(a.startedAt).getTime() : 0;
        const timeB = b.startedAt ? new Date(b.startedAt).getTime() : 0;
        const validA = Number.isNaN(timeA) ? 0 : timeA;
        const validB = Number.isNaN(timeB) ? 0 : timeB;
        return validB - validA;
      });

      // 步骤 4: 向后兼容分支 - 若请求未显式携带分页/过滤参数，直接返回全量格式化数组
      if (!isPaginated) {
        const payload = jobs.map(formatJobDetail);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(payload));
        return;
      }

      // 步骤 5: 分页参数校验与边界防御性修正
      // page: 默认 1, 1-based 索引, 必须 >= 1
      let page = 1;
      if (pageParam !== null) {
        const parsedPage = parseInt(pageParam, 10);
        if (!Number.isNaN(parsedPage) && parsedPage >= 1) {
          page = parsedPage;
        } else {
          page = 1;
        }
      }

      // limit: 默认 20, 合法范围 1~100
      let limit = 20;
      if (limitParam !== null) {
        const parsedLimit = parseInt(limitParam, 10);
        if (Number.isNaN(parsedLimit)) {
          limit = 20;
        } else if (parsedLimit < 1) {
          limit = 1;
        } else if (parsedLimit > 100) {
          limit = 100;
        } else {
          limit = parsedLimit;
        }
      }

      // 步骤 6: 分页元数据精准计算
      const total = jobs.length;
      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
      const hasMore = page < totalPages;

      // 步骤 7: 内存切片 - 超出页数时优雅返回空数组
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + limit;
      const slicedJobs = (startIndex >= total) ? [] : jobs.slice(startIndex, endIndex);

      // 步骤 8: 仅对当前切片调用 formatJobDetail，彻底杜绝磁盘高频 I/O 阻塞
      const data = slicedJobs.map(formatJobDetail);

      // 返回标准 REST 分页响应
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        data,
        pagination: {
          total,
          page,
          limit,
          totalPages,
          hasMore,
        },
      }));
      return;
    }

    // 4. 单个任务详情 API
    const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobMatch) {
      const jobId = jobMatch[1];
      const job = getJobById(jobId);
      if (!job) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: `未找到任务 ${jobId}` }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(formatJobDetail(job)));
      return;
    }

    // 5. 任务取消 API
    const cancelMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === "POST") {
      const jobId = cancelMatch[1];
      const job = getJobById(jobId);
      if (!job) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: `未找到任务 ${jobId}` }));
        return;
      }

      // 独立模式（无 memoryJobs 共享）：只读监控看板，禁止发起任何取消操作，避免跨进程状态冲突与幽灵进程
      if (!memoryJobs) {
        res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          error: `无法在独立看板中取消任务 ${jobId}：独立看板仅提供只读监控。请在宿主 MCP 进程或客户端中执行取消，禁止跨进程篡改状态。`,
          code: "STANDALONE_CANCEL_FORBIDDEN",
        }));
        return;
      }

      // 集成模式下的兜底保护：若处于运行态但失去了进程句柄，也拒绝假取消
      const isProcessRunning = ["running", "stopping"].includes(job.state);
      const hasLiveHandle = Boolean(job.child && typeof job.child.kill === "function");
      if (isProcessRunning && !hasLiveHandle) {
        res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          error: `无法取消任务 ${jobId}：丢失进程句柄。`,
          code: "PROCESS_HANDLE_LOST",
        }));
        return;
      }

      await cancelJob(job);

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ status: "SUCCESS", message: `任务 ${jobId} 已成功取消`, job: formatJobDetail(job) }));
      return;
    }

    // 5.1 人机软介入交互 API (Human-in-the-loop)
    const interactMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/interact$/);
    if (interactMatch && req.method === "POST") {
      const jobId = interactMatch[1];
      const job = getJobById(jobId);

      // 若任务不存在或独立看板模式（无内存进程句柄），直接按契约返回 400
      if (!job || !memoryJobs) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Job is not running or stdin is closed" }));
        return;
      }

      // 终态任务检查（running 态以外均按契约返回 400）
      if (job.state !== "running") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Job is not running or stdin is closed" }));
        return;
      }

      const MAX_BODY_BYTES = 64 * 1024; // 64 KiB 上限
      let bodyBytes = 0;
      let bodyStr = "";
      let isTooLarge = false;

      req.on("data", (chunk) => {
        if (isTooLarge) return;
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_BODY_BYTES) {
          isTooLarge = true;
          res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "Payload Too Large: input exceeds 64 KiB limit", code: "PAYLOAD_TOO_LARGE" }));
          req.destroy();
          return;
        }
        bodyStr += chunk.toString("utf8");
      });

      req.on("end", async () => {
        if (isTooLarge) return;
        try {
          let body = {};
          if (bodyStr.trim()) {
            try {
              body = JSON.parse(bodyStr);
            } catch {
              res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ error: "Invalid JSON body" }));
              return;
            }
          }

          if (body.input === undefined || typeof body.input !== "string") {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "input is required and must be a string" }));
            return;
          }

          try {
            const sendResult = await sendInputToJob(job, body.input);
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({
              success: true,
              jobId,
              bytesWritten: sendResult.bytesWritten,
              flushed: sendResult.flushed,
              experimental: true,
            }));
          } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: err.message || "Job is not running or stdin is closed" }));
          }
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // 6. SSE 实时事件流
    if (pathname === "/api/stream") {
      const headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      };
      if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        headers["Access-Control-Allow-Origin"] = origin;
      }
      res.writeHead(200, headers);

      // 1. 严格满足既有单测契约：先推送 connected 事件
      res.write("event: connected\ndata: {}\n\n");
      sseClients.add(res);

      // 2. 检查重连标识
      const lastEventIdHeader = req.headers["last-event-id"];
      const lastSeqQuery = reqUrl.searchParams.get("lastSeq");
      const clientLastSeq = lastEventIdHeader ? parseInt(lastEventIdHeader, 10) : (lastSeqQuery ? parseInt(lastSeqQuery, 10) : null);

      let replayed = false;
      if (clientLastSeq !== null && !isNaN(clientLastSeq) && eventHistory.length > 0) {
        const oldestSeq = eventHistory[0].id;
        const newestSeq = eventHistory[eventHistory.length - 1].id;
        if (clientLastSeq >= oldestSeq - 1 && clientLastSeq <= newestSeq) {
          const missed = eventHistory.filter(e => e.id > clientLastSeq);
          for (const ev of missed) {
            safeSendEvent(res, ev.event, ev.data, ev.id);
          }
          replayed = true;
        }
      }

      // 3. 若非增量重放，立即推送轻量首屏快照（活跃任务 + 最近 20 个终态任务，杜绝大包冲击）
      if (!replayed) {
        const all = getAllJobs();
        const activeJobs = [];
        const terminalJobs = [];

        for (const job of all) {
          if (["running", "queued", "stopping", "retrying"].includes(job.state)) {
            activeJobs.push(job);
          } else {
            terminalJobs.push(job);
          }
        }

        // 终态任务按启动时间倒序排列，仅截取最近 20 个
        terminalJobs.sort((a, b) => new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime());
        const recentTerminal = terminalJobs.slice(0, 20);

        // 合并活跃任务与近期终态任务并按启动时间倒序
        const snapshotJobs = [...activeJobs, ...recentTerminal];
        snapshotJobs.sort((a, b) => new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime());

        const payload = snapshotJobs.map(formatJobDetail);
        safeSendEvent(res, "snapshot", {
          seq: currentSeq,
          jobs: payload,
          totalKnownJobs: all.length,
          recentTerminalLimit: 20,
        }, currentSeq);
      }

      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    // 未知路由 404
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  });

  // 每 1 秒比对增量变更并记录事件历史，若有活跃连接则广播增量或发送保活心跳
  const broadcastInterval = setInterval(() => {
    try {
      const all = getAllJobs();
      const currentMap = new Map();
      for (const job of all) {
        currentMap.set(job.jobId, job);
      }

      const createdJobs = [];
      const updatedJobs = [];
      const removedJobIds = [];

      // 1. 比对新增与变更
      for (const [jobId, job] of currentMap.entries()) {
        const fpNew = getJobFingerprint(job);
        if (!lastJobFingerprints.has(jobId)) {
          createdJobs.push(job);
          lastJobFingerprints.set(jobId, fpNew);
        } else {
          const fpOld = lastJobFingerprints.get(jobId);
          if (fpOld !== fpNew) {
            updatedJobs.push(job);
            lastJobFingerprints.set(jobId, fpNew);
          }
        }
      }

      // 2. 比对已移除任务
      for (const oldId of Array.from(lastJobFingerprints.keys())) {
        if (!currentMap.has(oldId)) {
          removedJobIds.push(oldId);
          lastJobFingerprints.delete(oldId);
        }
      }

      const hasChanges = createdJobs.length > 0 || updatedJobs.length > 0 || removedJobIds.length > 0;

      // 无变动周期：若有活跃客户端则推送轻量保活心跳（杜绝带宽浪费）
      if (!hasChanges) {
        if (sseClients.size > 0) {
          for (const client of Array.from(sseClients)) {
            safeSendRaw(client, ":keep-alive\n\n");
          }
        }
        return;
      }

      // 3. 有变动周期：生成增量事件
      const eventsToBroadcast = [];

      for (const job of createdJobs) {
        currentSeq += 1;
        eventsToBroadcast.push({
          id: currentSeq,
          event: "job_created",
          data: { seq: currentSeq, job: formatJobDetail(job) },
        });
      }

      for (const job of updatedJobs) {
        currentSeq += 1;
        eventsToBroadcast.push({
          id: currentSeq,
          event: "job_updated",
          data: { seq: currentSeq, jobId: job.jobId, patch: formatJobDetail(job) },
        });
      }

      for (const removedId of removedJobIds) {
        currentSeq += 1;
        eventsToBroadcast.push({
          id: currentSeq,
          event: "job_removed",
          data: { seq: currentSeq, jobId: removedId },
        });
      }

      // 存入环形历史缓冲区
      for (const ev of eventsToBroadcast) {
        eventHistory.push(ev);
        if (eventHistory.length > EVENT_HISTORY_MAX) {
          eventHistory.shift();
        }
      }

      // 广播给活跃客户端
      if (sseClients.size > 0) {
        for (const client of Array.from(sseClients)) {
          for (const ev of eventsToBroadcast) {
            safeSendEvent(client, ev.event, ev.data, ev.id);
          }
        }
      }
    } catch {
      // 容错保护，杜绝定时器意外退出
    }
  }, 1000);

  return new Promise((resolve, reject) => {
    let currentPort = desiredPort;
    const maxPort = desiredPort + 20;

    function tryListen() {
      server.once("error", (err) => {
        if (err.code === "EADDRINUSE" && currentPort < maxPort) {
          currentPort += 1;
          tryListen();
        } else {
          clearInterval(broadcastInterval);
          reject(err);
        }
      });

      server.listen(currentPort, "localhost", () => {
        const actualPort = server.address().port;
        const url = `http://localhost:${actualPort}`;
        if (options.autoOpen) {
          openInBrowser(url);
        }
        resolve({
          server,
          port: actualPort,
          url,
          close: () => new Promise((res) => {
            clearInterval(broadcastInterval);
            for (const client of sseClients) {
              try { client.end(); } catch {}
            }
            sseClients.clear();
            if (typeof server.closeAllConnections === "function") {
              server.closeAllConnections();
            }
            server.close(() => res());
          }),
        });
      });
    }

    tryListen();
  });
}

// 支持作为独立脚本直接执行：node src/dashboard.mjs [--open]
if (process.argv[1] === __filename) {
  const shouldAutoOpen = process.argv.includes("--open");
  startDashboardServer({ autoOpen: shouldAutoOpen }).then(({ url, port }) => {
    console.log(`
┌──────────────────────────────────────────────────────────┐
│  ⚡ Antigravity Subagent Monitor Dashboard (v${DASHBOARD_VERSION})   │
│                                                          │
│  看板访问地址:  ${url.padEnd(41)}│
│  按 Ctrl+C 可停止监控服务                                │
└──────────────────────────────────────────────────────────┘
`);
  }).catch((err) => {
    console.error("启动可视化看板失败：", err);
    process.exit(1);
  });
}
