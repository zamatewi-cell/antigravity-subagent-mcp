# 1.0.3 验证记录

验证日期：2026-09-08。模型：`gemini-3.8-flash-high`。

## 修复范围

- 保留 CLI 最终成功结果，中途恢复的模型错误仅作为诊断警告。
- 分析完整日志后再截断展示内容，修复 Bearer/Basic 与引号包裹凭证的脱敏遗漏。
- 只有未生成子进程 PID 的临时启动错误 EAGAIN/EBUSY 可自动重试；缺失或为零的 token 统计不再触发任务重放。
- 取消、超时、输出超限、同步 MCP 请求取消和正常连接关闭时清理本任务的本地进程树。
- 显式加入任务目录，并在提示末尾附上绝对路径上下文，保留开头的斜杠命令。

## 离线验证

`node test/diagnostics.test.mjs` 与 `node test/lifecycle.test.mjs` 通过。
后者通过真实 MCP STDIO 客户端连接服务器，在测试加载器中替换 AGY，实际生成父子进程，验证：

- 最终成功不会被早先日志错误改成失败。
- 缺失 token 统计的失败只启动一次任务。
- 返回诊断没有测试凭证。
- 取消、输出超限、超时后父子进程均不再存在。
- 同步请求 AbortSignal 取消后父子进程均停止，连接仍可继续使用。
- 连接关闭后父子进程均停止。

最后一次离线记录：`D:\Temp\agy-lifecycle-UnDzkT`。

## 真实 Gemini 验证

| 测试 | 结果 | 证据 |
| --- | --- | --- |
| 普通问答 | SUCCESS，一次调用 | 返回 GEMINI_TEXT_OK |
| 单代理读取、写入、回读 | SUCCESS，一次调用 | single.txt 与预先生成的随机 input.txt 按字节一致 |
| 原生完整 Teamwork | SUCCESS，一次调用，429.49 秒 | 实际协调器、总控、两个工作代理和独立审计；输出文件内容核验通过 |

普通问答及单代理读写报告：`D:\Temp\agy-live-validation-JXDniw\validation-report.json`。
该报告中的首次 Teamwork 虽返回 SUCCESS，但输出落在错误的 scratch 目录，因此验收失败，不能算通过；修复工作目录上下文后进行了下列独立复测。

成功的完整 Teamwork 报告：`D:\Temp\agy-live-validation-UDkvFn\validation-report.json`。

- 主会话：`e489d212-fefe-4bfa-b910-96e4adb24470`
- teamwork_preview 协调器：`ca068200-050b-4f9c-bb9d-bc3d5e699cc1`
- 总控：`826a7862-64ac-4573-88e3-96e9b5c99217`
- Worker A：`e3764760-b10d-4a14-b308-83af2e396952`
- Worker B：`e0dd0f21-4a56-4016-8f68-5075d39334ba`
- 独立审计：`c0cfdde2-a11f-4fdf-b6f7-31a276e98506`

主会话 transcript 中核对到 `invoke_subagent` 的 TypeName 为 `teamwork_preview`；总控 transcript 中核对到两名 `teamwork_preview_worker` 的创建记录。没有仅凭自然语言汇报认定多代理执行。

指定目录下 `input.txt`、`team-a.txt`、`team-b.txt` 均为 36 字节，独立计算的 SHA-256 均为：

`627AF0BEB9E00559CAC63CFA45803FB429FC440008C088CA6FF8AA106CEA614F`

## 边界

- 工作目录上下文不等于系统级文件访问隔离。
- 本地进程树清理不保证取消独立托管的远程代理，也不覆盖 MCP 被强制杀死的情况。
- 未修改网络、账户或代理设置；本轮真实调用成功不代表永久解决 Google 地区校验问题。
- 任务持久化、流式进度与同目录并发队列尚未实现。
- 驻留的旧 MCP 进程需要重新加载；重启 Codex 后使用新版。
