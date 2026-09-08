import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-live-validation-"));
const marker = randomUUID();
fs.writeFileSync(path.join(workspace, "input.txt"), marker, "utf8");
const transport = new StdioClientTransport({ command: process.execPath,
  args: [path.join(root, "src/server.mjs")], env: process.env, stderr: "inherit" });
const client = new Client({ name: "live-validation", version: "1.0.0" });
const report = [];
const cases = [
  { name: "text", prompt: "Do not use tools. Reply exactly GEMINI_TEXT_OK." },
  { name: "read-write", files: ["single.txt"], prompt: "Read input.txt in the current directory using a file tool, then create single.txt containing exactly the same content. Read single.txt back to verify it. Only access files in this test directory. Do not delegate. Finally report the result." },
  { name: "teamwork", files: ["team-a.txt", "team-b.txt"], prompt: "/teamwork-preview This is an authorized isolated end-to-end test. Execute the full native teamwork workflow, including invoke_subagent with TypeName teamwork_preview; do not substitute direct self-agent calls for the teamwork_preview coordinator. Delegate this concrete task: two workers A and B read the existing input.txt and write its exact content to team-a.txt and team-b.txt respectively. Wait for completion, read both output files and report actual subagent identifiers. Use the absolute task working directory provided below for all three files and propagate it to the coordinator and workers. Do not invent input data or use scratch as the project directory. No extra implementation or git operations. The plan is approved for this tiny task; do not stop after merely describing a plan." },
];
try {
  await client.connect(transport);
  console.log(`Live fixture: ${workspace}`);
  for (const test of cases) {
    const selection = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7);
    if (selection && test.name !== selection) continue;
    console.log(`Starting ${test.name}`);
    const result = await client.callTool({ name: "delegate_to_gemini", arguments: {
      prompt: test.prompt, working_directory: workspace, model: "gemini-3.8-flash-high",
      mode: "accept-edits", permission_mode: "auto-approve", timeout_seconds: test.name === "teamwork" ? 600 : 180,
    } }, { timeout: test.name === "teamwork" ? 630_000 : 200_000 });
    const payload = JSON.parse(result.content[0].text);
    const row = { test: test.name, state: payload.state, attempts: payload.attempts,
      conversation_id: payload.result?.conversation_id,
      duration_seconds: payload.result?.duration_seconds,
      response: payload.result?.response?.slice(0, 2500),
      error: payload.result?.error, error_details: payload.result?.error_details,
      log: payload.diagnostic_log,
      verified_files: (test.files || []).map((file) => ({ file,
        exact_match: fs.existsSync(path.join(workspace, file)) && fs.readFileSync(path.join(workspace, file), "utf8") === marker })),
    };
    if (test.name === "teamwork") {
      row.native_teamwork_invoked = false;
      const id = payload.result?.conversation_id;
      if (/^[0-9a-f-]{36}$/i.test(id || "")) {
        const transcript = path.join(os.homedir(), ".gemini/antigravity-cli/brain", id, ".system_generated/logs/transcript.jsonl");
        if (fs.existsSync(transcript)) {
          for (const line of fs.readFileSync(transcript, "utf8").split(/\r?\n/).filter(Boolean)) {
            try {
              const step = JSON.parse(line);
              for (const tool of step.tool_calls || []) {
                if (tool.name !== "invoke_subagent") continue;
                const agents = typeof tool.args?.Subagents === "string" ? JSON.parse(tool.args.Subagents) : tool.args?.Subagents;
                if (agents?.some((agent) => agent.TypeName === "teamwork_preview")) row.native_teamwork_invoked = true;
              }
            } catch { /* Missing/truncated tool records do not establish execution. */ }
          }
        }
      }
    }
    row.acceptance_passed = row.state === "success" &&
      (test.name !== "text" || row.response?.trim() === "GEMINI_TEXT_OK") &&
      row.verified_files.every((file) => file.exact_match) &&
      (test.name !== "teamwork" || row.native_teamwork_invoked);
    if (!row.acceptance_passed) process.exitCode = 1;
    report.push(row);
    console.log(JSON.stringify(row));
    fs.writeFileSync(path.join(workspace, "validation-report.json"), JSON.stringify(report, null, 2));
  }
} finally { await client.close(); }
