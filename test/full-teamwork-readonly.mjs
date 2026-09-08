import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "src", "server.mjs")],
  env: process.env,
  stderr: "inherit",
});
const client = new Client({ name: "antigravity-full-teamwork-readonly", version: "1.0.0" });

try {
  await client.connect(transport);
  const result = await client.callTool(
    {
      name: "delegate_to_gemini",
      arguments: {
        prompt:
          "/teamwork-preview 这是一次只读诊断。请实际启动完整 Teamwork 流程并分配至少两个子任务：" +
          "代理 A 读取 package.json 与 README.md（若存在），代理 B 读取 src/server.mjs 并概括 MCP 工具。" +
          "禁止创建、修改或删除文件，禁止运行会改变系统或仓库状态的命令。" +
          "最终说明实际调用了哪些只读工具，并汇总各代理结论。",
        working_directory: projectRoot,
        model: "gemini-3.8-flash-high",
        mode: "plan",
        effort: "high",
        permission_mode: process.env.AGY_TEST_PERMISSION_MODE || "sandbox",
        timeout_seconds: 240,
      },
    },
    { timeout: 300_000 },
  );

  process.stdout.write(JSON.stringify({
    isError: result.isError,
    payload: JSON.parse(result.content[0].text),
  }, null, 2));
} finally {
  await client.close();
}
