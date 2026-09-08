import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-lifecycle-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", pathToFileURL(path.join(root, "test/fixture-loader.mjs")).href, path.join(root, "src/server.mjs")],
  env: { ...process.env, AGY_CLI_PATH: "offline-agy-fixture", ANTIGRAVITY_MCP_LOG_DIR: path.join(temp, "logs") },
  stderr: "inherit",
});
const client = new Client({ name: "offline-lifecycle", version: "1.0.0" });
const call = async (name, args) => {
  const response = await client.callTool({ name, arguments: args }, { timeout: 20_000 });
  return { isError: response.isError, ...JSON.parse(response.content[0].text) };
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Test condition timed out");
}
let active;
try {
  await client.connect(transport);
  const recovered = await call("delegate_to_gemini", { prompt: "recovered", working_directory: temp });
  assert.equal(recovered.state, "success");
  assert.equal(recovered.isError, false);
  const failed = await call("delegate_to_gemini", { prompt: "missing-usage", working_directory: temp });
  assert.equal(failed.attempts, 1);
  assert.equal(failed.state, "error");
  assert(!JSON.stringify(failed).includes("FAKE_SECRET_123"));
  assert.equal(fs.readFileSync(path.join(temp, "invocations.txt"), "utf8").trim().split("\n").length, 2);
  for (const mode of ["tree", "overflow", "timeout"]) {
    const pidFile = path.join(temp, "pids.json");
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    active = await call("start_gemini_task", { prompt: mode === "timeout" ? "tree" : mode, working_directory: temp, timeout_seconds: 30 });
    await until(() => fs.existsSync(pidFile));
    const pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
    if (mode === "tree") {
      const cancelled = await call("cancel_gemini_task", { job_id: active.job_id });
      assert.equal(cancelled.state, "cancelled");
      assert.equal(cancelled.result.status, "CANCELLED");
      assert.equal(cancelled.isError, false);
    } else if (mode === "overflow") {
      await until(async () => {
        const result = await call("get_gemini_task", { job_id: active.job_id });
        if (result.state !== "error") return false;
        assert.equal(result.result.error_details.code, "OUTPUT_LIMIT");
        return true;
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 35_500));
      await until(async () => {
        const result = await call("get_gemini_task", { job_id: active.job_id });
        if (result.state === "stopping") return false;
        assert.equal(result.state, "timed_out");
        assert.equal(result.result.status, "TIMEOUT");
        assert.equal(result.result.error_details.code, "TIMED_OUT");
        return true;
      });
    }
    await until(() => pids.every((pid) => !alive(pid)));
    active = null;
  }
  const abortDir = path.join(temp, "abort");
  fs.mkdirSync(abortDir);
  const abortController = new AbortController();
  const pending = client.callTool({ name: "delegate_to_gemini", arguments: { prompt: "tree", working_directory: abortDir } },
    { signal: abortController.signal, timeout: 20_000 }).catch((error) => error);
  const abortPidFile = path.join(abortDir, "pids.json");
  await until(() => fs.existsSync(abortPidFile));
  const abortPids = JSON.parse(fs.readFileSync(abortPidFile, "utf8"));
  abortController.abort();
  assert(await pending instanceof Error);
  await until(() => abortPids.every((pid) => !alive(pid)));
  const disconnectDir = path.join(temp, "disconnect");
  fs.mkdirSync(disconnectDir);
  active = await call("start_gemini_task", { prompt: "tree", working_directory: disconnectDir });
  const disconnectPids = path.join(disconnectDir, "pids.json");
  await until(() => fs.existsSync(disconnectPids));
  const pids = JSON.parse(fs.readFileSync(disconnectPids, "utf8"));
  await client.close();
  await until(() => pids.every((pid) => !alive(pid)));
  active = null;
  console.log("Offline MCP integration passed: recovery, no duplicate retry, redaction, cancel tree, output-limit tree, timeout tree, request abort, disconnect cleanup.");
} finally {
  if (active) await call("cancel_gemini_task", { job_id: active.job_id }).catch(() => {});
  await client.close();
  // Keep this isolated fixture directory for inspection if a test fails.
  console.log(`Fixture artifacts: ${temp}`);
}
