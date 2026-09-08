import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const logPath = args[args.indexOf("--log-file") + 1];
const fullPrompt = args.find((arg) => arg.startsWith("--print="))?.slice(8);
const mode = fullPrompt?.split("\n", 1)[0];
if (args[args.indexOf("--add-dir") + 1] !== process.cwd() || !fullPrompt.includes(JSON.stringify(process.cwd()))) {
  throw new Error("The bridge did not pass the explicit workspace to AGY");
}
fs.appendFileSync(path.join(process.cwd(), "invocations.txt"), `${mode}\n`);
const modelError = 'calling model: UNAVAILABLE (code 503): temporary backend error';
if (mode === "tree" || mode === "overflow") {
  const descendant = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore", windowsHide: true,
  });
  fs.writeFileSync(path.join(process.cwd(), "pids.json"), JSON.stringify([process.pid, descendant.pid]));
  if (mode === "overflow") process.stdout.write("x".repeat(17 * 1024 * 1024));
  setInterval(() => {}, 1000);
} else {
  fs.writeFileSync(logPath, modelError);
  const result = mode === "recovered"
    ? { status: "SUCCESS", response: "completed", usage: { total_tokens: 12 } }
    : { status: "ERROR", response: "", error: "authorization: Bearer FAKE_SECRET_123" };
  process.stdout.write(JSON.stringify(result));
  process.exitCode = result.status === "SUCCESS" ? 0 : 1;
}
