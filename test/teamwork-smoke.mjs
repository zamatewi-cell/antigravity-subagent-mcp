import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve(here, "../src/server.mjs")],
  env: process.env,
  stderr: "inherit",
});
const client = new Client({ name: "antigravity-teamwork-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const result = await client.callTool(
    {
      name: "delegate_to_gemini",
      arguments: {
        prompt:
          "/teamwork-preview 这是 MCP 斜杠指令透传测试：不要创建或修改文件，只用一句话确认已识别并进入 Teamwork 流程。",
        working_directory: process.cwd(),
        mode: "plan",
        timeout_seconds: 120,
      },
    },
    { timeout: 180_000 },
  );
  assert.equal(result.isError, false, `Teamwork call failed: ${JSON.stringify(result.content)}`);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.state, "success");
  assert.equal(payload.slash_command, "/teamwork-preview");
  assert.equal(payload.result.status, "SUCCESS");
  assert.match(payload.result.response, /Teamwork/i);
  process.stdout.write(JSON.stringify({
    ok: true,
    slash_command: payload.slash_command,
    model: payload.model,
    conversation_id: payload.result.conversation_id,
    response: payload.result.response.trim(),
  }, null, 2));
} finally {
  await client.close();
}
