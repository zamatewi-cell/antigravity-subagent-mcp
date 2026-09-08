import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { restorePersistedJobs, persistJob } from "./storage.mjs";
import { getTaskProgress } from "./progress.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_ROOT = path.resolve(__dirname, "web");
const HTML_FILE = path.join(WEB_ROOT, "index.html");

const DEFAULT_PORT = Number(process.env.ANTIGRAVITY_DASHBOARD_PORT) || 3721;
const DASHBOARD_VERSION = "1.3.0";

/**
 * 格式化输出提供给前端看板的任务视图对象
 * @param {object} job 
 * @returns {object}
 */
export function formatJobDetail(job) {
  if (!job) return null;
  const progress = getTaskProgress(job);

  // 尝试读取物理日志尾部（若有）
  let logTail = "";
  const logFile = job.invocation?.log_file;
  if (logFile && fs.existsSync(logFile)) {
    try {
      const stats = fs.statSync(logFile);
      const readBytes = Math.min(stats.size, 16 * 1024);
      const buffer = Buffer.alloc(readBytes);
      const fd = fs.openSync(logFile, "r");
      fs.readSync(fd, buffer, 0, readBytes, Math.max(0, stats.size - readBytes));
      fs.closeSync(fd);
      logTail = buffer.toString("utf8");
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
      prompt: job.invocation?.prompt || "",
      cwd: job.invocation?.cwd || "",
      model: job.invocation?.model || "",
      slash_command: job.invocation?.slash_command || null,
      timeout_seconds: job.invocation?.timeout_seconds || 300,
      log_file: job.invocation?.log_file || null,
    },
    attempts: job.attempts || 1,
    result: job.result || null,
    progress: {
      phase: progress.phase,
      current_step: progress.current_step,
      current_action: progress.current_action,
      last_tool: progress.last_tool,
      conversation_id: progress.conversation_id,
      subagents: progress.subagents || [],
      recent_activities: progress.recent_activities || [],
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

  function getAllJobs() {
    if (memoryJobs) {
      return Array.from(memoryJobs.values());
    }
    const diskJobs = restorePersistedJobs();
    return Array.from(diskJobs.values());
  }

  function getJobById(id) {
    if (memoryJobs && memoryJobs.has(id)) {
      return memoryJobs.get(id);
    }
    const diskJobs = restorePersistedJobs();
    return diskJobs.get(id) || null;
  }

  const server = http.createServer((req, res) => {
    // 跨域支持与预检
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
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

    // 3. 所有任务列表 API
    if (pathname === "/api/jobs") {
      const all = getAllJobs();
      // 按开始时间降序排序
      all.sort((a, b) => new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime());
      const payload = all.map(formatJobDetail);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
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

      job.cancelRequested = true;
      if (job.state === "queued" || job.state === "retrying") {
        job.state = "cancelled";
        job.completedAt = new Date().toISOString();
        persistJob(job);
      } else if (job.state === "running") {
        job.state = "cancelled";
        job.completedAt = new Date().toISOString();
        if (job.child && !job.child.killed) {
          try {
            job.child.kill("SIGTERM");
          } catch {}
        }
        persistJob(job);
      }

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ status: "SUCCESS", message: `任务 ${jobId} 已请求取消`, job: formatJobDetail(job) }));
      return;
    }

    // 6. SSE 实时事件流
    if (pathname === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write("event: connected\ndata: {}\n\n");
      sseClients.add(res);

      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    // 未知路由 404
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  });

  // 每 1 秒向所有活跃的 SSE 连接广播当前任务快照
  const broadcastInterval = setInterval(() => {
    if (sseClients.size === 0) return;
    try {
      const all = getAllJobs();
      all.sort((a, b) => new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime());
      const payload = all.map(formatJobDetail);
      const dataStr = `event: snapshot\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const client of sseClients) {
        try {
          client.write(dataStr);
        } catch {
          sseClients.delete(client);
        }
      }
    } catch {}
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
