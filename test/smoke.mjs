import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, "../src/server.mjs");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: process.env,
  stderr: "inherit",
});
const client = new Client({ name: "antigravity-bridge-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const toolNames = new Set(listed.tools.map((tool) => tool.name));
  for (const expected of [
    "delegate_to_gemini",
    "start_gemini_task",
    "get_gemini_task",
    "cancel_gemini_task",
    "antigravity_status",
  ]) {
    assert(toolNames.has(expected), `Missing MCP tool: ${expected}`);
  }

  const statusResult = await client.callTool(
    { name: "antigravity_status", arguments: {} },
    { timeout: 90_000 },
  );
  assert.equal(statusResult.isError, false, "Antigravity status check failed");
  const status = JSON.parse(statusResult.content[0].text);
  assert.equal(status.status, "READY");
  assert.equal(status.default_model, "gemini-3.8-flash-high");
  assert.equal(status.default_model_available, true);

  const marker = `ANTIGRAVITY_MCP_OK_${Date.now()}`;
  const delegated = await client.callTool(
    {
      name: "delegate_to_gemini",
      arguments: {
        prompt: `只回复：${marker}`,
        working_directory: process.cwd(),
        mode: "plan",
        timeout_seconds: 120,
      },
    },
    { timeout: 180_000 },
  );
  assert.equal(
    delegated.isError,
    false,
    `Gemini delegation failed: ${JSON.stringify(delegated.content)}`,
  );
  const payload = JSON.parse(delegated.content[0].text);
  assert.equal(payload.state, "success");
  assert.equal(payload.result.status, "SUCCESS");
  assert.match(payload.result.response, new RegExp(marker));

  const backgroundMarker = `ANTIGRAVITY_MCP_BACKGROUND_OK_${Date.now()}`;
  const started = await client.callTool(
    {
      name: "start_gemini_task",
      arguments: {
        prompt: `只回复：${backgroundMarker}`,
        working_directory: process.cwd(),
        mode: "plan",
        timeout_seconds: 120,
      },
    },
    { timeout: 30_000 },
  );
  assert.equal(started.isError, false, `Background start failed: ${JSON.stringify(started.content)}`);
  const startedPayload = JSON.parse(started.content[0].text);
  assert.equal(startedPayload.state, "running");

  let backgroundPayload;
  const pollingDeadline = Date.now() + 150_000;
  while (Date.now() < pollingDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const polled = await client.callTool(
      { name: "get_gemini_task", arguments: { job_id: startedPayload.job_id } },
      { timeout: 30_000 },
    );
    backgroundPayload = JSON.parse(polled.content[0].text);
    if (backgroundPayload.state !== "running") break;
  }
  assert.equal(backgroundPayload?.state, "success", JSON.stringify(backgroundPayload));
  assert.match(backgroundPayload.result.response, new RegExp(backgroundMarker));

  const cancelCompleted = await client.callTool(
    { name: "cancel_gemini_task", arguments: { job_id: startedPayload.job_id } },
    { timeout: 30_000 },
  );
  assert.equal(cancelCompleted.isError, false);
  assert.equal(JSON.parse(cancelCompleted.content[0].text).state, "success");

  process.stdout.write(JSON.stringify({
    ok: true,
    tools: [...toolNames],
    cli_version: status.cli_version,
    model: status.default_model,
    conversation_id: payload.result.conversation_id,
    response: payload.result.response.trim(),
    background_job_id: startedPayload.job_id,
    background_response: backgroundPayload.result.response.trim(),
  }, null, 2));
} finally {
  await client.close();
}
