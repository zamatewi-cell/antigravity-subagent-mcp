import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const mcpRoot = "C:/Users/zrx-pc/.codex/mcp/antigravity-subagent";
const serverPath = path.resolve(mcpRoot, "src/server.mjs");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: process.env,
  stderr: "inherit",
});

const client = new Client({ name: "codex-mcp-client", version: "1.0.0" });

const prompt = `/teamwork-preview HyperServer 嵌入式 IoT 高性能音视频/物联网服务器 10 天课程实战落地。在当前目录 d:/code/c++ 下创建 day01 到 day10 文件夹，逐天实现核心架构模块与全部练习代码，配备完备的编译验证机制，并在本地看板（http://localhost:3721）实时呈现全员子代理微观推进。

Working directory: d:/code/c++
Integrity mode: development

## Requirements

### R1. 目录规范与渐进式模块实现 (Day01 - Day10)
在 d:/code/c++ 下创建 day01 至 day10 独立目录，逐天完成课程大纲要求的核心类与实战代码：
- day01: C++ 语法基础、命名空间隔离、6 级流式日志系统 (Logger) 与日志格式化输出。
- day02: 面向对象封装、InetAddress 与 Socket 类设计（拷贝控制 = delete 与 RAII）。
- day03: RAII 资源管理、FileGuard 文件句柄卫士、ServerConfig 线程安全单例、TcpConnection 基础连接生命周期。
- day04: 二进制协议分层、Packet 多态基类与 9 字节定长报头、LeaveRoomPacket 序列化与反序列化。
- day05: 多态与 Reactor 核心、IEventHandler 纯虚接口、Acceptor 监听分发与 EventLoop 事件循环。
- day06: 流式动态缓冲区 DataBuffer（双指针读写追踪、原地 shrink 内存整理、operator<< 运算符重载）。
- day07: 健壮性异常体系、ServerException 基类与 SocketException/RoomException/ParseException 派生类、dynamic_cast 安全转换。
- day08: 模板与现代智能指针、Session 会话管理（shared_ptr/weak_ptr 循环引用防护）、SafeQueue<T> 线程安全模板队列。
- day09: STL 容器选型与房间管理、Room 会议室模型与 RoomManager 调度管理器（高效查找与广播）。
- day10: C++11 移动语义 (std::move)、Lambda 定时器回调 (run_after)、UDP 音视频数据报低延迟中转与双通道终极联调。

### R2. 课后练习与实战代码全部闭环
在每天的目录下除了核心模块外，必须编写对应的练习题代码及验证用例，确保每个练习都有直接可运行的 main.cpp。

### R3. 构建与编译验证机制
每一天目录均配备简洁独立的编译验证配置（如单个编译命令脚本 build.ps1/Makefile），支持使用当前环境下的 MinGW g++ 编译器（Windows 环境链接 -lws2_32）进行无警告编译并直接执行测试输出。

## Acceptance Criteria
- [ ] d:/code/c++ 下存在 day01 到 day10 全部 10 个独立文件夹。
- [ ] 每一天目录均包含完整的核心模块头文件 (.h/.hpp)、实现文件 (.cpp) 以及练习题代码。
- [ ] 每一天目录均包含一份 README.md，对当天的知识点、架构考量和练习题解法进行系统性中文讲解。
- [ ] 每一天的代码均符合现代 C++ (C++11/14/17) 规范，不使用过时的裸指针管理动态资源。
- [ ] 每一天的练习题均配备可运行的测试程序，使用 g++ 编译执行无警告、无死锁、退出码为 0。`;

async function main() {
  console.log("正在连接 Antigravity Subagent MCP 服务端...");
  await client.connect(transport);
  console.log("已成功建立 MCP 连接！");

  console.log("正在调用 MCP 工具 start_gemini_task 发起 Teamwork 任务...");
  const startResult = await client.callTool({
    name: "start_gemini_task",
    arguments: {
      prompt,
      working_directory: "d:/code/c++",
      timeout_seconds: 7200,
    },
  });

  if (startResult.isError) {
    console.error("启动失败:", JSON.stringify(startResult.content, null, 2));
    process.exit(1);
  }

  const payload = JSON.parse(startResult.content[0].text);
  const jobId = payload.job_id;
  console.log(`\n======================================================`);
  console.log(` MCP 任务启动成功！`);
  console.log(` Job ID: ${jobId}`);
  console.log(` 初始状态: ${payload.state}`);
  console.log(` 工作目录: ${payload.working_directory}`);
  console.log(` 监控看板: http://localhost:3721`);
  console.log(`======================================================\n`);

  let lastStep = -1;
  let lastAction = "";
  const printedActivities = new Set();

  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const pollResult = await client.callTool({
        name: "get_gemini_task",
        arguments: { job_id: jobId },
      });

      if (pollResult.isError) {
        console.error("查询任务出错:", pollResult.content);
        continue;
      }

      const info = JSON.parse(pollResult.content[0].text);
      const prog = info.progress || {};

      if (prog.current_step !== lastStep || prog.current_action !== lastAction) {
        lastStep = prog.current_step;
        lastAction = prog.current_action;
        console.log(`[${new Date().toLocaleTimeString()}] 状态: ${info.state} | 阶段: ${prog.phase} | 步数: Step ${prog.current_step} | 当前动作: [${prog.last_tool || 'none'}] ${prog.current_action}`);
      }

      if (Array.isArray(prog.recent_activities)) {
        for (const act of prog.recent_activities) {
          if (!printedActivities.has(act)) {
            printedActivities.add(act);
            console.log(`   活动流水 -> ${act}`);
          }
        }
      }

      if (Array.isArray(prog.subagents) && prog.subagents.length > 0) {
        for (const sa of prog.subagents) {
          const saKey = `${sa.conversation_id}_${sa.step}`;
          if (!printedActivities.has(saKey)) {
            printedActivities.add(saKey);
            console.log(`   子代理 [${sa.role}] (Step ${sa.step}): [${sa.last_tool || 'init'}] ${sa.current_action}`);
          }
        }
      }

      if (info.state === "success" || info.state === "error" || info.state === "cancelled" || info.state === "timed_out") {
        console.log(`\n任务已结束，最终状态: ${info.state}`);
        if (info.result) {
          console.log("执行结果:", JSON.stringify(info.result, null, 2));
        }
        break;
      }
    } catch (err) {
      console.error("轮询异常:", err.message);
    }
  }
}

main().catch((err) => {
  console.error("客户端异常退出:", err);
  process.exit(1);
});
