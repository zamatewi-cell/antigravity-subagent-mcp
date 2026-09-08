# Codex Antigravity Subagent MCP

This local stdio MCP server lets Codex delegate tasks to Google Antigravity CLI (`agy`).

- Default model: `gemini-3.8-flash-high`
- User prompts and leading system slash commands are retained, with absolute
  workspace context appended for delegation.
- `/teamwork-preview <task>` is supported; include a concrete task after the command.
- Long-running calls can be started in the background and polled by job ID.
- Conversation IDs can be passed back to continue an earlier Gemini session.
- Failed runs include structured `error_details` and the exact per-job
  `diagnostic_log` path. Model backend codes such as `FAILED_PRECONDITION (400)`
  are surfaced instead of AGY's generic termination message.
- By default, permission mode is set to `auto-approve` (injecting `--dangerously-skip-permissions`)
  to prevent headless print mode from soft-denying tool confirmation. This default can be configured
  via the `ANTIGRAVITY_PERMISSION_MODE` environment variable.
- If explicit confirmation is required, caller can pass `permission_mode: "default"` or `"sandbox"`.
  When a tool needs unprompted confirmation in default mode, such empty `SUCCESS` responses
  are normalized to `TOOL_CONFIRMATION_DENIED`.

The bridge never invokes `--disable-slash-commands`. It uses AGY's required
`--print=<prompt>` form so later CLI options are not accidentally consumed as the prompt.
Per-job AGY logs are stored under `logs/` so a bridge response can be matched to
the original backend error without scanning unrelated global CLI logs.

Version 1.1.0 changes:

- **Real-time Progress & Activity Tracking**: `get_gemini_task` poll responses now include a structured `progress` object detailing the current step number, active tool call, action summary, spawned subagents list, and recent activity stream, eliminating the "blind running" limitation.
- **MCP Progress Notification Stream**: `delegate_to_gemini` pushes live progress notifications every 2 seconds when caller provides a `progressToken`.
- **Lightweight Job Persistence**: Jobs are continuously snapshot-persisted under `data/jobs/`. Server restarts automatically restore historical task records and mark uncompleted sessions as `interrupted`.
- **Multi-path AGY Detection**: Enhances Windows binary detection across common installation roots before falling back to system `PATH`.

Version 1.0.3 reliability changes:

- Final CLI success takes precedence over recovered model errors, which appear
  as `diagnostic_warning`. Full logs are searched before display truncation.
- Diagnostic output redacts Bearer/Basic credentials and quoted token fields.
  Original AGY log files remain local raw diagnostics; do not share them unredacted.
- Automatic retry is limited to temporary OS spawn errors (`EAGAIN`, `EBUSY`)
  before any child PID exists. Missing or zero token usage is not proof that no
  tools ran. Model errors, including region errors, are returned without replay.
- Cancellation, timeout and output limits terminate the spawned process tree
  on Windows using its PID. Failure to terminate is reported explicitly.
  Synchronous MCP request cancellation, disconnects and normal termination
  signals also request task cleanup.
  This does not cancel independently hosted remote agents or survive a hard crash.
- Each attempt has a unique log file. Timeout/cancellation status overrides
  partial CLI output; an abnormal process exit cannot report success.
- The task cwd is explicitly added with `--add-dir` and appended as absolute
  delegation context (keeping the leading slash command intact), so agents can
  resolve project inputs instead of substituting the default scratch workspace.
  This supplies workspace context, not a filesystem sandbox.

Offline validation: `npm run test:diagnostics` and `npm run test:lifecycle`.
Live validation (uses Gemini quota, writes only its temporary fixture workspace):
`npm run test:live`. The live report checks exact file contents; file output alone
does not prove that Teamwork launched multiple agents.
