import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, '../src/server.mjs');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: process.env,
  stderr: 'inherit',
});

const client = new Client({ name: 'codex-mcp-client', version: '1.0.0' });

async function main() {
  console.log('正在连接 Antigravity Subagent MCP 服务端...');
  await client.connect(transport);
  console.log('已成功建立 MCP 连接！');

  console.log('正在向会话 d79218f2-75fb-4a96-a900-14d85fb9dca3 发送批准并启动 Teamwork 多代理团队...');
  const startResult = await client.callTool({
    name: 'start_gemini_task',
    arguments: {
      prompt: '批准！需求与验收标准已完全确认。立即执行 Delegation Protocol，通过 invoke_subagent 派发 teamwork_preview 多代理系统，全力并行推进 Day01 至 Day10 全部目录的源码实现、练习题编写与编译测试！',
      conversation_id: 'd79218f2-75fb-4a96-a900-14d85fb9dca3',
      working_directory: 'd:/code/c++',
      timeout_seconds: 7200,
    },
  });

  if (startResult.isError) {
    console.error('启动失败:', JSON.stringify(startResult.content, null, 2));
    process.exit(1);
  }

  const payload = JSON.parse(startResult.content[0].text);
  const jobId = payload.job_id;
  console.log('\n======================================================');
  console.log(' Teamwork 团队已正式委派启动！');
  console.log(' Job ID: ' + jobId);
  console.log(' 初始状态: ' + payload.state);
  console.log(' 监控看板: http://localhost:3721');
  console.log('======================================================\n');

  let lastStep = -1;
  let lastAction = '';
  const printedActivities = new Set();

  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const pollResult = await client.callTool({
        name: 'get_gemini_task',
        arguments: { job_id: jobId },
      });

      if (pollResult.isError) continue;
      const info = JSON.parse(pollResult.content[0].text);
      const prog = info.progress || {};

      if (prog.current_step !== lastStep || prog.current_action !== lastAction) {
        lastStep = prog.current_step;
        lastAction = prog.current_action;
        console.log(`[${new Date().toLocaleTimeString()}] 状态: ${info.state} | 阶段: ${prog.phase} | 步数: Step ${prog.current_step} | 当前动作: [${prog.last_tool || 'none'}] ${prog.current_action}`);
      }

      if (Array.isArray(prog.subagents) && prog.subagents.length > 0) {
        for (const sa of prog.subagents) {
          const saKey = `${sa.conversation_id}_${sa.step}_${sa.current_action}`;
          if (!printedActivities.has(saKey)) {
            printedActivities.add(saKey);
            console.log(`   🚀 子代理 [${sa.role}] (Step ${sa.step}): [${sa.last_tool || 'init'}] ${sa.current_action}`);
          }
        }
      }

      if (['success', 'error', 'cancelled', 'timed_out'].includes(info.state)) {
        console.log(`\n任务已结束，最终状态: ${info.state}`);
        break;
      }
    } catch (err) {}
  }
}

main().catch((err) => {
  console.error('客户端异常退出:', err);
  process.exit(1);
});
