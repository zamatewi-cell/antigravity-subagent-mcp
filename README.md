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

Version 1.4.0 changes:

- **Historical Jobs Pagination & Multidimensional Filtering (R1)**:
  - Added query parameter parsing to `GET /api/jobs` supporting `page` (default: 1), `limit` (default: 20, clamped to 1-100), `state` exact filtering, and `search` substring search matching prompt and job ID.
  - Standardized paginated response structure `{ data: Job[], pagination: { total, page, limit, totalPages, hasMore } }` with transparent backward-compatibility for unparameterized requests.
  - Slices memory/LRU indices prior to `formatJobDetail` to eliminate redundant formatting, log tail reading, and transcript serialization for off-screen historical jobs.
- **Single-Job Replacement SSE Event Streaming & Lightweight Snapshots (R2)**:
  - Re-architected `GET /api/stream` to dispatch initial lightweight `snapshot` (all active jobs + recent 20 terminal jobs, offloading deep history to REST pagination) with incrementing cursor `seq`.
  - Upgraded differential change detection from full-list broadcast to single-job entity replacement (`job_created`, `job_updated`, `job_removed`), sending lightweight `:keep-alive` comments during idle intervals.
  - Hardened `getJobFingerprint` to deeply serialize subagent status, step, current action, last tool, and topology tree, ensuring subagent-only micro-activities immediately trigger live streaming updates.
  - Implemented client-side memory dictionary (`jobsById`) with surgical DOM patching in `index.html`, eliminating layout thrashing and focus drops from full-page `innerHTML` rebuilds.
- **Native Zero-Dependency SVG Agent DAG Topology (R3)**:
  - Augmented recursive agent tree assembly with directional topological metadata (`parentId`, `depth`, `childrenIds`, `nodeType`).
  - Rendered compact hierarchical DAG visualizer using a dual-layer architecture: underlying SVG cubic Bézier flowing wires with pure CSS hardware-accelerated neon breathing keyframes (`wireFlow`, `wireBreath`), and top-layer absolute HTML interactive cards.
- **Experimental Human-in-the-loop (HITL) Soft Intervention Pipeline (R4)**:
  - Configured child process spawn with `stdio: ["pipe", "pipe", "pipe"]` as an experimental bidirectional stream channel designed for stream protocol interactions (`--input-format stream-json`).
  - Implemented asynchronous `sendInputToJob` with physical write confirmation callbacks, newline auto-completion, and robust EPIPE / pipe-destruction crash guards.
  - Exposed local-origin/Host protected `POST /api/jobs/:id/interact` endpoint with 64 KiB request body truncation (HTTP 413 Payload Too Large) and integrated web console shortcuts (`[Y]`, `[N]`, `[Enter]`).

Version 1.3.3 changes:

- **Two-Tier Parser Architecture & Decoupled Concurrency Locking**:
  - **Dynamic Subagent State Penetration**: Refactored transcript parsing into a two-tier pipeline. Low-level `parseLocalTranscript` caches static, single-file syntax parsing with true LRU eviction, while high-level `parseTranscript` dynamically composes the live Agent Tree. Eliminates subagent state freezing where worker updates were shadowed by parent file caches, and enables instant child convergence upon parent cancellation.
  - **Decoupled Directory Lock Module**: Extracted `withDirectoryLock` into standalone module `src/directory-lock.mjs`, entirely removing MCP bootstrap and server runtime side-effects from testing imports.
  - **Memory & Cache Bounding**: Upgraded caches to true LRU eviction and instituted a 500-entry bounding cap on `diskJobsCache` in `storage.mjs`.
  - **CI & Testing Suite Expansion**: Configured multi-OS GitHub Actions workflow (`.github/workflows/ci.yml`) and introduced `npm run test:offline` aggregating all offline unit and integration tests.

Version 1.3.2 changes:

- **Strict Lifecycle & State Machine Hardening**:
  - **Readonly Standalone Monitor**: Standalone Dashboard processes (`npm run dashboard` without in-memory `jobs` map) strictly reject cancellation requests for any job lifecycle state (`queued`, `retrying`, `running`), returning HTTP 409 Conflict (`STANDALONE_CANCEL_FORBIDDEN`) to prevent disk state corruption and phantom cancellations.
  - **Subagent Status Priority Realignment**: Explicitly terminated (`killed`) subagents strictly retain `killed` status and can never be overwritten by parent task `success` or subsequent completion claims. When parent tasks fail or cancel, non-terminated subagents converge synchronously.
  - **CSRF & DNS Rebinding Protection**: Enforced strict `Host` header whitelisting (`localhost`, `127.0.0.1`) and rejected cross-origin `POST` requests from unauthorized external origins with HTTP 403 Forbidden.
  - **I/O & Memory Optimization**: Added `mtimeMs` / file `size` caching for `fallbackFromLog` and enforced LRU eviction caps (200 entries) on both `transcriptCache` and `logFallbackCache`.
  - **Configuration Parity & Verified Lock Testing**: Synchronized custom data directory configurations across all modules and replaced mock test locks with direct unit testing of exported production `withDirectoryLock`.

Version 1.3.1 changes:

- **Robust Security & Concurrency Hardening**:
  - Eliminated DOM-based XSS vulnerabilities across the Web Dashboard via HTML entity escaping.
  - Tightened CORS headers, added physical log tail sanitization, and safeguarded earliest termination reasons against state drift.
  - Introduced atomic persistence and mtime-based transcript caching.

Version 1.3.0 changes:

- **Standalone Real-time Visual Monitor Dashboard**: Built an elegant, dark cyberpunk-themed Web dashboard (`src/web/index.html`) using zero external dependencies (pure native Node.js `http` and HTML5/CSS3/ES6).
  - **God's-eye View Grid**: Renders individual subagent cards for all Teamwork roles (Orchestrator, Workers, Auditor) with live pulse status indicators, step counters, and highlighted active tool tags (`[run_command]`, `[write_to_file]`).
  - **Micro-Activity Timeline**: Clicking any agent card seamlessly reveals its deep, step-by-step activity stream (`recent_activities`), demystifying internal execution.
  - **Zero-Polling SSE Push**: Uses Server-Sent Events (`/api/stream`) for sub-second, live real-time state streaming directly to browsers.
  - **One-Click Controls & Log Streaming**: Supports remote one-click cancellation for running/queued tasks and live diagnostic log tails.
- **New MCP Tool `open_dashboard`**: Codex can directly trigger `open_dashboard` to automatically pop up the monitor dashboard in the user's default browser (`http://localhost:3721`).
- **Standalone CLI & Concurrent Integration**: Launchable independently via `npm run dashboard` (`node src/dashboard.mjs [--open]`) or concurrently with MCP when `ANTIGRAVITY_ENABLE_DASHBOARD=1`.

Version 1.2.2 changes:

- **Complete Negation & In-progress Defense**: Hardened `evaluateSubagentStatus` to eliminate completion false-positives. Replaced isolated keyword matching (e.g. standalone `handoff.md` or `VICTORY`) with strict affirmation patterns. Messages containing negative or in-progress modifiers (e.g. "尚未生成，继续修复", "No VICTORY yet; still working") are categorically barred from being marked `completed`.
- **Comprehensive Multi-tool Step Scanning**: Inspects the entirety of `lastEntry.tool_calls` rather than solely the first element. Any step containing active filesystem/terminal tools alongside `send_message` strictly remains `running`.
- **Queued Task Cancellation**: `cancel_gemini_task` now supports immediately canceling `queued` tasks awaiting directory concurrency locks, transitioning their state directly to `cancelled` and short-circuiting execution when the lock becomes free.
- **Restart Convergence for Queued Jobs**: `restorePersistedJobs` now converges orphaned `queued` jobs into `interrupted` upon server reboot, completely preventing zombie waiting states.
- **Handshake Version Parity**: Synchronized server handshake version to `1.2.2`.

Version 1.2.1 changes:

- **Strict Evidence-Based Lifecycle Evaluation**: Completely eliminated heuristic step count thresholds (e.g. step >= 30) and naive tool-name assumptions. Agents performing active tools (commands, edits) or asking questions remain strictly `running`; only explicit completion evidence (finished handoffs/verdicts or parent kills) marks `completed`. Inconclusive evidence defaults to `running`/`unknown`.
- **Working MCP Progress Notification Stream**: Fixed progress notification delivery by resolving `progressToken` from both `_meta` and `params._meta`, and invoking SDK-standard `ctx.mcpReq.notify` rather than unreachable methods.
- **Accurate Action Tracking & Stale Text Invalidation**: Tool activities now prioritize detailed parameters from `tc.args` (e.g. `toolSummary`, command lines, filenames) over bare tool names. Consecutive tool executions reliably invalidate and overwrite prior text reflections in `current_action`.
- **Deep Hierarchy Traversal (Depth >= 8)**: Expanded subagent cascade recursion depth to 8 with generalized conversation ID resolution and cycle protection, preventing truncation on 5+ tier agent chains.
- **Atomic Persistence & Consistent Restart State**: Jobs are written atomically via temporary files (`.tmp` -> rename) with automated quarantine for corrupted JSON records. Interrupted tasks post-restart consistently report `state: interrupted`, `isError: true`, and `progress.phase: interrupted`.
- **Directory Concurrency Lock**: Added asynchronous per-workspace serialization lock to prevent conflicting concurrent Antigravity executions in the same working directory.
- **Handshake Version Parity**: Synchronized server handshake version to `1.2.1`.

Version 1.2.0 changes:

- **Deep Cascade Subagent Inspection (God's-eye View)**: Recursively penetrates and parses independent subagent conversation transcripts for all spawned Workers (e.g. Worker A, Worker B, Victory Auditor). Exposes fine-grained execution steps (`step`), live micro-actions (`current_action`), active tools (`last_tool`), lifecycle statuses, and individual activity trails directly in the `subagents` list.
- **Robust Subagent Parsing & Full-transcript Affinity**: Automatically prefers un-truncated `transcript_full.jsonl` and adds tolerant parser fallbacks for models producing raw unescaped newlines within JSON string arguments.

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

Offline validation (aggregates all 10 unit and integration test suites):
`npm run test:offline`

Individual test suites:
- R1 Historical Jobs Pagination & Filtering: `node test/pagination.test.mjs`
- R2 Fine-Grained SSE Delta Events: `node test/sse-delta.test.mjs`
- R3 Native SVG Agent DAG Topology: `node test/dag-topology.test.mjs`
- R4 Human-in-the-loop Soft Intervention: `node test/hitl.test.mjs`
- Lifecycle & Process Control: `node test/lifecycle.test.mjs`
- Cancel Consistency & Lifecycle Guard: `node test/cancel-consistency.test.mjs`
- Counterexamples & Defense in Depth: `node test/counterexamples.test.mjs`
- Dashboard API & Web UI: `node test/dashboard.test.mjs`
- Progress Parsing & Hierarchy: `node test/progress.test.mjs`
- Structured Diagnostics: `node test/diagnostics.test.mjs`

Live validation (uses Gemini quota, writes only its temporary fixture workspace):
`npm run test:live`. The live report checks exact file contents; file output alone
does not prove that Teamwork launched multiple agents.
